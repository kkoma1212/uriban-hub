import { createHash } from "node:crypto";

import { createMariaDbDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { AdminManagementService } from "./admin-management.service.js";
import { cachedRequestLimitPolicy } from "../common/rate-limit/request-limit-policy.js";

const adminId = "9007199254740995",
  memberId = "9007199254740997";
const userId = "9007199254740993",
  classId = "9007199254740999";
const documentId = "88888888-8888-4888-8888-888888888888";
const oldDocumentId = "99999999-9999-4999-8999-999999999999";
const requestId = "8590e08f-899c-4b4e-83f0-1c0842348142";
const now = new Date("2026-09-08T01:02:03.123Z");
const dbTime = "2026-09-08 01:02:03.123000";
const oldTime = "2026-09-01 04:05:06.987654";
const futureTime = "2999-01-01 00:00:00.000000";
const content = "Synthetic terms text for isolated verification.";
const digest = createHash("sha256").update(content).digest();
const draftInput = {
  document_type: "terms" as const,
  policy_version: "synthetic-v1",
  title: "Synthetic terms",
  content,
};
type Row = Record<string, unknown>;
type Query = { sql: string; parameters: readonly unknown[] };
type Step = { sql: RegExp; rows?: Row[]; affected?: number; error?: Error; after?: () => void };
const select = (table: string, rows: Row[] = []): Step => ({
  sql: new RegExp(`^select .* from [\x60"]${table}[\x60"]`, "u"),
  rows,
});
const insert = (table: string, patch: Partial<Step> = {}): Step => ({
  sql: new RegExp(`^insert into [\x60"]${table}[\x60"]`, "u"),
  ...patch,
});
const update = (table: string, patch: Partial<Step> = {}): Step => ({
  sql: new RegExp(`^update [\x60"]${table}[\x60"]`, "u"),
  ...patch,
});
const audit = (patch: Partial<Step> = {}) => insert("admin_operation_audit_logs", patch);
const anchor = () => select("admin_accounts", [{ id: adminId }]);
const term = (patch: Row = {}): Row => ({
  id: documentId,
  ...draftInput,
  content_sha256: digest,
  status: "draft",
  effective_at: null,
  published_at: null,
  created_at: oldTime,
  created_by_admin_account_id: adminId,
  ...patch,
});
const member = (patch: Row = {}): Row => ({
  id: memberId,
  class_id: classId,
  user_id: userId,
  role: "student",
  status: "pending",
  row_version: "9007199254740993",
  student_number: 7,
  display_name_in_class: "Synthetic member",
  status_changed_at: oldTime,
  created_at: oldTime,
  updated_at: oldTime,
  ...patch,
});
const inquiry = (patch: Row = {}): Row => ({
  id: documentId,
  requester_user_id: userId,
  subject: "Synthetic inquiry",
  body: "Private text",
  status: "open",
  assigned_admin_account_id: null,
  internal_note: null,
  response: null,
  responded_at: null,
  responded_by_admin_account_id: null,
  resolved_at: null,
  created_at: oldTime,
  updated_at: oldTime,
  ...patch,
});
const stateRow = (value: unknown = { enabled: false }): Row => ({
  key: "maintenance_mode",
  value_json: JSON.stringify(value),
  updated_at: dbTime,
  updated_by_admin_account_id: adminId,
});
const nativeError = (errno: number, sqlState = "45000") =>
  Object.assign(new Error("Synthetic database failure"), { errno, sqlState });
const resources: Array<{ database: Kysely<DB>; steps: Step[] }> = [];

// Exercise the real MariaDB compiler and guarded driver; no network, database or key access.
function boundary(steps: Step[], engine: "mariadb" | "postgres" = "mariadb") {
  const queries: Query[] = [],
    events: string[] = [];
  const failures: { commit?: Error } = {};
  function next(query: Query) {
    queries.push(query);
    const step = steps.shift();
    expect(step, "Unexpected SQL").toBeDefined();
    expect(query.sql).toMatch(step!.sql);
    if (engine === "mariadb") {
      expect(query.sql).not.toMatch(
        /\breturning\b|::|\bilike\b|pg_advisory|to_regclass|on conflict/iu,
      );
      expect(query.parameters.some((value) => value instanceof Date)).toBe(false);
      expect(
        query.parameters.some(
          (value) => typeof value === "object" && value !== null && !Buffer.isBuffer(value),
        ),
      ).toBe(false);
    }
    step!.after?.();
    return step!;
  }
  class PostgresDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          const step = next(query);
          if (step.error) throw step.error;
          return {
            rows: step.rows ?? [],
            numAffectedRows: BigInt(step.affected ?? 1),
          } as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
    override async beginTransaction() {
      events.push("begin");
    }
    override async commitTransaction() {
      events.push("commit");
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
  }
  const database =
    engine === "postgres"
      ? new Kysely<DB>({
          dialect: {
            createDriver: () => new PostgresDriver(),
            createAdapter: () => new PostgresAdapter(),
            createIntrospector: (db) => new PostgresIntrospector(db),
            createQueryCompiler: () => new PostgresQueryCompiler(),
          },
        })
      : createMariaDbDatabase<DB>(
          () => ({
            getConnection: (callback) =>
              callback(null, {
                query: (statement, parameters, reply) => {
                  if (!/^(select|insert|update|delete|call)\b/iu.test(statement)) {
                    events.push(statement);
                    return reply(statement === "COMMIT" ? failures.commit : null, {
                      affectedRows: 0,
                      insertId: 0,
                    });
                  }
                  const step = next({ sql: statement, parameters });
                  reply(
                    step.error ?? null,
                    step.rows ?? { affectedRows: step.affected ?? 1, insertId: 0 },
                  );
                },
                release: vi.fn(),
                destroy: vi.fn(),
              }),
            end: (callback) => callback(null),
          }),
          {
            host: "admin-management.test.invalid",
            database: "synthetic",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
          },
        );
  resources.push({ database, steps });
  const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine });
  return { service: new AdminManagementService(database, config), queries, events, failures };
}
const prefixMember = (status = "pending", patch: Row = {}): Step[] => [
  select("class_members", [{ id: memberId, class_id: classId, user_id: userId }]),
  select("users", [{ deleted_at: null, display_name: "Synthetic user", is_active: 1 }]),
  select("classes", [{ id: classId, status: "active" }]),
  select("class_members", [member({ status, ...patch })]),
];
const memberCall = (patch: Partial<Step> = {}): Step => ({
  sql: /^CALL set_admin_member_status\(/u,
  ...patch,
});
const memberResult = (status: string, patch: Row = {}): Step => ({
  sql: /^SELECT m\.id,m\.status,m\.row_version/u,
  rows: [
    {
      id: memberId,
      status,
      row_version: "9007199254740994",
      status_changed_at: dbTime,
      student_number: status === "removed" ? null : 7,
      display_name_in_class: "Synthetic member",
      ...patch,
    },
  ],
});
const writes = (target: ReturnType<typeof boundary>) =>
  target.queries.filter((q) => /^(insert|update|delete|call)\b/iu.test(q.sql));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const item of resources.splice(0)) {
    expect(item.steps).toHaveLength(0);
    await item.database.destroy();
  }
});

describe("MariaDB administrator management read boundaries", () => {
  it("decodes mixed UUID/BIGINT, boolean, DB6 dates and private audit JSON without unsafe numbers", async () => {
    const target = boundary([
      select("class_members", [
        {
          ...member(),
          display_name: "Fallback",
          email_normalized: "synthetic@example.invalid",
          is_active: 0,
          deleted_at: null,
          class_name: "3반",
          academic_year: 2026,
          grade: 2,
          school_name: "시험중학교",
        },
      ]),
      select("admin_terms_versions", [term()]),
      select("user_consents", [
        {
          id: documentId,
          user_id: userId,
          accepted_at: oldTime,
          withdrawn_at: null,
          retention_expires_at: dbTime,
        },
      ]),
      select("admin_operation_audit_logs", [
        { id: documentId, before_json: null, after_json: '{"enabled":true}', created_at: oldTime },
      ]),
      select("admin_auth_audit_logs", [{ id: memberId, created_at: oldTime }]),
      select("security_audit_logs", [{ id: memberId, created_at: oldTime }]),
      select("admin_inquiries", [inquiry()]),
      select("admin_system_state", [stateRow()]),
    ]);
    const listed = await target.service.listMembers({ search: "A_%\\", status: "pending" });
    expect(listed.members[0]).toMatchObject({
      id: memberId,
      class_id: classId,
      account_active: false,
      status_changed_at: "2026-09-01T04:05:06.987Z",
      // 어느 반 소속인지 보이게(총검수 C2-08).
      class_label: "2026학년도 2학년 3반",
      school_name: "시험중학교",
    });
    expect(listed.truncated).toBe(false);
    expect(target.queries[0]!.sql).toContain("inner join `classes` as `c`");
    expect(target.queries[0]!.parameters).toContain("%A\\_\\%\\\\%");
    expect(target.queries[0]!.sql).toContain("LIKE LOWER(?) ESCAPE ?");
    expect((await target.service.listTermsVersions()).versions[0]!.content_sha256).toBe(
      digest.toString("hex"),
    );
    expect(
      (
        await target.service.listTermsConsents({
          consent_type: "terms",
          policy_version: "synthetic",
        })
      ).consents[0]!.accepted_at,
    ).toEqual(new Date("2026-09-01T04:05:06.987Z"));
    expect((await target.service.listOperationAudits()).logs[0]!.after_json).toEqual({
      enabled: true,
    });
    expect((await target.service.listAdminAuthAudits()).logs[0]!.id).toBe(memberId);
    expect((await target.service.listAudits({})).logs[0]!.created_at).toBeInstanceOf(Date);
    expect((await target.service.listInquiries()).inquiries[0]!.resolved_at).toBeNull();
    expect((await target.service.getSystemState()).states[0]!.value_json).toEqual({
      enabled: false,
    });
  });
  it.each(["", "x", "x".repeat(101)])(
    "rejects overbroad member filter %s before querying",
    async (search) => {
      await expect(boundary([]).service.listMembers({ search })).rejects.toThrow(
        "ADMIN_MEMBER_FILTER_REQUIRED",
      );
    },
  );
  it("filters audit logs by actor, target and Korean-date period, pages by 50 and names the actor (C2-07)", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      id: String(100 - index),
      actor_admin_account_id: adminId,
      actor_display_name: "운영 관리자",
      before_json: null,
      after_json: null,
      created_at: oldTime,
    }));
    const target = boundary([
      select("admin_operation_audit_logs", rows),
      select("admin_auth_audit_logs", [
        { id: memberId, actor_display_name: null, created_at: oldTime },
      ]),
      select("security_audit_logs", []),
    ]);
    const operation = await target.service.listOperationAudits({
      actor: adminId,
      target: "42",
      from: "2026-10-01",
      to: "2026-10-03",
      offset: "50",
    });
    expect(operation.logs).toHaveLength(50);
    expect(operation.has_more).toBe(true);
    expect(operation.logs[0]).toMatchObject({ actor_display_name: "운영 관리자" });
    const sql = target.queries[0]!;
    expect(sql.sql).toContain("left join `admin_accounts` as `actor`");
    expect(sql.sql).toMatch(/limit \? offset \?$/u);
    expect(sql.parameters).toEqual(expect.arrayContaining([adminId, "42", 51, 50]));
    // 한국 날짜 10-01 00:00 ~ 10-03 하루 끝 = UTC 09-30 15:00 이상, 10-03 15:00 미만.
    expect(JSON.stringify(sql.parameters)).toContain("2026-09-30 15:00:00");
    expect(JSON.stringify(sql.parameters)).toContain("2026-10-03 15:00:00");

    const auth = await target.service.listAdminAuthAudits({ actor: memberId });
    expect(auth).toMatchObject({
      has_more: false,
      logs: [{ id: memberId, actor_display_name: null }],
    });
    expect(target.queries[1]!.parameters).toEqual(expect.arrayContaining([memberId, 51, 0]));

    await target.service.listAudits({ target: classId });
    expect(target.queries[2]!.sql).toContain("`target_class_id` = ?");
  });

  it("rejects an impossible audit date before querying", async () => {
    await expect(boundary([]).service.listAudits({ from: "2026-13-40" })).rejects.toThrow(
      "ADMIN_AUDIT_PERIOD_INVALID",
    );
  });
});

describe("MariaDB protected administrator membership transitions", () => {
  it.each([
    ["pending", "approved"],
    ["pending", "rejected"],
    ["approved", "removed"],
    ["removed", "rejoin_allowed"],
  ])(
    "%s to %s locks user/class/member, calls administrator routine, verifies exact history and audits atomically",
    async (previous, status) => {
      const target = boundary([
        ...prefixMember(previous),
        select("class_member_status_history", [{ reason: "Prior reason" }]),
        memberCall(),
        memberResult(status),
        ...(status === "approved"
          ? [{ sql: /^delete from `notice_reads`/u }, { sql: /^delete from `supply_checks`/u }]
          : []),
        insert("audit_logs"),
        audit(),
      ]);
      const result = await target.service.updateMember(
        memberId,
        status,
        "  Synthetic reason  ",
        adminId,
        requestId,
      );
      expect(result.member).toEqual({
        id: memberId,
        status,
        row_version: "9007199254740994",
        status_changed_at: now,
      });
      expect(target.queries.slice(1, 4).every((q) => q.sql.endsWith("for update"))).toBe(true);
      expect(target.queries[5]!.parameters).toEqual([
        classId,
        userId,
        memberId,
        status,
        "Synthetic reason",
        adminId,
        dbTime,
      ]);
      expect(target.queries[6]!.sql).toContain("h.id=@admin_member_history_id");
      expect(target.queries[6]!.sql).toContain("h.actor_user_id IS NULL");
      expect(
        writes(target).some((q) =>
          /^update `class_members`|^insert into `class_member_status_history`/u.test(q.sql),
        ),
      ).toBe(false);
      expect(target.queries.at(-1)!.parameters).toContain(JSON.stringify({ status }));
      expect(target.events).toContain("COMMIT");
    },
  );
  it.each([
    [32102, "45000", "MEMBER_NOT_FOUND"],
    [32103, "45000", "ADMIN_MEMBER_CLASS_NOT_ACTIVE"],
    [32104, "45000", "ADMIN_MEMBER_STATUS_TRANSITION_INVALID"],
    [32105, "45000", "ADMIN_MEMBER_REASON_REQUIRED"],
    [32106, "45000", "ADMIN_MEMBER_ACCOUNT_INACTIVE"],
    [32107, "45000", "ADMIN_MEMBER_STATUS_TRANSITION_INVALID"],
    [1370, "42000", "Synthetic database failure"],
    [30003, "45000", "Synthetic database failure"],
    [1213, "40001", "Synthetic database failure"],
    [32106, "23000", "Synthetic database failure"],
  ])(
    "rolls back CALL error %s/%s without broad error reinterpretation",
    async (errno, state, message) => {
      const target = boundary([
        ...prefixMember(),
        select("class_member_status_history"),
        memberCall({ error: nativeError(Number(errno), String(state)) }),
      ]);
      await expect(
        target.service.updateMember(memberId, "approved", undefined, adminId, requestId),
      ).rejects.toThrow(String(message));
      expect(target.events).toContain("ROLLBACK");
    },
  );
  it.each([
    { row_version: "9007199254740993" },
    { student_number: 7 },
    { display_name_in_class: "Wrong name" },
    { id: userId },
  ])("rejects a mismatched protected routine result %j before any audit", async (patch) => {
    const target = boundary([
      ...prefixMember("approved"),
      select("class_member_status_history"),
      memberCall(),
      memberResult("removed", patch),
    ]);
    await expect(
      target.service.updateMember(memberId, "removed", "Reason", adminId, requestId),
    ).rejects.toThrow("Invalid MariaDB administrator management value");
    expect(target.events).toContain("ROLLBACK");
  });
  it("rolls back a valid transition and both history writes when its later audit fails", async () => {
    const failure = nativeError(32106);
    const target = boundary([
      ...prefixMember("approved"),
      select("class_member_status_history"),
      memberCall(),
      memberResult("removed"),
      insert("audit_logs"),
      audit({ error: failure }),
    ]);
    await expect(
      target.service.updateMember(memberId, "removed", "Reason", adminId, requestId),
    ).rejects.toBe(failure);
    expect(target.events).toContain("ROLLBACK");
  });
  it.each([
    [{ role: "teacher" }, "MEMBER_NOT_FOUND"],
    [{ status: "rejected" }, "ADMIN_MEMBER_STATUS_TRANSITION_INVALID"],
    [{ user_id: adminId }, "MEMBER_NOT_FOUND"],
  ])("rejects protected member policy %j without calling a routine", async (patch, message) => {
    const target = boundary(prefixMember("pending", patch as Row));
    await expect(
      target.service.updateMember(memberId, "approved", undefined, adminId, requestId),
    ).rejects.toThrow(String(message));
    expect(writes(target)).toEqual([]);
  });
});

describe("MariaDB immutable terms and publication transactions", () => {
  it("uses the database UUID and exact document/version key, audits only the digest", async () => {
    const target = boundary([
      insert("admin_terms_versions"),
      select("admin_terms_versions", [term()]),
      audit(),
    ]);
    const result = await target.service.createTermsVersion(draftInput, adminId, requestId);
    expect(result.version.id).toBe(documentId);
    expect(result.version.content_sha256).toBe(digest.toString("hex"));
    expect(target.queries[0]!.sql).not.toMatch(/\(`id`|, `id`/u);
    expect(target.queries[1]!.parameters).toEqual(["terms", "synthetic-v1"]);
    expect(target.queries[2]!.parameters).not.toContain(content);
  });
  it.each([true, false])(
    "maps an INSERT duplicate only after rollback and exact identity lookup (found=%s)",
    async (found) => {
      const failure = nativeError(1062, "23000");
      const target: ReturnType<typeof boundary> = boundary([
        insert("admin_terms_versions", { error: failure }),
        {
          ...select("admin_terms_versions", found ? [{ id: documentId }] : []),
          after: () => expect(target.events).toContain("ROLLBACK"),
        },
      ]);
      const result = target.service.createTermsVersion(draftInput, adminId, requestId);
      if (found) await expect(result).rejects.toThrow("TERMS_VERSION_EXISTS");
      else await expect(result).rejects.toBe(failure);
    },
  );
  it.each(["audit", "commit"])(
    "preserves a later %s duplicate failure instead of claiming the version exists",
    async (stage) => {
      const failure = nativeError(1062, "23000");
      const target = boundary([
        insert("admin_terms_versions"),
        select("admin_terms_versions", [term()]),
        audit(stage === "audit" ? { error: failure } : {}),
      ]);
      if (stage === "commit") target.failures.commit = failure;
      await expect(target.service.createTermsVersion(draftInput, adminId, requestId)).rejects.toBe(
        failure,
      );
      expect(target.events).toContain("ROLLBACK");
    },
  );
  it("locks the stable account before either term and records automatic retirement plus publication", async () => {
    const target = boundary([
      anchor(),
      select("admin_terms_versions", [term()]),
      select("admin_terms_versions", [{ id: oldDocumentId }]),
      update("admin_terms_versions"),
      update("admin_terms_versions"),
      select("admin_terms_versions", [
        term({ status: "published", effective_at: dbTime, published_at: dbTime }),
      ]),
      audit(),
      audit(),
    ]);
    const result = await target.service.updateTermsVersionStatus(
      documentId,
      "published",
      now.toISOString(),
      "Publish synthetic",
      adminId,
      requestId,
    );
    expect(result.version.status).toBe("published");
    expect(target.queries[0]!.sql).toMatch(/order by `id` asc limit \? for update/u);
    expect(target.queries[1]!.sql).toMatch(/where `id` = \? for update/u);
    expect(target.queries[2]!.sql).toMatch(/order by `id` for update/u);
    expect(target.queries[4]!.parameters).toEqual(["published", dbTime, dbTime, documentId]);
    expect(target.queries[6]!.parameters).toContain(oldDocumentId);
    expect(target.queries[6]!.parameters).toContain(
      JSON.stringify({ status: "retired", superseded_by: documentId }),
    );
    expect(target.events).toContain("COMMIT");
  });
  it("retiring changes status alone so stored six-digit effective/publication times survive", async () => {
    const published = term({ status: "published", effective_at: oldTime, published_at: oldTime });
    const target = boundary([
      anchor(),
      select("admin_terms_versions", [published]),
      // 같은 종류의 시행 중인 다른 게시본이 있어야 폐기할 수 있다(C2-04).
      select("admin_terms_versions", [{ effective_at: oldTime, published_at: oldTime }]),
      update("admin_terms_versions"),
      select("admin_terms_versions", [{ ...published, status: "retired" }]),
      audit(),
    ]);
    await target.service.updateTermsVersionStatus(
      documentId,
      "retired",
      undefined,
      "Retire synthetic",
      adminId,
      requestId,
    );
    expect(target.queries[3]!.sql).toBe(
      "update `admin_terms_versions` set `status` = ? where `id` = ?",
    );
    expect(target.queries[3]!.parameters).toEqual(["retired", documentId]);
  });
  it.each([
    ["no other published version", []],
    [
      "only a replacement that is not in effect yet",
      [{ effective_at: futureTime, published_at: oldTime }],
    ],
  ])("refuses to retire the published document with %s (C2-04)", async (_label, replacements) => {
    const published = term({ status: "published", effective_at: oldTime, published_at: oldTime });
    const target = boundary([
      anchor(),
      select("admin_terms_versions", [published]),
      select("admin_terms_versions", replacements),
    ]);
    await expect(
      target.service.updateTermsVersionStatus(
        documentId,
        "retired",
        undefined,
        "Retire synthetic",
        adminId,
        requestId,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "TERMS_VERSION_REPLACEMENT_REQUIRED" },
    });
    expect(target.queries.some(({ sql }) => sql.startsWith("update"))).toBe(false);
    expect(target.events).not.toContain("COMMIT");
  });
  it("rolls back retirement and publication together if publication audit fails", async () => {
    const failure = nativeError(1142, "42000");
    const target = boundary([
      anchor(),
      select("admin_terms_versions", [term()]),
      select("admin_terms_versions", [{ id: oldDocumentId }]),
      update("admin_terms_versions"),
      update("admin_terms_versions"),
      select("admin_terms_versions", [
        term({ status: "published", effective_at: dbTime, published_at: dbTime }),
      ]),
      audit(),
      audit({ error: failure }),
    ]);
    await expect(
      target.service.updateTermsVersionStatus(
        documentId,
        "published",
        now.toISOString(),
        "Synthetic",
        adminId,
        requestId,
      ),
    ).rejects.toBe(failure);
    expect(target.events).toContain("ROLLBACK");
  });
  it.each([
    { content: "[게시본 주입: operator]" },
    { content: "[게시 전 확정: retention]" },
    { content: "개발 정본" },
    { title: "[게시본 주입: operator]" },
    { title: "[게시 전 확정: retention]" },
    { title: "이용약관 (개발 정본)" },
  ])(
    "preserves publication gate for %j before retiring any existing version",
    async (incomplete) => {
      const target = boundary([anchor(), select("admin_terms_versions", [term(incomplete)])]);
      await expect(
        target.service.updateTermsVersionStatus(
          documentId,
          "published",
          now.toISOString(),
          "Synthetic",
          adminId,
          requestId,
        ),
      ).rejects.toThrow("TERMS_VERSION_HAS_UNRESOLVED_PLACEHOLDER");
      expect(writes(target)).toEqual([]);
    },
  );
  it.each([
    [undefined, "TERMS_VERSION_EFFECTIVE_AT_INVALID"],
    ["invalid", "TERMS_VERSION_EFFECTIVE_AT_INVALID"],
    ["2027-01-01T00:00:00Z", "TERMS_VERSION_EFFECTIVE_AT_FUTURE"],
  ])("rejects invalid publication time %s before any lock", async (effective, message) => {
    await expect(
      boundary([]).service.updateTermsVersionStatus(
        documentId,
        "published",
        effective,
        "Synthetic",
        adminId,
        requestId,
      ),
    ).rejects.toThrow(message!);
  });
});

describe("MariaDB inquiry and state writes", () => {
  it.each([true, false])(
    "invalidates request policy only after a committed administrator update (commit=%s)",
    async (commit) => {
      const prior = { max_attempts: 3, cooldown_seconds: 60 };
      const next = { max_attempts: 2, cooldown_seconds: 120 };
      const load = vi.fn(async () => prior);
      const readPolicy = cachedRequestLimitPolicy(load);
      await readPolicy();
      load.mockResolvedValue(next);
      const target = boundary([
        anchor(),
        select("admin_system_state", [stateRow(prior)]),
        insert("admin_system_state"),
        select("admin_system_state", [stateRow(next)]),
        audit(),
      ]);
      const failure = new Error("synthetic commit failure");
      if (!commit) target.failures.commit = failure;
      const update = target.service.updateSystemState("request_limits", next, adminId, requestId);
      if (commit) await update;
      else await expect(update).rejects.toBe(failure);
      expect(await readPolicy()).toEqual(commit ? next : prior);
      expect(load).toHaveBeenCalledTimes(commit ? 2 : 1);
    },
  );

  it("assigns, responds and resolves with UTC values while keeping message text out of audits", async () => {
    const resultRow = inquiry({
      status: "resolved",
      response: "Synthetic response",
      assigned_admin_account_id: adminId,
      responded_at: dbTime,
      resolved_at: dbTime,
      updated_at: dbTime,
    });
    const target = boundary([
      select("admin_inquiries", [inquiry()]),
      update("admin_inquiries"),
      select("admin_inquiries", [resultRow]),
      audit(),
    ]);
    const result = await target.service.updateInquiry(
      documentId,
      {
        status: "resolved",
        response: "Synthetic response",
        internal_note: "Internal synthetic",
        assigned_admin_account_id: adminId,
      },
      adminId,
      requestId,
    );
    expect(result.inquiry.responded_at).toEqual(now);
    expect(target.queries[1]!.parameters).toContain(dbTime);
    expect(target.queries[3]!.parameters).not.toContain("Synthetic response");
    expect(target.queries[3]!.parameters).not.toContain("Internal synthetic");
    expect(target.events).toContain("COMMIT");
  });
  it("allows a zero-change repeat save and explicit unassignment", async () => {
    const target = boundary([
      select("admin_inquiries", [inquiry()]),
      update("admin_inquiries", { affected: 0 }),
      select("admin_inquiries", [inquiry()]),
      audit(),
    ]);
    const result = await target.service.updateInquiry(
      documentId,
      { status: "open", assigned_admin_account_id: null },
      adminId,
      requestId,
    );
    expect(result.inquiry.assigned_admin_account_id).toBeNull();
    expect(target.queries[1]!.sql).not.toContain("`response` =");
  });
  it.each([0, 1, 2])(
    "serializes missing/existing system keys and accepts MariaDB upsert affected=%s",
    async (affected) => {
      const target = boundary([
        anchor(),
        select("admin_system_state", affected === 1 ? [] : [stateRow()]),
        insert("admin_system_state", { affected }),
        select("admin_system_state", [stateRow({ enabled: true })]),
        audit(),
      ]);
      const result = await target.service.updateSystemState(
        "maintenance_mode",
        { enabled: true },
        adminId,
        requestId,
      );
      expect(result.state.value_json).toEqual({ enabled: true });
      expect(target.queries[1]!.sql).toMatch(/where `key` = \? for update/u);
      expect(target.queries[2]!.sql).toContain("on duplicate key update");
      expect(target.queries[2]!.parameters.filter((v) => v === '{"enabled":true}')).toHaveLength(2);
      expect(target.queries[4]!.parameters).toContain(affected === 1 ? null : '{"enabled":false}');
    },
  );
  it.each(["inquiry", "system"])(
    "rolls back %s data if its required operation audit is denied",
    async (kind) => {
      const failure = nativeError(1142, "42000");
      const target = boundary(
        kind === "inquiry"
          ? [
              select("admin_inquiries", [inquiry()]),
              update("admin_inquiries"),
              select("admin_inquiries", [inquiry()]),
              audit({ error: failure }),
            ]
          : [
              anchor(),
              select("admin_system_state"),
              insert("admin_system_state"),
              select("admin_system_state", [stateRow()]),
              audit({ error: failure }),
            ],
      );
      const result =
        kind === "inquiry"
          ? target.service.updateInquiry(documentId, { status: "open" }, adminId, requestId)
          : target.service.updateSystemState(
              "maintenance_mode",
              { enabled: false },
              adminId,
              requestId,
            );
      await expect(result).rejects.toBe(failure);
      expect(target.events).toContain("ROLLBACK");
    },
  );
  it.each([null, [], { enabled: 1 }, { enabled: true, secret: "invalid" }])(
    "validates the system object %j before opening a transaction",
    async (value) => {
      await expect(
        boundary([]).service.updateSystemState("maintenance_mode", value, adminId, requestId),
      ).rejects.toThrow("ADMIN_SYSTEM_STATE_INVALID");
    },
  );
});

describe("PostgreSQL compatibility sentinels", () => {
  it("keeps member RETURNING, administrator history and optional legacy assignment cleanup", async () => {
    const target = boundary(
      [
        ...prefixMember("approved"),
        select("class_member_status_history"),
        update("class_members", {
          rows: [
            {
              id: memberId,
              status: "removed",
              row_version: "9007199254740994",
              status_changed_at: now,
            },
          ],
        }),
        { sql: /SELECT to_regclass\('public.seat_draw_assignments'\)/u, rows: [{ exists: true }] },
        { sql: /^delete from "seat_draw_assignments"/u },
        { sql: /SELECT to_regclass\('public.team_draw_assignments'\)/u, rows: [{ exists: false }] },
        { sql: /SELECT to_regclass\('public.duty_assignments'\)/u, rows: [{ exists: false }] },
        insert("class_member_status_history"),
        insert("audit_logs"),
        audit(),
      ],
      "postgres",
    );
    await target.service.updateMember(memberId, "removed", "Synthetic", adminId, requestId);
    expect(target.queries[5]!.sql).toContain(
      'returning "id", "status", "row_version", "status_changed_at"',
    );
    expect(target.queries[5]!.parameters).toContainEqual(now);
    expect(target.queries[10]!.parameters).toContain(adminId);
    expect(target.events).toContain("commit");
  });
  it("retains native Date/JSON with RETURNING and ON CONFLICT for state and inquiry", async () => {
    const target = boundary(
      [
        select("admin_system_state"),
        insert("admin_system_state", {
          rows: [{ ...stateRow(), value_json: { enabled: false }, updated_at: now }],
        }),
        audit(),
        select("admin_inquiries", [inquiry()]),
        update("admin_inquiries", { rows: [inquiry({ updated_at: now })] }),
        audit(),
      ],
      "postgres",
    );
    await target.service.updateSystemState(
      "maintenance_mode",
      { enabled: false },
      adminId,
      requestId,
    );
    await target.service.updateInquiry(documentId, { status: "open" }, adminId, requestId);
    expect(target.queries[1]!.sql).toMatch(/on conflict \("key"\) do update set .* returning \*/u);
    expect(target.queries[1]!.parameters).toContainEqual(now);
    expect(target.queries[1]!.parameters).toContainEqual({ enabled: false });
    expect(target.queries[4]!.sql).toContain("returning *");
    expect(target.queries.some((q) => /admin_accounts/u.test(q.sql))).toBe(false);
  });
  it("keeps database-generated terms RETURNING and per-document PG advisory locks", async () => {
    const pgTerm = term({ created_at: now, published_at: now, effective_at: now });
    const target = boundary(
      [
        insert("admin_terms_versions", { rows: [pgTerm] }),
        audit(),
        select("admin_terms_versions", [pgTerm]),
        { sql: /^SELECT pg_advisory_xact_lock/u },
        update("admin_terms_versions", { rows: [{ id: oldDocumentId }] }),
        update("admin_terms_versions", { rows: [{ ...pgTerm, status: "published" }] }),
        audit(),
        audit(),
      ],
      "postgres",
    );
    await target.service.createTermsVersion(draftInput, adminId, requestId);
    await target.service.updateTermsVersionStatus(
      documentId,
      "published",
      now.toISOString(),
      "Synthetic",
      adminId,
      requestId,
    );
    expect(target.queries[0]!.sql).toContain("returning *");
    expect(target.queries[3]!.parameters).toEqual(["admin-terms:terms"]);
    expect(target.queries[4]!.sql).toContain('returning "id"');
  });
});
