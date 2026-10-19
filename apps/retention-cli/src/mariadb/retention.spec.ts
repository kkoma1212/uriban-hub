import { readFileSync } from "node:fs";
import type { DB } from "@classhub/db";
import {
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import { recordJobFailure } from "../job-audit.js";
import { runMariaDbDeletionRetention } from "./retention.js";
import {
  retentionLockDigest,
  retentionLockDigestDomain,
  retentionLockTables,
  type RetentionLockTable,
} from "./retention-lock.js";
import { countValue, dateValue } from "./values.js";

function queryHarness(
  reply: (query: CompiledQuery) => QueryResult<unknown> | Promise<QueryResult<unknown>>,
) {
  const calls: CompiledQuery[] = [];
  const events: string[] = [];
  let commitFailure: Error | undefined;
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      calls.push(query);
      events.push(query.sql.trim().replace(/\s+/gu, " "));
      return (await reply(query)) as QueryResult<R>;
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
        async destroy() {
          events.push("DESTROY");
        },
        async acquireConnection() {
          events.push("LEASE");
          return connection;
        },
        async releaseConnection() {
          events.push("RELEASE");
        },
        async beginTransaction() {
          events.push("BEGIN");
        },
        async commitTransaction() {
          events.push("COMMIT");
          if (commitFailure) throw commitFailure;
        },
        async rollbackTransaction() {
          events.push("ROLLBACK");
        },
      }),
    },
  });
  return {
    database,
    calls,
    events,
    failCommit(error: Error) {
      commitFailure = error;
    },
  };
}

const startedAt = "2026-09-07 12:34:56.123456";
const cutoffAt = "2026-08-31 12:34:56.123456";
const runId = "20000000-0000-4000-8000-000000000001";
function harness(
  table: RetentionLockTable,
  { deleted = 1n, remaining = "0", failureAt = "", missingSeed = false } = {},
) {
  let countCalls = 0;
  return queryHarness((query) => {
    if (failureAt && query.sql.includes(failureAt))
      throw Object.assign(new Error("private SQL connection-string"), {
        errno: 1213,
        sqlState: "40001",
      });
    if (query.sql.includes("AS started_at"))
      return {
        rows: [
          table === "attendance_notifications"
            ? { started_at: startedAt, cutoff_at: "2025-09-07", job_server_today: "2026-09-07" }
            : { started_at: startedAt, cutoff_at: cutoffAt },
        ],
      };
    if (query.sql.includes("FROM retention_lock_keys"))
      return {
        rows: missingSeed
          ? []
          : [
              {
                lock_digest: retentionLockDigest(table),
                in_transaction: 1,
                isolation_level: "READ-COMMITTED",
              },
            ],
      };
    if (query.sql.includes("COUNT(*)"))
      return { rows: [{ count: countCalls++ === 0 ? "10001" : remaining }] };
    if (query.sql.startsWith("DELETE")) return { rows: [], numAffectedRows: deleted };
    if (query.sql.startsWith("INSERT")) return { rows: [], numAffectedRows: 1n };
    throw new Error("Unexpected test query");
  });
}

describe("MariaDB retention delete jobs", () => {
  it.each(retentionLockTables)(
    "dry-run %s only reads and uses the original predicate",
    async (table) => {
      const h = harness(table);
      const result = await runMariaDbDeletionRetention(h.database, table, { mode: "dry-run" });
      expect(result).toMatchObject({
        table_name: table,
        deleted_count: 0,
        eligible_count: 10001,
        remaining_eligible_count: 10001,
        capped: false,
        run_id: null,
      });
      expect(result).not.toHaveProperty("started_at");
      expect(h.events).not.toContain("BEGIN");
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.parameters).toEqual([
        table === "attendance_notifications" ? "2025-09-07" : "2026-08-31 12:34:56.123",
      ]);
      expect(h.calls[1]!.sql).toContain(table === "attendance_notifications" ? " < " : " <= ");
      expect(h.calls[1]!.sql.includes("user_id IS NULL")).toBe(
        table === "guardian_consent_requests",
      );
      expect(h.calls[0]!.sql.includes("INTERVAL 9 HOUR")).toBe(
        table === "attendance_notifications",
      );
      expect(h.calls[0]!.sql.includes("INTERVAL 7 DAY")).toBe(
        table === "guardian_consent_requests",
      );
    },
  );

  it("retains the default 500 × 20 cap and commits its one success audit", async () => {
    const h = harness("student_assessment_records", { deleted: 500n, remaining: "1" });
    const result = await runMariaDbDeletionRetention(h.database, "student_assessment_records", {
      mode: "execute",
      runId,
    });
    expect(result).toMatchObject({
      deleted_count: 10000,
      remaining_eligible_count: 1,
      capped: true,
      run_id: runId,
    });
    const deletes = h.calls.filter((query) => query.sql.startsWith("DELETE"));
    expect(deletes).toHaveLength(20);
    for (const query of deletes) expect(query.parameters).toEqual(["2026-08-31 12:34:56.123", 500]);
    expect(h.events.filter((event) => event === "BEGIN")).toHaveLength(1);
    expect(h.events.filter((event) => event === "COMMIT")).toHaveLength(1);
    expect(h.events).not.toContain("ROLLBACK");
    expect(h.calls[0]!.sql).toContain("AS started_at");
    expect(h.calls[1]!.sql).toContain("FOR UPDATE");
    const audit = h.calls.at(-1)!;
    expect(audit.parameters).toEqual([
      "retention.executed",
      "student_assessment_records",
      JSON.stringify({
        cutoff_at: "2026-08-31T12:34:56.123Z",
        table_name: "student_assessment_records",
        deleted_count: 10000,
      }),
      runId,
      startedAt,
    ]);
  });

  it.each(retentionLockTables)(
    "%s rechecks the same eligibility in ordered DELETE",
    async (table) => {
      const h = harness(table);
      await runMariaDbDeletionRetention(h.database, table, {
        mode: "execute",
        batchSize: 2,
        runId,
      });
      const deletion = h.calls.find((query) => query.sql.startsWith("DELETE"))!;
      expect(deletion.sql).toContain("ORDER BY");
      expect(deletion.sql).toContain(
        table === "guardian_consent_requests"
          ? ", CAST(id AS CHAR) COLLATE utf8mb4_bin LIMIT ?"
          : ", id LIMIT ?",
      );
      expect(deletion.parameters[0]).toBe(h.calls[2]!.parameters[0]);
      expect(deletion.sql.includes("user_id IS NULL")).toBe(table === "guardian_consent_requests");
      expect(h.calls.filter((query) => query.sql.startsWith("DELETE"))).toHaveLength(1);
    },
  );

  it.each(["DELETE", "INSERT INTO operator_audit_logs"])(
    "rolls back without retry when %s fails",
    async (failureAt) => {
      const h = harness("guardian_consent_requests", { failureAt });
      await expect(
        runMariaDbDeletionRetention(h.database, "guardian_consent_requests", { mode: "execute" }),
      ).rejects.toMatchObject({ errno: 1213 });
      expect(h.events).toContain("ROLLBACK");
      expect(h.events).not.toContain("COMMIT");
      expect(h.events.filter((event) => event === "BEGIN")).toHaveLength(1);
    },
  );

  it("records failure on a fresh lease after rollback, without native names or SQL", async () => {
    const h = harness("guardian_consent_requests", { failureAt: "DELETE" });
    const failure = await runMariaDbDeletionRetention(h.database, "guardian_consent_requests", {
      mode: "execute",
    }).catch((error: unknown) => error);
    await recordJobFailure(h.database, "guardian-consent-requests", failure, "mariadb");
    expect(h.events.indexOf("ROLLBACK")).toBeLessThan(h.events.lastIndexOf("LEASE"));
    expect(h.calls.at(-1)!.parameters.slice(0, 3)).toEqual([
      "job.failed",
      "guardian-consent-requests",
      JSON.stringify({ job_name: "guardian-consent-requests", error_name: "Error" }),
    ]);
    expect(JSON.stringify(h.calls.at(-1)!.parameters)).not.toContain("private");
  });

  it("fails closed before deletion if its committed seed is absent", async () => {
    const h = harness("student_assessment_records", { missingSeed: true });
    await expect(
      runMariaDbDeletionRetention(h.database, "student_assessment_records", { mode: "execute" }),
    ).rejects.toMatchObject({ reason: "seed_missing" });
    expect(h.calls).toHaveLength(2);
    expect(h.events).toContain("ROLLBACK");
  });

  it("does not report success or retry after lost COMMIT acknowledgement", async () => {
    const h = harness("student_assessment_records");
    const failure = new Error("synthetic lost acknowledgement");
    h.failCommit(failure);
    await expect(
      runMariaDbDeletionRetention(h.database, "student_assessment_records", { mode: "execute" }),
    ).rejects.toBe(failure);
    expect(h.events.filter((event) => event === "BEGIN")).toHaveLength(1);
    expect(h.events.filter((event) => event === "COMMIT")).toHaveLength(1);
    expect(h.calls.filter((query) => query.sql.startsWith("DELETE"))).toHaveLength(1);
    // The mock proves caller behavior only; commit outcome remains indeterminate in real faults.
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects batch size %s before SQL",
    async (batchSize) => {
      const h = harness("student_assessment_records");
      await expect(
        runMariaDbDeletionRetention(h.database, "student_assessment_records", {
          mode: "execute",
          batchSize,
        }),
      ).rejects.toThrow("positive safe integer");
      expect(h.calls).toHaveLength(0);
    },
  );

  it("rejects unknown lock identities without SQL or raw identity diagnostics", async () => {
    const h = harness("student_assessment_records");
    const error = await runMariaDbDeletionRetention(
      h.database,
      "private@example.test" as RetentionLockTable,
      { mode: "execute" },
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: "unregistered_lock" });
    expect(String(error)).not.toContain("private");
    expect(h.calls).toHaveLength(0);
  });
});

describe("retention candidate and lossless result boundaries", () => {
  it("installs exactly the three retained runtime digests and only SELECT ACL", () => {
    const root = new URL("../../../../", import.meta.url);
    const ddl = readFileSync(
      new URL("db/mariadb/scope/0035_retained_retention_lock_keys.sql", root),
      "utf8",
    );
    const acl = readFileSync(
      new URL("db/mariadb/permissions/0035_retention_lock_acl.sql", root),
      "utf8",
    );
    const digests = [...ddl.matchAll(/\(0x([a-f0-9]{64})\)/gu)].map((match) => match[1]);
    expect(digests).toEqual(
      retentionLockTables.map((table) => retentionLockDigest(table).toString("hex")),
    );
    expect(new Set(digests).size).toBe(3);
    expect(ddl).toContain(retentionLockDigestDomain);
    expect(acl.split("\n").filter((line) => line.startsWith("GRANT"))).toEqual([
      "GRANT SELECT ON classhub_mariadb_phase1_dev.`retention_lock_keys` TO 'classhub_retention'@'%';",
    ]);
  });
  it("explicitly truncates DB6 only at the original Date boundary", () => {
    expect(dateValue(startedAt).toISOString()).toBe("2026-09-07T12:34:56.123Z");
  });
  it.each([
    "2026-02-30 12:00:00.123456",
    "2026-13-01 12:00:00.123456",
    "2026-09-07T12:00:00.123Z",
    null,
  ])("rejects invalid DB timestamps %s", (value) => {
    expect(() => dateValue(value)).toThrow();
  });
  it.each(["9007199254740993", "1.2", "-1", null, undefined, NaN])(
    "rejects invalid counts %s",
    (value) => {
      expect(() => countValue(value)).toThrow();
    },
  );
});
