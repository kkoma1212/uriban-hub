import {
  createMariaDbDatabase,
  securityAuditDeduplicationScope,
  serializeSecurityAuditEvent,
  type DB,
  type MariaDbWorkerAuditLockManager,
  type PreparedWorkerAuditLock,
  type SecurityAuditEvent,
} from "@classhub/db";
import { Kysely, PostgresDialect, type PostgresPoolClient } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MariaDbSecurityAuditStore } from "./mariadb-security-audit-store.js";
import { PostgresSecurityAuditStore } from "./postgres-security-audit-store.js";
import { SecurityAuditWorker, type SecurityAuditRedisClient } from "./security-audit-worker.js";
import type { SecurityAuditStore } from "./security-audit-store.js";

const now = new Date("2026-09-07T12:30:45.123Z");
function event(overrides: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    version: 1,
    event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    occurred_at: now.toISOString(),
    actor_user_id: null,
    actor_class_id: null,
    target_class_id: null,
    actor_email_hmac: "A".repeat(43),
    hmac_key_version: "test-v1",
    actor_ip: "2001:0DB8:0:0:0:0:0:1",
    action: "auth.password_reset_requested",
    resource: "password_reset",
    sanitized_path: "/api/v1/auth/password-reset-requests",
    method: "POST",
    deny_reason: null,
    failure_code: null,
    user_agent: "synthetic-worker-qa",
    ...overrides,
  };
}
function scoped(action: "authz.denied" | "auth.csrf_failed" | "rate_limited" = "authz.denied") {
  return event({
    action,
    actor_email_hmac: null,
    hmac_key_version: null,
    actor_user_id: "9223372036854775807",
    target_class_id: "9007199254740993",
    resource: action === "auth.csrf_failed" ? "request" : "classes",
    deny_reason:
      action === "auth.csrf_failed"
        ? "origin_invalid"
        : action === "rate_limited"
          ? "rate_limited"
          : "role_insufficient",
  });
}
const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});
const native = (errno: unknown = 1062, sqlState = "23000") =>
  Object.assign(new Error("private native SQL and credentials"), { errno, sqlState });
type Statement = { sql: string; parameters: readonly unknown[] };
function fixture(kind: "maria" | "postgres" = "maria") {
  const statements: Statement[] = [],
    order: string[] = [];
  const state = {
    exact: false,
    match: false,
    inserts: 0,
    insertError: undefined as unknown,
    commitError: undefined as unknown,
    rollbackError: undefined as unknown,
    queryError: undefined as unknown,
  };
  function execute(statement: string, parameters: readonly unknown[] = []) {
    const text = statement.replace(/\s+/gu, " ").trim();
    statements.push({ sql: text, parameters });
    order.push(text);
    if (/^INSERT\b/iu.test(text)) {
      state.inserts++;
      if (state.insertError) throw state.insertError;
      return [];
    }
    if (/^COMMIT$/iu.test(text) && state.commitError) throw state.commitError;
    if (/^ROLLBACK$/iu.test(text) && state.inserts && state.rollbackError)
      throw state.rollbackError;
    if (/FROM ["`]?security_audit_logs/iu.test(text)) {
      if (state.queryError) throw state.queryError;
      const exact = /WHERE ["`]?event_id["`]? =/iu.test(text);
      return (exact ? state.exact : state.match) ? [{ event_id: event().event_id }] : [];
    }
    return [];
  }
  const database =
    kind === "maria"
      ? createMariaDbDatabase<DB>(
          () => ({
            getConnection(callback) {
              callback(null, {
                query(statement, parameters, done) {
                  try {
                    done(null, execute(statement, parameters));
                  } catch (error) {
                    done(error, undefined);
                  }
                },
                release() {},
                destroy() {},
              });
            },
            end(callback) {
              callback(null);
            },
          }),
          {
            host: "qa.invalid",
            database: "qa",
            user: "qa_worker",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----",
          },
        )
      : new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: {
              options: {},
              async connect() {
                return {
                  async query(statement: string, parameters?: readonly unknown[]) {
                    const rows = execute(statement, parameters);
                    return { rows, rowCount: rows.length, command: "SELECT" };
                  },
                  release() {},
                } as unknown as PostgresPoolClient;
              },
              async end() {},
            },
          }),
        });
  databases.push(database);
  const handle = {} as PreparedWorkerAuditLock;
  const locks: MariaDbWorkerAuditLockManager<DB> = {
    prepare: vi.fn(async (db, identity) => {
      expect(db.isTransaction).toBe(false);
      expect(identity).toBeTypeOf("string");
      order.push("prepare");
      return handle;
    }),
    acquire: vi.fn(async (transaction, actual) => {
      expect(transaction.isTransaction).toBe(true);
      expect(actual).toBe(handle);
      order.push("acquire");
    }),
  };
  return {
    database,
    locks,
    statements,
    order,
    state,
    maria: new MariaDbSecurityAuditStore(database, locks),
    postgres: new PostgresSecurityAuditStore(database),
  };
}
const exactQueries = (h: ReturnType<typeof fixture>) =>
  h.statements.filter(({ sql }) => /WHERE ["`]?event_id["`]? =/iu.test(sql));
const matchQuery = (h: ReturnType<typeof fixture>) =>
  h.statements.find(({ sql }) => /created_at.*>/iu.test(sql))!;
async function safeRejected(operation: Promise<unknown>) {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    name: "MariaDbSecurityAuditStoreError",
    code: "MARIADB_SECURITY_AUDIT_STORE_FAILED",
  });
  expect(error).not.toHaveProperty("cause");
  expect(String(error) + JSON.stringify(error)).not.toMatch(
    /private|credentials|INSERT|SELECT|aaaaaaaa|test-v1/iu,
  );
  return error;
}

describe("extracted PostgreSQL security audit persistence", () => {
  it("preserves the ordinary event insert, timestamp Date and event_id-only ON CONFLICT", async () => {
    const h = fixture("postgres"),
      input = event();
    await h.postgres.insertEvent(input);
    expect(h.statements).toHaveLength(1);
    expect(h.statements[0]!.sql).toContain('on conflict ("event_id") do nothing');
    expect(h.statements[0]!.parameters).toContainEqual(now);
    expect(h.statements[0]!.parameters).toContain(input.actor_email_hmac);
  });
  it("preserves advisory transaction locking and strict inet/null-safe scope query", async () => {
    const h = fixture("postgres"),
      input = scoped();
    await h.postgres.insertEvent(input);
    expect(h.order[0]).toBe("begin");
    expect(h.order[1]).toContain("pg_advisory_xact_lock( hashtextextended(");
    expect(h.statements[1]!.parameters).toEqual([securityAuditDeduplicationScope(input)!.identity]);
    const match = matchQuery(h);
    expect(match.sql).toContain("actor_ip IS NOT DISTINCT FROM");
    expect(match.sql).toContain("::inet");
    expect(match.parameters).toContainEqual(new Date(now.getTime() - 60_000));
    expect(match.parameters).toContainEqual(new Date(now.getTime() + 60_000));
    expect(h.order.at(-1)).toBe("commit");
  });
  it("checks exact event before a representative while retaining the same scoped lock", async () => {
    const h = fixture("postgres");
    h.state.exact = true;
    expect(await h.postgres.isEventAlreadyHandled(scoped())).toBe(true);
    expect(exactQueries(h)).toHaveLength(1);
    expect(h.statements.some(({ sql }) => sql.includes("created_at"))).toBe(false);
    expect(h.order[1]).toContain("pg_advisory_xact_lock");
  });
});

describe("MariaDB security audit persistence", () => {
  it.each([
    [1452, "23000", "reference_missing"],
    [4025, "23000", "constraint_rejected"],
    [1142, "42000", "permission_denied"],
    [1213, "40001", "contention"],
  ] as const)(
    "preserves only the safe category of native error %s",
    async (errno, sqlState, failureReason) => {
      const h = fixture();
      h.state.insertError = native(errno, sqlState);
      expect(await safeRejected(h.maria.insertEvent(event()))).toMatchObject({ failureReason });
    },
  );

  it("keeps final lookup failures sanitized with their safe category", async () => {
    const h = fixture();
    h.state.queryError = native(1142, "42000");
    expect(await safeRejected(h.maria.isEventAlreadyHandled(event()))).toMatchObject({
      failureReason: "permission_denied",
    });
  });
  it("retains UUID/HMAC/large IDs and binds normalized inet plus exact DB6 event time", async () => {
    const h = fixture(),
      input = event();
    await h.maria.insertEvent(input);
    const insert = h.statements.find(({ sql }) => /^INSERT/iu.test(sql))!;
    expect(insert.sql).toContain("INET6_NTOA(INET6_ATON(?))");
    expect(insert.sql).not.toMatch(/IGNORE|ON DUPLICATE/iu);
    expect(insert.parameters).toEqual([
      input.action,
      null,
      input.actor_email_hmac,
      input.actor_ip,
      null,
      "2026-09-07 12:30:45.123000",
      null,
      input.event_id,
      null,
      "test-v1",
      "POST",
      input.request_id,
      input.resource,
      input.sanitized_path,
      null,
      input.user_agent,
    ]);
    expect(h.locks.prepare).not.toHaveBeenCalled();
    expect(h.order).toContain("START TRANSACTION READ WRITE");
    expect(h.order).toContain("COMMIT");
  });
  it.each(["authz.denied", "auth.csrf_failed", "rate_limited"] as const)(
    "preserves %s exact scope columns and symmetric open time window",
    async (action) => {
      const h = fixture(),
        input = scoped(action);
      await h.maria.insertEvent(input);
      expect(h.order.indexOf("prepare")).toBeLessThan(
        h.order.indexOf("START TRANSACTION READ WRITE"),
      );
      expect(h.order.indexOf("acquire")).toBeGreaterThan(
        h.order.indexOf("START TRANSACTION READ WRITE"),
      );
      const match = matchQuery(h),
        window = action === "rate_limited" ? 300_000 : 60_000;
      expect(match.sql).toContain("BINARY action = BINARY ?");
      expect(match.sql).toContain("actor_ip <=> INET6_NTOA(INET6_ATON(?))");
      expect(match.sql).toContain("BINARY deny_reason <=> BINARY ?");
      expect(match.sql).not.toMatch(/created_at\s*(?:>=|<=|BETWEEN)/iu);
      expect(match.parameters).toContain(
        new Date(now.getTime() - window).toISOString().replace("T", " ").replace("Z", "000"),
      );
      expect(match.parameters).toContain(
        new Date(now.getTime() + window).toISOString().replace("T", " ").replace("Z", "000"),
      );
      expect(match.sql.includes("actor_user_id <=>")).toBe(action !== "rate_limited");
      expect(match.sql.includes("target_class_id <=>")).toBe(action !== "rate_limited");
      expect(match.sql.includes("BINARY resource <=>")).toBe(action === "authz.denied");
      expect(match.sql.includes("BINARY method = BINARY")).toBe(action !== "authz.denied");
      expect(match.sql.includes("BINARY sanitized_path = BINARY")).toBe(action !== "authz.denied");
      if (action !== "rate_limited") expect(match.parameters).toContain("9223372036854775807");
    },
  );
  it("suppresses a scope representative without an INSERT and preserves null-safe fields", async () => {
    const h = fixture();
    h.state.match = true;
    await h.maria.insertEvent(scoped());
    expect(h.state.inserts).toBe(0);
    expect(h.order).toContain("COMMIT");
    expect(h.locks.prepare).toHaveBeenCalledOnce();
  });
  it("checks ordinary exact IDs without locks or a transaction", async () => {
    const h = fixture();
    expect(await h.maria.isEventAlreadyHandled(event())).toBe(false);
    h.state.exact = true;
    expect(await h.maria.isEventAlreadyHandled(event())).toBe(true);
    expect(h.locks.prepare).not.toHaveBeenCalled();
    expect(h.order).not.toContain("START TRANSACTION READ WRITE");
  });
  it("checks exact ID before scoped representative inside a prepared locked transaction", async () => {
    const h = fixture();
    h.state.exact = true;
    expect(await h.maria.isEventAlreadyHandled(scoped())).toBe(true);
    expect(exactQueries(h)).toHaveLength(1);
    expect(matchQuery(h)).toBeUndefined();
    h.state.exact = false;
    h.state.match = true;
    expect(await h.maria.isEventAlreadyHandled(scoped())).toBe(true);
    h.state.match = false;
    expect(await h.maria.isEventAlreadyHandled(scoped())).toBe(false);
    expect(h.locks.acquire).toHaveBeenCalledTimes(3);
  });
  it("accepts exact INSERT 1062 only after whole rollback then exact event lookup", async () => {
    const h = fixture();
    h.state.insertError = native();
    h.state.exact = true;
    await h.maria.insertEvent(event());
    const insert = h.order.findIndex((entry) => /^INSERT/iu.test(entry));
    const exact = h.order.findIndex((entry) => /WHERE event_id =/iu.test(entry));
    expect(h.order.slice(insert + 1, exact)).toContain("ROLLBACK");
    expect(h.order).not.toContain("COMMIT");
    expect(h.state.inserts).toBe(1);
    expect(exactQueries(h)).toHaveLength(1);
  });
  it("does not acknowledge a duplicate when exact event ID is absent", async () => {
    const h = fixture();
    h.state.insertError = native();
    await safeRejected(h.maria.insertEvent(event()));
    expect(exactQueries(h)).toHaveLength(1);
  });
  it.each([
    [4025, "23000"],
    [1452, "23000"],
    [1213, "40001"],
    ["1062", "23000"],
    [1062, "HY000"],
  ])("does not retry or hide nonmatching native INSERT failure %s/%s", async (errno, sqlState) => {
    const h = fixture();
    h.state.insertError = native(errno, String(sqlState));
    h.state.exact = true;
    await safeRejected(h.maria.insertEvent(event()));
    expect(exactQueries(h)).toHaveLength(0);
    expect(h.state.inserts).toBe(1);
  });
  it("does not confuse lock/query 1062 with an event conflict", async () => {
    const h = fixture();
    h.state.queryError = native();
    h.state.exact = true;
    await safeRejected(h.maria.insertEvent(scoped()));
    expect(h.state.inserts).toBe(0);
    expect(exactQueries(h)).toHaveLength(0);
  });
  it("does not acknowledge after rollback or COMMIT failure", async () => {
    const h = fixture();
    h.state.insertError = native();
    h.state.exact = true;
    h.state.rollbackError = new Error("private rollback failure");
    await safeRejected(h.maria.insertEvent(event()));
    expect(exactQueries(h)).toHaveLength(0);
    const committed = fixture();
    committed.state.commitError = new Error("private COMMIT acknowledgement loss");
    await safeRejected(committed.maria.insertEvent(event()));
    expect(exactQueries(committed)).toHaveLength(0);
    expect(committed.state.inserts).toBe(1);
  });
  it.each([
    { event_id: "invalid" },
    { actor_ip: "invalid-private-address" },
    { actor_email_hmac: "private-hmac" },
    { occurred_at: "2026-09-07T12:30:45Z" },
  ])(
    "validates canonical events before database access without exposing rejected values",
    async (override) => {
      const h = fixture();
      await safeRejected(h.maria.insertEvent(event(override)));
      expect(h.statements).toHaveLength(0);
      expect(h.locks.prepare).not.toHaveBeenCalled();
    },
  );
});

function workerFixture(events: SecurityAuditEvent[], persistence?: SecurityAuditStore) {
  const h = fixture("postgres");
  const messages = events.map((input, index) => ({
    id: `${index + 1}-0`,
    message: {
      event: serializeSecurityAuditEvent(input),
      event_id: input.event_id,
      occurred_at: input.occurred_at,
    },
  }));
  const redis = {
    xGroupCreate: vi.fn(async () => "OK"),
    xAutoClaim: vi.fn(async () => ({ messages: [], nextId: "0-0" })),
    xReadGroup: vi.fn(async () => [{ messages }]),
    eval: vi.fn(async (_script: string, input: { keys: string[] }) =>
      input.keys.length === 1 ? 1 : input.keys.length === 2 ? ["0", 0] : [1, 1],
    ),
  };
  const logger = { error: vi.fn() };
  const worker = new SecurityAuditWorker(
    redis as unknown as SecurityAuditRedisClient,
    h.database,
    logger,
    {
      consumerName: "synthetic",
      now: () => new Date(now),
      ...(persistence ? { persistence } : {}),
    },
  );
  return { ...h, worker, redis, logger };
}
describe("SecurityAuditWorker optional persistence boundary", () => {
  it("does not misclassify Redis acknowledgement failures as database failures", async () => {
    const h = workerFixture(
      [event({ occurred_at: new Date(now.getTime() - 86_400_000).toISOString() })],
      {
        insertEvent: vi.fn(async () => {}),
        isEventAlreadyHandled: vi.fn(async () => true),
      },
    );
    h.redis.eval.mockImplementation(async (_script, options) => {
      if (options.keys.length === 1)
        throw Object.assign(new Error("private Redis error"), { code: "ECONNRESET" });
      return options.keys.length === 2 ? ["0", 0] : [1, 0];
    });
    expect((await h.worker.runOnce()).databaseFailures).toBeUndefined();
  });
  it("keeps the existing constructor and PostgreSQL default", async () => {
    const h = workerFixture([event()]);
    expect(await h.worker.runOnce()).toEqual({
      acknowledged: 1,
      deadLettered: 0,
      deferred: 0,
      invalid: 0,
    });
    expect(h.statements[0]!.sql).toContain('on conflict ("event_id") do nothing');
  });
  it("acknowledges only after injected persistence resolves", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const persistence = {
      insertEvent: vi.fn(() => pending),
      isEventAlreadyHandled: vi.fn(async () => false),
    };
    const h = workerFixture([event()], persistence),
      run = h.worker.runOnce();
    await vi.waitFor(() => expect(persistence.insertEvent).toHaveBeenCalledOnce());
    expect(h.redis.eval.mock.calls.filter(([, options]) => options.keys.length === 1)).toHaveLength(
      0,
    );
    resolve();
    expect((await run).acknowledged).toBe(1);
    expect(h.statements).toHaveLength(0);
  });
  it("defers failed persistence without acknowledging or leaking its error", async () => {
    const h = workerFixture([event()], {
      insertEvent: vi.fn(async () => {
        throw new Error("private database failure");
      }),
      isEventAlreadyHandled: vi.fn(async () => false),
    });
    expect(await h.worker.runOnce()).toEqual({
      acknowledged: 0,
      deadLettered: 0,
      deferred: 1,
      invalid: 0,
      databaseFailures: { unknown: 1 },
    });
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.redis.eval.mock.calls.filter(([, options]) => options.keys.length === 1)).toHaveLength(
      0,
    );
  });
  it.each([true, false, "failed"])(
    "keeps the exact 24-hour final lookup/ACK/DLQ policy for %s",
    async (handled) => {
      const persistence = {
        insertEvent: vi.fn(async () => {}),
        isEventAlreadyHandled: vi.fn(async () => {
          if (handled === "failed") throw new Error("private database failure");
          return handled === true;
        }),
      };
      const h = workerFixture(
        [event({ occurred_at: new Date(now.getTime() - 86_400_000).toISOString() })],
        persistence,
      );
      expect(await h.worker.runOnce()).toEqual({
        acknowledged: handled === true ? 1 : 0,
        deadLettered: handled === true ? 0 : 1,
        deferred: 0,
        invalid: 0,
        ...(handled === "failed" ? { databaseFailures: { unknown: 1 } } : {}),
      });
      expect(persistence.insertEvent).not.toHaveBeenCalled();
      expect(persistence.isEventAlreadyHandled).toHaveBeenCalledOnce();
      expect(
        JSON.stringify(h.redis.eval.mock.calls) + JSON.stringify(h.logger.error.mock.calls),
      ).not.toContain("private database");
    },
  );
});
