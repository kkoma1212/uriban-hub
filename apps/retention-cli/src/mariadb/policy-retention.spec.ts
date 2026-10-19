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
import { policyRetentionTables, runMariaDbPolicyRetention } from "./policy-retention.js";

// retention.spec.ts와 같은 가짜 MariaDB 연결(실행한 SQL만 기록한다).
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

const now = "2026-10-03 00:00:00.000000";

function policyHarness({ eligible = "3", lock = 1, deletedPerBatch = 3n } = {}) {
  return queryHarness((query) => {
    if (query.sql.includes(" AS now")) return { rows: [{ now }] };
    if (query.sql.includes("COUNT(*)")) return { rows: [{ count: eligible }] };
    if (query.sql.includes("GET_LOCK")) return { rows: [{ acquired: lock }] };
    // 가입 승인의 연락처 비우기(UPDATE)도 지우기처럼 바뀐 행 수를 돌려준다.
    if (/^(DELETE|UPDATE)/u.test(query.sql.trim()))
      return { rows: [], numAffectedRows: deletedPerBatch };
    return { rows: [] };
  });
}

// 2026-10-03 사용자 승인(보관기간 ②): 처리방침 4장의 기간이 지난 기록만 지운다.
describe("MariaDB policy retention", () => {
  it("counts every policy table in dry-run and deletes nothing", async () => {
    const h = policyHarness();
    const result = await runMariaDbPolicyRetention(h.database, { mode: "dry-run" });
    expect(result.jobs.map((job) => job.table_name)).toEqual([
      ...policyRetentionTables.slice(0, -1),
      "guardian_consent_requests",
    ]);
    expect(result.jobs.every((job) => job.eligible_count === 3 && job.deleted_count === 0)).toBe(
      true,
    );
    expect(result.run_id).toBeNull();
    expect(h.events.some((event) => /^(DELETE|INSERT)/u.test(event))).toBe(false);
    expect(h.events).not.toContain("BEGIN");
  });

  it("adds the one-year mail log job last only when its grant is installed (I5-04)", async () => {
    const without = await runMariaDbPolicyRetention(policyHarness().database, { mode: "dry-run" });
    expect(without.jobs.map((job) => job.table_name)).not.toContain("mail_delivery_logs");
    const h = policyHarness();
    const { jobs } = await runMariaDbPolicyRetention(h.database, {
      mode: "dry-run",
      includeMailLogs: true,
    });
    expect(jobs.at(-1)).toMatchObject({
      table_name: "mail_delivery_logs",
      cutoff_at: "2025-10-03 00:00:00.000",
    });
    const mailCount = h.calls.find((call) => call.sql.includes("`mail_delivery_logs`"));
    expect(mailCount?.sql).toContain("created_at <= ?");
  });

  it("adds the audit (730 days) and expired consent jobs last when their grant is installed (I3-01)", async () => {
    const h = policyHarness();
    const { jobs } = await runMariaDbPolicyRetention(h.database, {
      mode: "dry-run",
      includeMailLogs: true,
      includeAuditConsents: true,
    });
    expect(jobs.slice(-3).map((job) => job.table_name)).toEqual([
      "mail_delivery_logs",
      "admin_operation_audit_logs",
      "user_consents",
    ]);
    expect(jobs.at(-2)?.cutoff_at).toBe("2024-10-03 00:00:00.000");
    expect(jobs.at(-1)?.cutoff_at).toBe("2026-10-03 00:00:00.000");
    const consentCount = h.calls.find((call) => call.sql.includes("`user_consents`"));
    expect(consentCount?.sql).toContain("retention_expires_at <= ?");
  });

  it("adds admin record jobs last: contact clearing (30 d) before deletions, events before approvals (2026-10-04)", async () => {
    const h = policyHarness();
    const { jobs } = await runMariaDbPolicyRetention(h.database, {
      mode: "dry-run",
      includeMailLogs: true,
      includeAuditConsents: true,
      includeAdminRecords: true,
    });
    expect(jobs.slice(-6).map((job) => [job.table_name, job.cutoff_at])).toEqual([
      ["admin_signup_approvals:contact", "2026-09-03 00:00:00.000"],
      ["admin_signup_approval_events", "2024-10-03 00:00:00.000"],
      ["admin_signup_approvals", "2024-10-03 00:00:00.000"],
      ["admin_passkeys", "2026-09-03 00:00:00.000"],
      ["admin_recovery_codes", "2026-09-03 00:00:00.000"],
      ["admin_inquiries", "2025-10-03 00:00:00.000"],
    ]);
    const approvalCounts = h.calls.filter((call) => call.sql.includes("`admin_signup_approvals`"));
    expect(approvalCounts[0]?.sql).toContain("recipient_email IS NOT NULL");
    expect(approvalCounts[1]?.sql).toContain("NOT EXISTS");
    // 쓰는 중인 패스키(used_at만 있는 행)는 대상이 아니다 — 폐기 시각만 본다.
    const passkeys = h.calls.find((call) => call.sql.includes("`admin_passkeys`"));
    expect(passkeys?.sql).toContain("revoked_at <= ?");
    expect(passkeys?.sql).not.toContain("used_at");
    const without = await runMariaDbPolicyRetention(policyHarness().database, {
      mode: "dry-run",
      includeMailLogs: true,
      includeAuditConsents: true,
    });
    expect(without.jobs.map((job) => job.table_name)).not.toContain("admin_passkeys");
  });

  it("clears only the two contact columns and orders passkeys by credential_id when executing", async () => {
    const h = policyHarness({ eligible: "0" });
    await runMariaDbPolicyRetention(h.database, {
      mode: "execute",
      includeMailLogs: true,
      includeAuditConsents: true,
      includeAdminRecords: true,
    });
    const clear = h.events.find((event) => event.startsWith("UPDATE"));
    expect(clear).toContain("SET recipient_email = NULL, code_encrypted = NULL");
    expect(h.events.filter((event) => event.startsWith("UPDATE"))).toHaveLength(1);
    expect(h.events.some((event) => event.includes("ORDER BY credential_id LIMIT"))).toBe(true);
  });

  it("uses the policy periods from the database clock", async () => {
    const h = policyHarness();
    const { jobs } = await runMariaDbPolicyRetention(h.database, { mode: "dry-run" });
    const cutoffOf = (table: string) => jobs.find((job) => job.table_name === table)?.cutoff_at;
    expect(cutoffOf("sessions")).toBe("2026-09-03 00:00:00.000");
    expect(cutoffOf("api_idempotency_keys")).toBe("2026-10-02 00:00:00.000");
    expect(cutoffOf("security_audit_logs")).toBe("2026-04-06 00:00:00.000");
    expect(cutoffOf("audit_logs")).toBe("2025-10-03 00:00:00.000");
    expect(cutoffOf("admin_auth_audit_logs")).toBe("2024-10-03 00:00:00.000");
    const sessionCount = h.calls.find(
      (call) => call.sql.includes("COUNT(*)") && call.sql.includes("`sessions`"),
    );
    expect(sessionCount?.sql).toContain("COALESCE(revoked_at, expires_at) <= ?");
    expect(sessionCount?.parameters).toEqual(["2026-09-03 00:00:00.000"]);
    const guardian = h.calls.find((call) => call.sql.includes("`guardian_consent_requests`"));
    expect(guardian?.sql).toContain("deleted_at IS NOT NULL");
  });

  it("locks, deletes in batches, records the count and releases the lock per table", async () => {
    const h = policyHarness({ eligible: "0" });
    const result = await runMariaDbPolicyRetention(h.database, { mode: "execute", runId: "r" });
    expect(result.run_id).toBe("r");
    expect(h.events.filter((event) => event === "COMMIT")).toHaveLength(result.jobs.length);
    const first = h.events.slice(h.events.indexOf("BEGIN"), h.events.indexOf("COMMIT") + 1);
    expect(first.map((event) => event.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT", // GET_LOCK
      "SELECT", // 지울 건수
      "DELETE",
      "SELECT", // 남은 건수
      "INSERT", // 작업 기록
      "SELECT", // RELEASE_LOCK
      "COMMIT",
    ]);
    expect(first.some((event) => event.includes("ORDER BY id LIMIT"))).toBe(true);
  });

  it("stops before deleting when another run holds the table lock", async () => {
    const h = policyHarness({ lock: 0 });
    await expect(runMariaDbPolicyRetention(h.database, { mode: "execute" })).rejects.toThrow();
    expect(h.events.some((event) => event.startsWith("DELETE"))).toBe(false);
    expect(h.events).toContain("ROLLBACK");
  });
});
