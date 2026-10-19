import { createMariaDbDatabase, type AdminRole, type DB } from "@classhub/db";
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
import { AdminAccountsService } from "./admin-accounts.service.js";

const passwords = vi.hoisted(() => ({
  hash: vi.fn<(_password: string) => Promise<string>>(async () => "synthetic-password-hash"),
}));
vi.mock("@classhub/db", async (original) => ({
  ...(await original<typeof import("@classhub/db")>()),
  hashPassword: passwords.hash,
}));

const anchorId = "9007199254740993";
const actorId = "9007199254740995";
const accountId = "9007199254740997";
const requestId = "429c4c74-1c42-44e2-ac04-45a902a670f4";
const now = new Date("2026-09-08T04:05:06.123Z");
const nativeNow = "2026-09-08 04:05:06.123000";
const dbCreatedAt = "2026-09-01 01:02:03.456789";
const email = "managed@example.invalid";
const reason = "본인 확인 후 관리자 변경";
type Row = Record<string, unknown>;
type Query = { sql: string; parameters: readonly unknown[] };
type Step = {
  sql: RegExp;
  rows?: Row[];
  affectedRows?: number;
  insertId?: string | number;
  error?: unknown;
};
const queryFor = (verb: string, table: string): Step => ({
  sql: new RegExp(`^${verb} .*?[\x60"]${table}[\x60"]`, "u"),
});
const selectAccount = (rows: Row[] = [{ id: accountId, status: "active" }]): Step => ({
  ...queryFor("select", "admin_accounts"),
  rows,
});
const roles = (values: AdminRole[] = ["super_admin"]): Step => ({
  ...queryFor("select", "admin_account_roles"),
  rows: values.map((role) => ({ role })),
});
const viable = (present = true): Step => ({
  ...queryFor("select", "admin_account_roles"),
  rows: present ? [{ id: actorId }] : [],
});
const anchor = (): Step => ({
  sql: /^select `id` from `admin_accounts` order by `id` asc limit \? for update$/u,
  rows: [{ id: anchorId }],
});
const pgLock = (): Step => ({ sql: /^SELECT pg_advisory_xact_lock\(hashtextextended\(/u });
const insert = (table: string): Step => queryFor("insert into", table);
const update = (table: string): Step => queryFor("update", table);
const audit = (): Step => insert("admin_operation_audit_logs");
const nativeDuplicate = () =>
  Object.assign(new Error("synthetic duplicate"), {
    errno: 1062,
    sqlState: "23000",
    code: "ER_DUP_ENTRY",
  });
const resources: Array<{ database: Kysely<DB>; steps: Step[] }> = [];

// Real MySQL compilation and guarded-driver lifecycle with an in-memory callback pool.
// These are caller boundary tests; actual database concurrency/ACLs require integration QA.
function boundary(
  steps: Step[],
  engine: "mariadb" | "postgres" = "mariadb",
  extensions: string | undefined = undefined,
) {
  const queries: Query[] = [];
  const events: string[] = [];
  const state: { commitError?: Error } = {};
  function next(query: Query): Step {
    events.push(`query:${queries.length}`);
    queries.push(query);
    const step = steps.shift();
    expect(step, "unexpected SQL").toBeDefined();
    expect(query.sql).toMatch(step!.sql);
    if (engine === "mariadb") {
      expect(query.sql).not.toMatch(
        /\breturning\b|::|pg_advisory|GET_LOCK|transaction_lock_keys/iu,
      );
      expect(
        query.parameters.some(
          (value) => typeof value === "object" && value !== null && !Buffer.isBuffer(value),
        ),
      ).toBe(false);
    }
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
      if (state.commitError) throw state.commitError;
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
            getConnection(callback) {
              events.push("acquire");
              callback(null, {
                query(statement, parameters, reply) {
                  if (!/^(select|insert|update|delete)\b/iu.test(statement)) {
                    events.push(statement);
                    return reply(statement === "COMMIT" ? state.commitError : null, {
                      affectedRows: 0,
                      insertId: 0,
                    });
                  }
                  const step = next({ sql: statement, parameters });
                  reply(
                    step.error ?? null,
                    step.rows ?? {
                      affectedRows: step.affectedRows ?? 1,
                      insertId: step.insertId ?? 0,
                    },
                  );
                },
                release: () => events.push("release"),
                destroy: () => events.push("destroy"),
              });
            },
            end: (callback) => callback(null),
          }),
          {
            host: "admin-accounts.test.invalid",
            database: "synthetic",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
          },
        );
  resources.push({ database, steps });
  const config = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: engine,
    ...(extensions === undefined ? {} : { AUTH_DATABASE_EXTENSIONS: extensions }),
  });
  const securityMailer = {
    sendSecurityChange: vi.fn(async () => {
      events.push("NOTICE");
      return "accepted" as const;
    }),
  };
  return {
    database,
    service: new AdminAccountsService(database, config, securityMailer),
    queries,
    events,
    state,
    securityMailer,
  };
}
type Harness = ReturnType<typeof boundary>;
type Action = "suspend" | "revoke" | "activate" | "roles" | "credentials" | "mfa";
const actions: Action[] = ["suspend", "revoke", "activate", "roles", "credentials", "mfa"];
const mutations = (h: Harness) =>
  h.queries.filter((query) => /^(insert|update|delete)\b/u.test(query.sql));
const create = (h: Harness) =>
  h.service.create(
    {
      email: "  Managed@Example.invalid  ",
      display_name: "  김관리  ",
      roles: ["support", "account_manager"],
    },
    actorId,
    requestId,
  );
function perform(h: Harness, action: Action, id = accountId) {
  if (action === "roles")
    return h.service.replaceRoles(id, ["support"], reason, actorId, requestId);
  if (action === "credentials") return h.service.resetCredentials(id, reason, actorId, requestId);
  if (action === "mfa") return h.service.resetMfa(id, reason, actorId, requestId);
  const status = action === "suspend" ? "suspended" : action === "revoke" ? "revoked" : "active";
  return h.service.updateStatus(id, status, reason, actorId, requestId);
}
function successfulSteps(
  action: Action,
  engine: "mariadb" | "postgres" = "mariadb",
  passkeys = engine === "postgres",
): Step[] {
  // 총검수 C1-01: 패스키 표가 있으면 초기화 때 패스키·복구 코드도 함께 폐기한다.
  const revokedFactors = passkeys ? [update("admin_passkeys"), update("admin_recovery_codes")] : [];
  const steps = [
    engine === "mariadb" ? anchor() : pgLock(),
    selectAccount([
      {
        id: accountId,
        status: action === "activate" ? "suspended" : "active",
        email_normalized: email,
      },
    ]),
  ];
  if (action === "roles") steps.push(roles());
  if (action !== "activate") steps.push(viable());
  if (action === "roles")
    steps.push(queryFor("delete from", "admin_account_roles"), insert("admin_account_roles"));
  else if (action === "credentials")
    steps.push(
      update("admin_accounts"),
      update("admin_mfa_factors"),
      update("admin_sessions"),
      ...revokedFactors,
    );
  else if (action === "mfa")
    steps.push(
      update("admin_mfa_factors"),
      update("admin_sessions"),
      ...revokedFactors,
      update("admin_accounts"),
    );
  else {
    const row = {
      id: accountId,
      status: action === "activate" ? "active" : action === "revoke" ? "revoked" : "suspended",
      updated_at: engine === "mariadb" ? nativeNow : now,
    };
    steps.push(
      engine === "mariadb"
        ? update("admin_accounts")
        : { ...update("admin_accounts"), rows: [row] },
    );
    if (engine === "mariadb") steps.push(selectAccount([row]));
    if (action !== "activate") steps.push(update("admin_sessions"));
    if (action === "revoke") steps.push(update("admin_mfa_factors"));
  }
  steps.push(audit());
  return steps;
}
function createSteps(): Step[] {
  return [
    selectAccount([]),
    { ...insert("admin_accounts"), insertId: accountId },
    selectAccount([{ id: accountId, status: "pending_mfa" }]),
    insert("admin_account_roles"),
    audit(),
  ];
}
function assertPrivateAudit(h: Harness, action: string) {
  const log = h.queries.find(({ sql }) => /insert into [`"]admin_operation_audit_logs/u.test(sql))!;
  expect(log.parameters).toContain(action);
  expect(log.parameters).toContain(actorId);
  expect(log.parameters).toContain(accountId);
  expect(log.parameters).toContain(requestId);
  expect(log.sql).not.toMatch(/event_id|created_at|password|secret|key_version/u);
  expect(log.parameters).not.toContain(email);
  expect(log.parameters).not.toContain("synthetic-password-hash");
  for (const [password] of passwords.hash.mock.calls)
    expect(log.parameters).not.toContain(password);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const { database, steps } of resources.splice(0)) {
    expect(steps).toHaveLength(0);
    await database.destroy();
  }
  vi.clearAllMocks();
});

describe("MariaDB administrator account list and creation", () => {
  it("rejects unsupported engines before SQL", () => {
    const h = boundary([]);
    const config = new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<
      AppEnvironment,
      true
    >;
    expect(() => new AdminAccountsService(h.database, config)).toThrow(
      "Unsupported database engine",
    );
    expect(h.events).toHaveLength(0);
  });

  it("decodes lossless IDs and native DB6 dates, joins roles and exposes no credentials", async () => {
    const rows = [
      {
        id: accountId,
        email_normalized: email,
        display_name: "관리자",
        status: "active",
        last_login_at: nativeNow,
        created_at: dbCreatedAt,
        updated_at: nativeNow,
      },
      {
        id: anchorId,
        email_normalized: "other@example.invalid",
        display_name: "다른 관리자",
        status: "pending_mfa",
        last_login_at: null,
        created_at: dbCreatedAt,
        updated_at: nativeNow,
      },
    ];
    const h = boundary([
      selectAccount(rows),
      {
        ...roles(),
        rows: [
          { admin_account_id: accountId, role: "support" },
          { admin_account_id: accountId, role: "account_manager" },
        ],
      },
    ]);
    const result = await h.service.list();
    expect(result.truncated).toBe(false);
    expect(result.accounts[0]).toEqual({
      id: accountId,
      email,
      display_name: "관리자",
      status: "active",
      roles: ["support", "account_manager"],
      last_login_at: now,
      created_at: new Date("2026-09-01T01:02:03.456Z"),
      updated_at: now,
    });
    expect(result.accounts[1]).toMatchObject({ id: anchorId, roles: [], last_login_at: null });
    expect(h.queries[0]!.sql).toContain(
      "order by `account`.`created_at` desc, `account`.`id` desc limit ?",
    );
    expect(h.queries[0]!.parameters).toEqual([201]);
    expect(h.queries[1]!.parameters).toEqual([accountId, anchorId]);
    expect(h.queries.map(({ sql }) => sql).join("\n")).not.toMatch(
      /password|secret|key_version|session_hash/u,
    );
  });

  it("keeps the 200+1 list cap and avoids a roles query for an empty list", async () => {
    const row = {
      email_normalized: email,
      display_name: "관리자",
      status: "active",
      last_login_at: null,
      created_at: dbCreatedAt,
      updated_at: nativeNow,
    };
    const h = boundary([
      selectAccount(
        Array.from({ length: 201 }, (_, index) => ({
          ...row,
          id: String(BigInt(accountId) + BigInt(index)),
        })),
      ),
      roles([]),
    ]);
    expect(await h.service.list()).toMatchObject({ truncated: true, accounts: expect.any(Array) });
    expect(h.queries[1]!.parameters).toHaveLength(200);
    const empty = boundary([selectAccount([])]);
    expect(await empty.service.list()).toEqual({ truncated: false, accounts: [] });
  });

  it.each([9007199254740992, "9223372036854775808"])(
    "fails closed on a malformed native ID %s",
    async (id) => {
      const h = boundary([selectAccount([{ id }])]);
      await expect(h.service.list()).rejects.toThrow("Invalid MariaDB application value.");
    },
  );

  it("rejects malformed DB6 login dates instead of emitting an invalid response", async () => {
    const h = boundary([
      selectAccount([{ id: accountId, last_login_at: "2026-09-08 04:05:06.123" }]),
    ]);
    await expect(h.service.list()).rejects.toThrow("Invalid MariaDB application value.");
  });

  it("creates a normalized pending-MFA account using its insert ID and returns the password only after commit", async () => {
    const h = boundary(createSteps());
    const result = await create(h);
    expect(result).toEqual({
      account: { id: accountId, roles: ["account_manager", "support"], status: "pending_mfa" },
      created: true,
      initial_password: expect.stringMatching(/^A1-[A-Za-z0-9_-]{32}$/u),
    });
    expect(passwords.hash).toHaveBeenCalledWith(result.initial_password);
    const insertion = h.queries[1]!;
    expect(insertion.parameters).toEqual([
      actorId,
      "김관리",
      email,
      "synthetic-password-hash",
      "nfc_v1",
    ]);
    expect(insertion.sql).not.toMatch(
      /created_at|updated_at|password_last_changed_at|created_by_operator_id/u,
    );
    expect(h.queries[2]!.parameters).toEqual([accountId]);
    expect(h.queries[3]!.parameters).toEqual([
      accountId,
      actorId,
      "account_manager",
      accountId,
      actorId,
      "support",
    ]);
    expect(h.queries[4]!.parameters).toContain(
      '{"roles":["account_manager","support"],"status":"pending_mfa"}',
    );
    expect(h.queries[4]!.parameters).toContain(null);
    expect(h.queries.some(({ parameters }) => parameters.includes(result.initial_password))).toBe(
      false,
    );
    assertPrivateAudit(h, "admin.account.created");
    expect(h.events).toContain("COMMIT");
  });

  it.each(["pending_mfa", "active"])(
    "returns no password and performs no writes for an existing %s account",
    async (status) => {
      const h = boundary([
        selectAccount([{ id: accountId, status }]),
        roles(["support", "account_manager"]),
      ]);
      expect(await create(h)).toEqual({
        account: { id: accountId, roles: ["account_manager", "support"], status },
        created: false,
        initial_password: null,
      });
      expect(mutations(h)).toHaveLength(0);
    },
  );

  it.each(["suspended", "revoked"])(
    "rejects a duplicate %s account before role/audit writes",
    async (status) => {
      const h = boundary([selectAccount([{ id: accountId, status }])]);
      await expect(create(h)).rejects.toMatchObject({ message: "ADMIN_ACCOUNT_STATUS_CONFLICT" });
      expect(mutations(h)).toHaveLength(0);
    },
  );

  it("rejects a duplicate whose roles differ", async () => {
    const h = boundary([selectAccount(), roles(["support"])]);
    await expect(create(h)).rejects.toMatchObject({ message: "ADMIN_ACCOUNT_ROLE_CONFLICT" });
    expect(mutations(h)).toHaveLength(0);
  });

  it("rolls back and releases an INSERT collision before locking and checking the winner", async () => {
    const h = boundary([
      selectAccount([]),
      { ...insert("admin_accounts"), error: nativeDuplicate() },
      selectAccount(),
      roles(["support", "account_manager"]),
    ]);
    expect(await create(h)).toMatchObject({ created: false, initial_password: null });
    const failedInsert = h.events.indexOf("query:1");
    const freshSelect = h.events.indexOf("query:2");
    expect(h.events.slice(failedInsert + 1, freshSelect)).toEqual(
      expect.arrayContaining(["ROLLBACK", "release", "acquire", "START TRANSACTION READ WRITE"]),
    );
    expect(h.events.indexOf("release")).toBeLessThan(h.events.lastIndexOf("acquire"));
    expect(h.queries[2]!.sql).toMatch(/for update$/u);
    expect(h.queries[2]!.parameters).toEqual([email]);
    expect(mutations(h)).toHaveLength(1);
  });

  it("does not turn an INSERT collision without a matching email into success", async () => {
    const failure = nativeDuplicate();
    const h = boundary([
      selectAccount([]),
      { ...insert("admin_accounts"), error: failure },
      selectAccount([]),
    ]);
    await expect(create(h)).rejects.toBe(failure);
    expect(h.events).not.toContain("COMMIT");
  });

  it.each([
    { errno: 1062, sqlState: "23000" },
    { errno: 1062, sqlState: "40001", code: "ER_DUP_ENTRY" },
    { errno: 1213, sqlState: "40001", code: "ER_LOCK_DEADLOCK" },
  ])("does not retry malformed or unrelated native INSERT errors (%j)", async (failure) => {
    const h = boundary([selectAccount([]), { ...insert("admin_accounts"), error: failure }]);
    await expect(create(h)).rejects.toBe(failure);
    expect(h.events.filter((event) => event === "acquire")).toHaveLength(1);
  });

  it.each(["roles", "audit", "commit"])(
    "does not retry or return a secret after create %s failure",
    async (stage) => {
      const steps = createSteps();
      const failure = nativeDuplicate();
      if (stage !== "commit") {
        const index = stage === "roles" ? 3 : 4;
        steps[index]!.error = failure;
        steps.splice(index + 1);
      }
      const h = boundary(steps);
      if (stage === "commit") h.state.commitError = failure;
      await expect(create(h)).rejects.toBe(failure);
      expect(h.events.filter((event) => event === "acquire")).toHaveLength(1);
      if (stage !== "commit") expect(h.events).not.toContain("COMMIT");
    },
  );

  it.each([{ insertId: 0 }, { insertId: accountId, affectedRows: 0 }])(
    "rejects incomplete insertion metadata (%j)",
    async (metadata) => {
      const h = boundary([selectAccount([]), { ...insert("admin_accounts"), ...metadata }]);
      await expect(create(h)).rejects.toThrow();
      expect(h.events).not.toContain("COMMIT");
    },
  );
});

describe("MariaDB administrator lifecycle protections", () => {
  it.each(actions)(
    "performs %s under the immutable anchor and target lock with a private atomic audit",
    async (action) => {
      const h = boundary(successfulSteps(action));
      const result = await perform(h, action);
      expect(h.securityMailer.sendSecurityChange).toHaveBeenCalledWith(
        expect.objectContaining({ email, occurredAt: now }),
      );
      expect(h.events.indexOf("NOTICE")).toBeGreaterThan(h.events.indexOf("COMMIT"));
      expect(JSON.stringify(h.securityMailer.sendSecurityChange.mock.calls)).not.toContain(
        "synthetic-password-hash",
      );
      expect(h.queries[0]!.parameters).toEqual([1]);
      expect(h.queries[1]!.sql).toMatch(/where `id` = \? for update$/u);
      expect(h.queries[1]!.parameters).toEqual([accountId]);
      if (action !== "activate") {
        const check = h.queries.find(({ sql }) => sql.includes("inner join `admin_accounts`"))!;
        expect(check.parameters).toEqual(["super_admin", accountId, "active"]);
      }
      const session = h.queries.find(({ sql }) => sql.startsWith("update `admin_sessions`"));
      const factors = h.queries.find(({ sql }) => sql.startsWith("update `admin_mfa_factors`"));
      if (action === "activate" || action === "roles") expect(session).toBeUndefined();
      else {
        expect(session!.parameters).toEqual([nativeNow, accountId]);
        expect(session!.sql).toContain("where `admin_account_id` = ? and `revoked_at` is null");
      }
      if (["revoke", "credentials", "mfa"].includes(action)) {
        expect(factors!.parameters).toEqual(["revoked", nativeNow, accountId]);
        expect(factors!.sql).toContain("where `admin_account_id` = ? and `revoked_at` is null");
        expect(factors!.sql).not.toMatch(/secret|key_version|activated_at|delete/u);
      } else expect(factors).toBeUndefined();
      const event =
        action === "roles"
          ? "roles_changed"
          : action === "credentials"
            ? "credentials_reset"
            : action === "mfa"
              ? "mfa_reset"
              : "status_changed";
      assertPrivateAudit(h, `admin.account.${event}`);
      expect(h.events).toContain("COMMIT");
      if (action === "credentials") {
        expect(result).toMatchObject({
          account_id: accountId,
          status: "pending_mfa",
          initial_password: expect.stringMatching(/^A1-[A-Za-z0-9_-]{32}$/u),
        });
        const change = h.queries.find(({ sql }) => sql.startsWith("update `admin_accounts`"))!;
        expect(change.parameters).toEqual([
          0,
          null,
          "synthetic-password-hash",
          "nfc_v1",
          nativeNow,
          "pending_mfa",
          nativeNow,
          accountId,
        ]);
        expect(passwords.hash).toHaveBeenCalledTimes(1);
      } else {
        expect(result).not.toHaveProperty("initial_password");
        expect(passwords.hash).not.toHaveBeenCalled();
      }
      if (["suspend", "revoke", "activate"].includes(action))
        expect(result).toMatchObject({ account: { id: accountId, updated_at: now } });
      if (action === "roles") {
        expect(result).toEqual({ account: { id: accountId, roles: ["support"] } });
        const deletion = h.queries.find(({ sql }) => sql.startsWith("delete from"))!;
        expect(deletion.parameters).toEqual([accountId]);
        expect(
          h.queries.find(({ sql }) => sql.startsWith("insert into `admin_account_roles`"))!
            .parameters,
        ).toEqual([accountId, actorId, "support"]);
      }
    },
  );

  it.each(["suspend", "revoke", "roles", "credentials", "mfa"] as Action[])(
    "prevents %s from removing the last active super administrator",
    async (action) => {
      const steps = [anchor(), selectAccount()];
      if (action === "roles") steps.push(roles());
      steps.push(viable(false));
      const h = boundary(steps);
      await expect(perform(h, action)).rejects.toMatchObject({
        message: "LAST_SUPER_ADMIN_REQUIRED",
      });
      expect(mutations(h)).toHaveLength(0);
      expect(h.events).not.toContain("COMMIT");
    },
  );

  it.each(["suspend", "revoke"] as const)(
    "rejects self %s before database access",
    async (action) => {
      const h = boundary([]);
      await expect(perform(h, action, actorId)).rejects.toMatchObject({
        message: "ADMIN_CANNOT_DISABLE_SELF",
      });
      expect(h.events).toHaveLength(0);
    },
  );

  it.each(["active", "pending_mfa", "revoked"])("rejects activation from %s", async (status) => {
    const h = boundary([anchor(), selectAccount([{ id: accountId, status }])]);
    await expect(perform(h, "activate")).rejects.toMatchObject({
      message: "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID",
    });
    expect(mutations(h)).toHaveLength(0);
  });

  it.each(["credentials", "mfa"] as const)(
    "preserves suspended/revoked rejection for %s",
    async (action) => {
      for (const status of ["suspended", "revoked"]) {
        const h = boundary([anchor(), selectAccount([{ id: accountId, status }])]);
        await expect(perform(h, action)).rejects.toMatchObject({
          message:
            status === "suspended"
              ? "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID"
              : "ADMIN_ACCOUNT_REVOKED",
        });
        expect(mutations(h)).toHaveLength(0);
      }
    },
  );

  it.each(actions)("rejects missing targets for %s without any writes", async (action) => {
    const h = boundary([anchor(), selectAccount([])]);
    await expect(perform(h, action)).rejects.toMatchObject({ message: "ADMIN_ACCOUNT_NOT_FOUND" });
    expect(mutations(h)).toHaveLength(0);
  });

  it.each(["0", "-1", "01", "1e3", "9223372036854775808"])(
    "rejects invalid target ID %s",
    async (id) => {
      const h = boundary([anchor()]);
      await expect(perform(h, "mfa", id)).rejects.toMatchObject({
        message: "ADMIN_ACCOUNT_NOT_FOUND",
      });
      const credentials = boundary([]);
      await expect(perform(credentials, "credentials", id)).rejects.toMatchObject({
        message: "ADMIN_ACCOUNT_NOT_FOUND",
      });
      expect(credentials.events).toHaveLength(0);
    },
  );

  it("fails closed when the immutable anchor is missing", async () => {
    const h = boundary([{ ...anchor(), rows: [] }]);
    await expect(perform(h, "suspend")).rejects.toThrow();
    expect(mutations(h)).toHaveLength(0);
  });

  it.each(["suspend", "credentials", "mfa"] as Action[])(
    "rejects a zero-row %s account write instead of returning success",
    async (action) => {
      const steps = successfulSteps(action);
      const index = steps.findIndex(({ sql }) => sql.test("update `admin_accounts`"));
      steps[index]!.affectedRows = 0;
      steps.splice(index + 1);
      const h = boundary(steps);
      await expect(perform(h, action)).rejects.toThrow(/Unexpected administrator account/u);
      expect(h.events).not.toContain("COMMIT");
    },
  );

  it.each(actions)("rolls back %s when the required operation audit fails", async (action) => {
    const steps = successfulSteps(action);
    const failure = nativeDuplicate();
    steps.at(-1)!.error = failure;
    const h = boundary(steps);
    await expect(perform(h, action)).rejects.toBe(failure);
    expect(h.events).not.toContain("COMMIT");
    expect(h.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
    expect(h.events.slice(h.events.indexOf("START TRANSACTION READ WRITE") + 1)).toContain(
      "ROLLBACK",
    );
    expect(h.events.filter((event) => event === "acquire")).toHaveLength(1);
  });

  it.each(actions)("returns no success or secret after %s COMMIT failure", async (action) => {
    const h = boundary(successfulSteps(action));
    const failure = new Error("synthetic uncertain commit");
    h.state.commitError = failure;
    await expect(perform(h, action)).rejects.toBe(failure);
    expect(h.events.filter((event) => event === "COMMIT")).toHaveLength(1);
    expect(h.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
    expect(h.events).toContain("destroy");
  });
});

describe("PostgreSQL administrator account compatibility", () => {
  it("does not repeat a roles notice for the same role set", async () => {
    const h = boundary(
      [
        pgLock(),
        selectAccount([{ id: accountId, status: "active", email_normalized: email }]),
        roles(["support"]),
        queryFor("delete from", "admin_account_roles"),
        insert("admin_account_roles"),
        audit(),
      ],
      "postgres",
    );
    await perform(h, "roles");
    expect(h.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
  });
  it("preserves email advisory locking, INSERT RETURNING and database clock defaults", async () => {
    const h = boundary(
      [
        pgLock(),
        selectAccount([]),
        { ...insert("admin_accounts"), rows: [{ id: accountId, status: "pending_mfa" }] },
        insert("admin_account_roles"),
        audit(),
      ],
      "postgres",
    );
    expect(await create(h)).toMatchObject({
      created: true,
      account: { id: accountId, status: "pending_mfa" },
    });
    expect(h.queries[0]!.parameters).toEqual([`admin-account:${email}`]);
    expect(h.queries[2]!.sql).toContain('returning "id", "status"');
    expect(h.queries[2]!.sql).not.toMatch(/created_at|updated_at/u);
    expect(h.queries[4]!.parameters).toContainEqual({
      roles: ["account_manager", "support"],
      status: "pending_mfa",
    });
    expect(h.events).toContain("commit");
  });

  it.each(actions)(
    "preserves %s liveness advisory lock, Date parameters and structured JSON",
    async (action) => {
      const h = boundary(successfulSteps(action, "postgres"), "postgres");
      await perform(h, action);
      expect(h.queries[0]!.parameters).toEqual(["admin-super-admin-liveness"]);
      expect(h.queries.some(({ sql }) => sql.includes("order by"))).toBe(false);
      const writes = mutations(h);
      if (action !== "roles")
        expect(
          writes.some(({ parameters }) =>
            parameters.some((value) => value instanceof Date && value.getTime() === now.getTime()),
          ),
        ).toBe(true);
      expect(h.queries.at(-1)!.parameters).toContainEqual(
        action === "roles"
          ? { roles: ["support"] }
          : {
              status:
                action === "activate"
                  ? "active"
                  : action === "suspend"
                    ? "suspended"
                    : action === "revoke"
                      ? "revoked"
                      : "pending_mfa",
            },
      );
      if (["activate", "suspend", "revoke"].includes(action))
        expect(
          h.queries.some(({ sql }) => sql.includes('returning "id", "status", "updated_at"')),
        ).toBe(true);
      expect(h.events).toContain("commit");
    },
  );

  it("preserves named PostgreSQL duplicate recovery after rollback", async () => {
    const failure = Object.assign(new Error("synthetic PG duplicate"), {
      code: "23505",
      constraint: "admin_accounts_email_normalized_key",
    });
    const h = boundary(
      [
        pgLock(),
        selectAccount([]),
        { ...insert("admin_accounts"), error: failure },
        pgLock(),
        selectAccount(),
        roles(["support", "account_manager"]),
      ],
      "postgres",
    );
    expect(await create(h)).toMatchObject({ created: false, initial_password: null });
    expect(h.events.indexOf("rollback")).toBeLessThan(h.events.indexOf("query:3"));
  });
});

describe("administrator factor reset with passkeys installed (total audit C1-01)", () => {
  it.each(["credentials", "mfa"] as const)(
    "%s reset also revokes passkeys and recovery codes in the same transaction",
    async (action) => {
      const h = boundary(successfulSteps(action, "mariadb", true), "mariadb", "all");
      await perform(h, action);
      const revoked = mutations(h)
        .map(({ sql }) => sql)
        .filter((sql) => /admin_passkeys|admin_recovery_codes/u.test(sql));
      expect(revoked).toHaveLength(2);
      for (const sql of revoked) {
        expect(sql).toMatch(/set `revoked_at` = ?/u);
        expect(sql).toMatch(/`revoked_at` is null/u);
      }
      expect(h.events).toContain("COMMIT");
    },
  );
});
