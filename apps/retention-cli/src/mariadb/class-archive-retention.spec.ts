import type { DB } from "@classhub/db";
import {
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type QueryResult,
  type DatabaseConnection,
} from "kysely";
import { describe, expect, it } from "vitest";
import {
  classArchiveDeletionOrder,
  runMariaDbClassArchiveRetention,
} from "./class-archive-retention.js";
import { classArchiveSchemaContract } from "./class-archive-schema-contract.js";
import { classArchiveInstallationContract } from "./class-archive-installation-contract.js";

// This exercises the real orchestration with synthetic driver replies. It does not
// prove MariaDB date comparison, physical erasure, concurrency, or dump restoration.
const started = "2026-10-10 12:34:56.123456";
const cutoff = "2025-10-10 12:34:56.123456";
const legacy = new Set([
  "seat_draw_assignments",
  "seat_draw_slots",
  "seat_draws",
  "team_draw_assignments",
  "team_draw_groups",
  "team_draws",
  "duty_assignments",
  "duty_rosters",
  "class_duty_roles",
  "layout_draft_autosaves",
  "classroom_layout_templates",
]);
const children = classArchiveDeletionOrder.filter((name) => !legacy.has(name));
function harness(
  options: {
    locked?: boolean;
    failure?: string;
    shellAffected?: bigint;
    drift?: "ledger" | "column" | "foreign-fk";
  } = {},
) {
  const calls: CompiledQuery[] = [],
    events: string[] = [];
  const tables = ["classes", "audit_logs", "security_audit_logs", ...children];
  const references: Record<string, string>[] = classArchiveSchemaContract.references
    .filter((row) => tables.includes(row.table_name))
    .map((row) => ({ table_schema: "synthetic_active98", ...row }));
  if (options.drift === "foreign-fk")
    references.push({
      ...references[0]!,
      table_schema: "foreign_schema",
      referenced_table: "classes",
    });
  let eligibleReads = 0;
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      calls.push(query);
      const text = query.sql.replace(/\s+/g, " ").trim();
      if (options.failure && text.startsWith(`DELETE FROM \`${options.failure}\``))
        throw new Error("synthetic child failure");
      let rows: unknown[] = [];
      let numAffectedRows: bigint | undefined;
      if (text.includes("AS started_at")) rows = [{ started_at: started, cutoff_at: cutoff }];
      else if (text.startsWith("CALL"))
        rows = [
          [
            {
              database_name: "synthetic_active98",
              tables_json: JSON.stringify(tables),
              references_json: JSON.stringify(references),
              installation_json: JSON.stringify(
                classArchiveInstallationContract
                  .filter((row) => row.version !== 113)
                  .map((row) => ({
                    ...row,
                    ...(options.drift === "ledger" ? { sha256: "0".repeat(64) } : {}),
                  })),
              ),
            },
          ],
        ];
      else if (text.includes("information_schema.COLUMNS"))
        rows =
          options.drift === "column"
            ? [
                ...classArchiveSchemaContract.classColumns,
                { name: "private_extra", type: "text", nullable: "YES", extra: "" },
              ]
            : [...classArchiveSchemaContract.classColumns];
      else if (text.startsWith("SHOW CREATE"))
        rows = [{ "Create Table": classArchiveSchemaContract.classDefinition }];
      else if (text.includes("FROM classes WHERE") && text.includes("COUNT"))
        rows = [{ count: String(eligibleReads++ === 0 ? 1 : 0) }];
      else if (text.includes("class_id IS NULL")) rows = [{ count: "2" }];
      else if (text.startsWith("SELECT CAST(id")) rows = [{ id: "41" }];
      else if (text.includes("FOR UPDATE")) rows = options.locked === false ? [] : [{ id: "41" }];
      else if (text.startsWith("SELECT")) rows = [{ count: "1" }];
      else numAffectedRows = text.startsWith("UPDATE classes") ? (options.shellAffected ?? 1n) : 1n;
      return {
        rows,
        ...(numAffectedRows === undefined ? {} : { numAffectedRows }),
      } as QueryResult<R>;
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("unused");
    },
  };
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
      createDriver: () => ({
        async init() {},
        async destroy() {},
        async acquireConnection() {
          return connection;
        },
        async releaseConnection() {},
        async beginTransaction() {
          events.push("BEGIN");
        },
        async commitTransaction() {
          events.push("COMMIT");
        },
        async rollbackTransaction() {
          events.push("ROLLBACK");
        },
      }),
    },
  });
  return { database, calls, events };
}
const writes = (calls: CompiledQuery[]) =>
  calls.filter((q) => /^\s*(DELETE|UPDATE|INSERT)/.test(q.sql));
describe("active class archive orchestration with synthetic metadata", () => {
  it("dry-run counts all 30 active children and preserves the original six-digit cutoff without writes", async () => {
    const h = harness();
    const result = await runMariaDbClassArchiveRetention(h.database, { mode: "dry-run" });
    expect(children).toHaveLength(30);
    expect(Object.keys(result.table_counts)).toEqual(children);
    expect(result.unlinked_assessment_count).toBe(2);
    expect(writes(h.calls)).toEqual([]);
    expect(h.events).toEqual([]);
    expect(
      h.calls
        .filter((q) => q.sql.includes("archived_at<="))
        .every((q) => q.parameters.includes(cutoff)),
    ).toBe(true);
  });
  it("executes scoped child deletion and a minimal anonymous shell update, never deleting classes or unlinked assessments", async () => {
    const h = harness();
    const result = await runMariaDbClassArchiveRetention(h.database, { mode: "execute" });
    const deletions = h.calls.filter((q) => /^DELETE/.test(q.sql));
    expect(deletions.map((q) => q.sql.match(/DELETE FROM `([^`]+)`/)?.[1])).toEqual(children);
    expect(deletions.every((q) => q.parameters.length === 1 && q.parameters[0] === "41")).toBe(
      true,
    );
    const assessment = deletions.find((q) => q.sql.includes("student_assessment_records"))!;
    expect(assessment.sql).toContain("class_id=");
    const shell = h.calls.find((q) => q.sql.startsWith("UPDATE classes"))!;
    expect(shell.sql).toContain("name='종료된 반'");
    expect(shell.sql).toContain("created_by_user_id=NULL");
    expect(shell.sql).not.toContain("archived_at=");
    expect(shell.parameters).toEqual([started, started, "41", cutoff]);
    expect(h.calls.some((q) => /^DELETE FROM [`]?classes/.test(q.sql))).toBe(false);
    expect(h.events).toEqual(["BEGIN", "COMMIT"]);
    expect(result.purged_class_count).toBe(1);
  });
  it("does no mutation if the transaction-owned eligibility recheck loses the race", async () => {
    const h = harness({ locked: false });
    const result = await runMariaDbClassArchiveRetention(h.database, { mode: "execute" });
    expect(writes(h.calls)).toEqual([]);
    expect(result.purged_class_count).toBe(0);
  });
  it.each(["ledger", "column", "foreign-fk"] as const)(
    "rejects %s contract drift before mutation",
    async (drift) => {
      const h = harness({ drift });
      await expect(
        runMariaDbClassArchiveRetention(h.database, { mode: "execute" }),
      ).rejects.toThrow();
      expect(writes(h.calls)).toEqual([]);
      expect(h.events).toEqual([]);
    },
  );
  it("rolls back child deletion failure without shell update or successful audit", async () => {
    const h = harness({ failure: "class_chat_messages" });
    await expect(runMariaDbClassArchiveRetention(h.database, { mode: "execute" })).rejects.toThrow(
      "synthetic child failure",
    );
    expect(h.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(
      h.calls.some(
        (q) =>
          q.sql.startsWith("UPDATE classes") || q.sql.startsWith("INSERT INTO operator_audit_logs"),
      ),
    ).toBe(false);
  });
  it("rolls back if the anonymous shell update affects no class after child deletion", async () => {
    const h = harness({ shellAffected: 0n });
    await expect(
      runMariaDbClassArchiveRetention(h.database, { mode: "execute" }),
    ).rejects.toThrow();
    expect(h.events).toEqual(["BEGIN", "ROLLBACK"]);
    expect(h.calls.some((q) => q.sql.startsWith("INSERT INTO operator_audit_logs"))).toBe(false);
  });
});
