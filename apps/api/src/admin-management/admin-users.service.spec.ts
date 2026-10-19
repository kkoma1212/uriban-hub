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

import { hashVerificationToken } from "../auth/auth-crypto.js";
import type { AppEnvironment } from "../config/environment.js";
import { AdminUsersService } from "./admin-users.service.js";

const userId = "9007199254740993";
const adminId = "9007199254740995";
const requestId = "8590e08f-899c-4b4e-83f0-1c0842348142";
const now = new Date("2026-09-08T01:02:03.123Z");
const nativeNow = "2026-09-08 01:02:03.123000";
const transactionTime = "2026-09-08 01:02:03.098765";
const email = "managed@example.invalid";
const origin = "https://classhub.example.invalid";
const requestedIp = "2001:0db8:0:0:0:0:0:1";
type Row = Record<string, unknown>;
type Query = { sql: string; parameters: readonly unknown[] };
type Step = { sql: RegExp; rows?: Row[]; affectedRows?: number; error?: Error; after?: () => void };

const user = (overrides: Row = {}): Row => ({
  id: userId,
  email_normalized: email,
  display_name: "대상 계정",
  is_active: 1,
  deleted_at: null,
  email_verified_at: null,
  signup_approved_at: nativeNow,
  created_at: "2026-09-01 12:13:14.567890",
  updated_at: nativeNow,
  ...overrides,
});
const selectUser = (rows = [user()]): Step => ({ sql: /^select .* from [`"]users[`"]/u, rows });
const teacherCheck = (rows: Row[] = []): Step => ({
  sql: /^select .* from [`"]class_members[`"] as [`"]member[`"] inner join/u,
  rows,
});
const update = (table: string): Step => ({
  sql: new RegExp(`^update [\x60"]${table}[\x60"]`, "u"),
});
const insert = (table: string): Step => ({
  sql: new RegExp(`^insert into [\x60"]${table}[\x60"]`, "u"),
});
const audit = (): Step => insert("admin_operation_audit_logs");
const setStatus = (patch: Partial<Step> = {}): Step => ({
  sql: /^CALL set_admin_user_status\(/u,
  ...patch,
});
const clock = (): Step => ({
  sql: /^SELECT DATE_FORMAT\(UTC_TIMESTAMP\(6\)/u,
  rows: [{ transaction_time: transactionTime }],
});
const resources: Array<{ database: Kysely<DB>; steps: Step[] }> = [];

// Native MariaDB compilation and guarded-driver boundaries use an in-memory callback pool.
// The PG sentinel uses its real query compiler. Neither harness opens a network connection.
function boundary(steps: Step[], engine: "mariadb" | "postgres" = "mariadb") {
  const queries: Query[] = [];
  const events: string[] = [];
  const state: { commitError?: Error } = {};
  function next(query: Query): Step {
    queries.push(query);
    const step = steps.shift();
    expect(step, "unexpected SQL").toBeDefined();
    expect(query.sql).toMatch(step!.sql);
    if (engine === "mariadb") {
      expect(query.sql).not.toMatch(/\breturning\b|::|\bilike\b|\bnow\(/iu);
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
            numAffectedRows: BigInt(step.affectedRows ?? 1),
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
                    return reply(statement === "COMMIT" ? state.commitError : null, {
                      affectedRows: 0,
                      insertId: 0,
                    });
                  }
                  const step = next({ sql: statement, parameters });
                  reply(
                    step.error ?? null,
                    step.rows ?? { affectedRows: step.affectedRows ?? 1, insertId: 0 },
                  );
                },
                release: vi.fn(),
                destroy: vi.fn(),
              }),
            end: (callback) => callback(null),
          }),
          {
            host: "admin-users.test.invalid",
            database: "synthetic",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
          },
        );
  resources.push({ database, steps });
  const config = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: engine,
    PUBLIC_APP_ORIGIN: origin,
  });
  const resetMails: Array<{ email: string; token: string }> = [];
  const resetMailer = {
    sendPasswordResetEmail: vi.fn(async (to: string, token: string) => {
      resetMails.push({ email: to, token });
    }),
  };
  return {
    service: new AdminUsersService(database, config, undefined, resetMailer),
    queries,
    events,
    state,
    steps,
    resetMails,
  };
}
const mutations = (target: ReturnType<typeof boundary>) =>
  target.queries.filter((query) => /^(insert|update|call)\b/iu.test(query.sql));
const disable = (target: ReturnType<typeof boundary>) =>
  target.service.updateStatus(userId, "inactive", "본인 확인 후 계정 비활성화", adminId, requestId);
const issueReset = (target: ReturnType<typeof boundary>) =>
  target.service.issuePasswordReset(userId, "본인 확인 후 재설정", adminId, requestId, requestedIp);

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

describe("MariaDB ordinary user administration writes", () => {
  it("disables one user, rereads under the same lock, revokes only that user's live sessions and audits booleans", async () => {
    const target = boundary([
      selectUser(),
      teacherCheck(),
      setStatus(),
      selectUser([user({ is_active: 0 })]),
      update("sessions"),
      audit(),
    ]);
    const result = await disable(target);

    expect(result.user).toEqual({
      id: userId,
      email,
      display_name: "대상 계정",
      is_active: false,
      email_verified: false,
      signup_approved: true,
      created_at: new Date("2026-09-01T12:13:14.567Z"),
      updated_at: now,
    });
    expect(target.queries[0]!.sql).toMatch(/where `id` = \? for update$/u);
    expect(target.queries[0]!.parameters).toEqual([userId]);
    expect(target.queries[1]!.parameters).toEqual([userId, "teacher", "approved", "active"]);
    expect(target.queries[2]!.parameters).toEqual([userId, false, nativeNow]);
    expect(target.queries[3]!.sql).toContain(
      "where `id` = ? and `is_active` = ? and `updated_at` = ?",
    );
    expect(target.queries[3]!.parameters).toEqual([userId, false, nativeNow]);
    expect(target.queries.some(({ sql }) => /^update `users`/u.test(sql))).toBe(false);
    expect(target.queries[4]!.sql).toContain("where `user_id` = ? and `revoked_at` is null");
    expect(target.queries[4]!.parameters).toEqual([nativeNow, userId]);
    const log = target.queries[5]!;
    expect(log.parameters).toContain('{"is_active":true}');
    expect(log.parameters).toContain('{"is_active":false}');
    expect(log.parameters).toContain("admin.user.status_changed");
    expect(log.parameters).not.toContain(email);
    expect(log.parameters).not.toContain("대상 계정");
    expect(target.events).toContain("COMMIT");
  });

  it("reactivates a numeric-false account without restoring or revoking sessions", async () => {
    const target = boundary([
      selectUser([user({ is_active: 0 })]),
      setStatus(),
      selectUser(),
      audit(),
    ]);
    const result = await target.service.updateStatus(
      userId,
      "active",
      "재활성화",
      adminId,
      requestId,
    );
    expect(result.user.is_active).toBe(true);
    expect(target.queries.map(({ sql }) => sql).join("\n")).not.toMatch(/sessions|class_members/u);
    expect(target.queries[1]!.parameters).toEqual([userId, true, nativeNow]);
    expect(target.events).toContain("COMMIT");
  });

  it.each([
    [1, "active"],
    [0, "inactive"],
  ] as const)("rejects unchanged native boolean %s / %s without writes", async (active, status) => {
    const target = boundary([selectUser([user({ is_active: active })])]);
    await expect(
      target.service.updateStatus(userId, status, "상태 확인", adminId, requestId),
    ).rejects.toMatchObject({ response: { code: "ADMIN_USER_STATUS_UNCHANGED" } });
    expect(mutations(target)).toHaveLength(0);
    expect(target.events).not.toContain("COMMIT");
  });

  it("requires teacher transfer before disabling the owner of an active class", async () => {
    const target = boundary([selectUser(), teacherCheck([{ id: "9007199254740997" }])]);
    await expect(disable(target)).rejects.toMatchObject({
      status: 409,
      response: { code: "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED" },
    });
    expect(mutations(target)).toHaveLength(0);
    expect(target.events).not.toContain("COMMIT");
  });

  it.each(["missing", "deleted"] as const)(
    "rejects a %s account for both mutations",
    async (status) => {
      const rows = status === "missing" ? [] : [user({ deleted_at: nativeNow })];
      const statusTarget = boundary([selectUser(rows)]);
      const resetTarget = boundary([clock(), selectUser(rows)]);
      for (const operation of [disable(statusTarget), issueReset(resetTarget)]) {
        await expect(operation).rejects.toMatchObject({ response: { code: "USER_NOT_FOUND" } });
      }
      expect(mutations(statusTarget)).toHaveLength(0);
      expect(mutations(resetTarget)).toHaveLength(0);
    },
  );

  it.each(["0", "-1", "01", "1e3", "9223372036854775808"])(
    "rejects invalid database ID %s before opening a transaction",
    async (id) => {
      const target = boundary([]);
      await expect(
        target.service.updateStatus(id, "inactive", "확인", adminId, requestId),
      ).rejects.toMatchObject({ response: { code: "USER_NOT_FOUND" } });
      await expect(
        target.service.issuePasswordReset(id, "확인", adminId, requestId, requestedIp),
      ).rejects.toMatchObject({ response: { code: "USER_NOT_FOUND" } });
      expect(target.events).toHaveLength(0);
    },
  );

  it("rejects malformed native boolean values before status changes", async () => {
    const target = boundary([selectUser([user({ is_active: "0" })])]);
    await expect(disable(target)).rejects.toThrow("Invalid MariaDB application value.");
    expect(mutations(target)).toHaveLength(0);
    expect(target.events).not.toContain("COMMIT");
  });

  it("does not report a successful state transition when the protected routine's reread finds no row", async () => {
    const target = boundary([selectUser(), teacherCheck(), setStatus(), selectUser([])]);
    await expect(disable(target)).rejects.toThrow(
      "Unexpected administrator user status update result.",
    );
    expect(mutations(target)).toHaveLength(1);
    expect(target.events).not.toContain("COMMIT");
    expect(
      target.events.slice(target.events.indexOf("START TRANSACTION READ WRITE") + 1),
    ).toContain("ROLLBACK");
  });

  it.each([{ id: "9007199254740994", is_active: 0 }, { is_active: 1 }])(
    "rejects a mismatched post-routine account before session or audit work: %o",
    async (changed) => {
      const target = boundary([
        selectUser(),
        teacherCheck(),
        setStatus(),
        selectUser([user(changed)]),
      ]);
      await expect(disable(target)).rejects.toThrow(
        "Unexpected administrator user status update result.",
      );
      expect(mutations(target)).toHaveLength(1);
      expect(target.events).not.toContain("COMMIT");
      expect(target.events).toContain("ROLLBACK");
    },
  );

  it.each([
    [32002, { code: "USER_NOT_FOUND" }],
    [32003, { code: "ADMIN_USER_STATUS_UNCHANGED" }],
    [32004, { code: "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED" }],
  ] as const)(
    "maps protected CALL business error %s without direct user DML",
    async (errno, response) => {
      const error = Object.assign(new Error("synthetic routine rejection"), {
        errno,
        sqlState: "45000",
      });
      const target = boundary([selectUser(), teacherCheck(), setStatus({ error })]);
      await expect(disable(target)).rejects.toMatchObject({ response });
      expect(target.queries.some(({ sql }) => /^update `users`/u.test(sql))).toBe(false);
      expect(target.events).not.toContain("COMMIT");
      expect(target.events).toContain("ROLLBACK");
    },
  );

  it.each([
    [1370, "42000"],
    [30003, "45000"],
    [32005, "45000"],
    [1213, "40001"],
    [32004, "HY000"],
  ] as const)(
    "preserves native CALL failure %s/%s for complete rollback",
    async (errno, sqlState) => {
      const error = Object.assign(new Error("synthetic native failure"), { errno, sqlState });
      const target = boundary([selectUser(), teacherCheck(), setStatus({ error })]);
      await expect(disable(target)).rejects.toBe(error);
      expect(target.queries).toHaveLength(3);
      expect(target.events).not.toContain("COMMIT");
      expect(target.events).toContain("ROLLBACK");
    },
  );

  it("does not reinterpret a later audit error as a protected-routine business rejection", async () => {
    const error = Object.assign(new Error("synthetic later audit failure"), {
      errno: 32004,
      sqlState: "45000",
    });
    const target = boundary([
      selectUser(),
      teacherCheck(),
      setStatus(),
      selectUser([user({ is_active: 0 })]),
      update("sessions"),
      { ...audit(), error },
    ]);
    await expect(disable(target)).rejects.toBe(error);
    expect(target.events).not.toContain("COMMIT");
    expect(target.events).toContain("ROLLBACK");
  });

  it("rolls back the user and session changes when required operation audit insertion fails", async () => {
    const failure = new Error("synthetic audit failure");
    const target = boundary([
      selectUser(),
      teacherCheck(),
      setStatus(),
      selectUser([user({ is_active: 0 })]),
      update("sessions"),
      { ...audit(), error: failure },
    ]);
    await expect(disable(target)).rejects.toBe(failure);
    expect(target.events).not.toContain("COMMIT");
    expect(
      target.events.slice(target.events.indexOf("START TRANSACTION READ WRITE") + 1),
    ).toContain("ROLLBACK");
  });

  it("preserves existing search escaping, booleans, identifiers and public dates", async () => {
    const target = boundary([selectUser([user({ is_active: 0 })])]);
    const result = await target.service.list(" %_ ");
    expect(target.queries[0]!.sql).toContain("LOWER(email_normalized) LIKE LOWER(?) ESCAPE ?");
    expect(target.queries[0]!.parameters).toEqual(["%\\%\\_%", "\\", "%\\%\\_%", "\\", 51]);
    expect(result.users[0]).toMatchObject({ id: userId, is_active: false, updated_at: now });
    expect(result.truncated).toBe(false);
  });
});

describe("MariaDB administrator-issued ordinary user reset links", () => {
  it("preserves the app deadline, DB6 creation time and user-to-token lock order without changing passwords", async () => {
    const later = new Date(now.getTime() + 90_000);
    const target = boundary([
      clock(),
      { ...selectUser(), after: () => vi.setSystemTime(later) },
      update("password_reset_tokens"),
      insert("password_reset_tokens"),
      audit(),
    ]);
    const result = await issueReset(target);
    // 2026-10-02 사용자 결정(총검수 C2-05): 링크는 사용자 메일로만 가고 관리자 응답에는 없다.
    expect(result).toEqual({
      expires_at: "2026-09-08T01:32:03.123Z",
      mail: "sent",
      email_masked: expect.stringContaining("*"),
    });
    expect(JSON.stringify(result)).not.toMatch(/token|reset-password/u);
    expect(target.resetMails).toHaveLength(1);
    expect(target.resetMails[0]!.email).toBe(email);
    const token = target.resetMails[0]!.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.expires_at).toBe("2026-09-08T01:32:03.123Z");
    expect(target.queries[1]!.sql).toMatch(/for update$/u);
    const invalidation = target.queries[2]!;
    expect(invalidation.sql).toContain(
      "where `user_id` = ? and `used_at` is null and `invalidated_at` is null",
    );
    expect(invalidation.parameters).toEqual(["2026-09-08 01:03:33.123000", userId]);
    const insertion = target.queries[3]!;
    expect(insertion.sql).toContain("INET6_NTOA(INET6_ATON(?))");
    expect(insertion.sql).toContain("`created_at`");
    expect(insertion.parameters).toEqual([
      transactionTime,
      "2026-09-08 01:32:03.123000",
      adminId,
      requestedIp,
      hashVerificationToken(token),
      userId,
    ]);
    const log = target.queries[4]!;
    expect(log.parameters).toContain('{"expires_at":"2026-09-08T01:32:03.123Z"}');
    expect(log.parameters).toContain(null);
    expect(log.parameters).toContain("admin.user.password_reset_issued");
    expect(log.parameters).not.toContain(email);
    expect(log.parameters).not.toContain(requestedIp);
    expect(log.parameters.some(Buffer.isBuffer)).toBe(false);
    expect(target.queries.some((query) => query.parameters.includes(token))).toBe(false);
    expect(target.queries.map(({ sql }) => sql).join("\n")).not.toMatch(
      /password_hash|teacher_profiles|sessions/u,
    );
    expect(target.events).toContain("COMMIT");
  });

  it("refuses to issue reset links for inactive native accounts", async () => {
    const target = boundary([clock(), selectUser([user({ is_active: 0 })])]);
    await expect(issueReset(target)).rejects.toMatchObject({
      response: { code: "ADMIN_USER_ACCOUNT_INACTIVE" },
    });
    expect(mutations(target)).toHaveLength(0);
    expect(target.events).not.toContain("COMMIT");
  });

  it.each(["invalidation", "insert", "audit", "commit"] as const)(
    "does not return a reset link after %s failure",
    async (stage) => {
      const failure = new Error("synthetic write failure");
      const steps: Step[] = [clock(), selectUser()];
      steps.push(
        stage === "invalidation"
          ? { ...update("password_reset_tokens"), error: failure }
          : update("password_reset_tokens"),
      );
      if (stage !== "invalidation")
        steps.push(
          stage === "insert"
            ? { ...insert("password_reset_tokens"), error: failure }
            : insert("password_reset_tokens"),
        );
      if (stage === "audit" || stage === "commit")
        steps.push(stage === "audit" ? { ...audit(), error: failure } : audit());
      const target = boundary(steps);
      if (stage === "commit") target.state.commitError = failure;
      await expect(issueReset(target)).rejects.toBe(failure);
      if (stage !== "commit") expect(target.events).not.toContain("COMMIT");
    },
  );
});

describe("PostgreSQL administrator user write compatibility", () => {
  const pgUser = (overrides: Row = {}): Row =>
    user({
      is_active: true,
      created_at: now,
      updated_at: now,
      signup_approved_at: now,
      ...overrides,
    });

  it("keeps UPDATE RETURNING, Date bindings and structured audit JSON", async () => {
    const target = boundary(
      [
        selectUser([pgUser()]),
        teacherCheck(),
        { ...update("users"), rows: [pgUser({ is_active: false })] },
        update("sessions"),
        audit(),
      ],
      "postgres",
    );
    const result = await disable(target);
    expect(result.user.is_active).toBe(false);
    expect(result.user.updated_at).toEqual(now);
    expect(target.queries[2]!.sql).toContain("returning");
    expect(target.queries[2]!.parameters).toEqual([false, now, userId]);
    expect(target.queries[4]!.parameters).toContainEqual({ is_active: false });
    expect(target.queries[4]!.parameters).toContainEqual({ is_active: true });
    expect(target.events).toEqual(["begin", "commit"]);
  });

  it("keeps the existing PG reset insert defaults and app-clock expiration", async () => {
    const target = boundary(
      [
        selectUser([pgUser()]),
        update("password_reset_tokens"),
        insert("password_reset_tokens"),
        audit(),
      ],
      "postgres",
    );
    const result = await issueReset(target);
    expect(result.expires_at).toBe("2026-09-08T01:32:03.123Z");
    expect(target.queries[2]!.sql).not.toMatch(/created_at|INET6_/u);
    expect(target.queries[2]!.parameters[0]).toEqual(new Date(result.expires_at));
    expect(target.queries[2]!.parameters).toContain(requestedIp);
    expect(target.queries[3]!.parameters).toContainEqual({ expires_at: result.expires_at });
    expect(target.events).toEqual(["begin", "commit"]);
  });
});
