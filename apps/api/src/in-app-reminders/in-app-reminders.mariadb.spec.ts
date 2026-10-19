import {
  createIdempotencyRequestHash,
  createMariaDbDatabase,
  IdempotencyKeyReusedError,
  type DB,
} from "@classhub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import {
  InAppReminderContentRevisionChangedException,
  InAppReminderNoUnresolvedRecipientsException,
} from "./in-app-reminders.errors.js";
import { InAppRemindersService } from "./in-app-reminders.service.js";
import type { CreateInAppReminderCommand } from "./in-app-reminders.types.js";

const actor = "9007199254740993";
const member = "9007199254740994";
const resource = "9007199254740995";
const classId = "9007199254740996";
const student1 = "9007199254740997";
const student2 = "9007199254740998";
const transactionTime = "2026-09-07 09:00:00.123456";
const wallTime = "2026-09-07 09:00:01.987654";
const context = {
  actorDisplayName: "QA teacher",
  actorMemberId: member,
  classId,
  resourceId: resource,
  contentRevision: "1",
};
const requestHash = createIdempotencyRequestHash({
  body: { content_revision: "1" },
  effectiveClassId: classId,
});
const replay = {
  batch_id: "a65550f1-c6cc-45d8-92ce-de2766ef5ed7",
  cooldown_suppressed_count: 0,
  created_at: "2026-09-07T09:00:00.123Z",
  created_count: 2,
  current_unresolved_count: 2,
  next_available_at: null,
};
type Step = { rows?: Record<string, unknown>[]; error?: unknown };
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];
const clock = () => ({ rows: [{ transaction_time: transactionTime }] });
const noRows = () => ({ rows: [] });
const currentClock = () => ({ rows: [{ now: wallTime }] });
const unresolved = () => ({ rows: [{ member_id: student1 }, { member_id: student2 }] });
const stored = (overrides: Record<string, unknown> = {}) => ({
  rows: [
    {
      request_hash: requestHash,
      response_status: 201,
      response_body_json: JSON.stringify(replay),
      ...overrides,
    },
  ],
});

function boundary(steps: Step[]) {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const events: string[] = [];
  const state: { commitError?: Error } = {};
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection: (callback) =>
        callback(null, {
          query: (statement, parameters, reply) => {
            calls.push({ sql: statement, parameters });
            if (!/^(select|insert|update|delete)\b/iu.test(statement.trimStart()))
              return reply(statement === "COMMIT" ? state.commitError : null, {
                affectedRows: 0,
                insertId: 0,
              });
            events.push(
              statement.includes("api_idempotency_keys") && statement.startsWith("select")
                ? "replay"
                : "sql",
            );
            const step = steps.shift();
            if (!step) return reply(new Error("Unexpected synthetic query"), undefined);
            reply(step.error, step.rows ?? { affectedRows: 1, insertId: 0 });
          },
          release: vi.fn(),
          destroy: vi.fn(),
        }),
      end: (callback) => callback(null),
    }),
    {
      host: "reminder.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  const limiter = {
    consume: vi.fn().mockImplementation(async () => {
      events.push("limiter");
      return { allowed: true };
    }),
  };
  const service = new InAppRemindersService(
    database,
    limiter as never,
    { get: () => "mariadb" } as never,
  );
  const lockContext = vi.fn().mockImplementation(async () => {
    events.push("authorized_and_locked");
    return context;
  });
  const command: CreateInAppReminderCommand = {
    actorUserId: actor,
    contentRevision: "1",
    idempotencyKey: "a65550f1-c6cc-45d8-92ce-de2766ef5ed7",
    lockContext,
    requestId: "b65550f1-c6cc-45d8-92ce-de2766ef5ed7",
    resourceId: resource,
    reminderType: "notice",
  };
  return { database, service, limiter, calls, events, state, steps, command, lockContext };
}
const writes = (target: ReturnType<typeof boundary>) =>
  target.calls.filter((call) => /^\s*(insert|update|delete)\b/iu.test(call.sql));
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  vi.clearAllMocks();
});

describe("MariaDB in-app reminders transaction boundaries", () => {
  it.each(["notice", "supply"] as const)(
    "persists eligible %s recipients, audit and replay together with unchanged public dates",
    async (reminderType) => {
      const target = boundary([
        clock(),
        noRows(),
        {},
        currentClock(),
        unresolved(),
        { rows: [{ member_id: student2, latest_created_at: "2026-09-07 08:00:00.333444" }] },
        {},
        {},
        {},
        {},
      ]);
      const result = await target.service.create({ ...target.command, reminderType });
      expect(result).toEqual({
        batch_id: expect.any(String),
        cooldown_suppressed_count: 1,
        created_at: "2026-09-07T09:00:01.987Z",
        created_count: 1,
        current_unresolved_count: 2,
        next_available_at: "2026-09-08T08:00:00.333Z",
      });
      expect(target.events.indexOf("authorized_and_locked")).toBeLessThan(
        target.events.indexOf("replay"),
      );
      expect(target.events.indexOf("replay")).toBeLessThan(target.events.indexOf("limiter"));
      expect(target.steps).toHaveLength(0);
      expect(target.calls.slice(-2).map((call) => call.sql)).toEqual(["COMMIT", "ROLLBACK"]);
      expect(target.calls.map((call) => call.sql).join("\n")).not.toMatch(
        /::|clock_timestamp|pg_advisory|timestamptz|RETURNING/iu,
      );
      const mutations = writes(target);
      expect(mutations).toHaveLength(5);
      expect(mutations[0]?.parameters).toContain(transactionTime);
      expect(mutations[1]?.parameters).toContain("2026-09-07 09:00:01.987000");
      expect(mutations[2]?.parameters).toContain(student1);
      expect(mutations[2]?.parameters).not.toContain(student2);
      expect(mutations[3]?.parameters).toContain(transactionTime);
      expect(mutations[4]?.parameters).toContain(transactionTime);
      expect(mutations[4]?.parameters).toContain(JSON.stringify(result));
      expect(mutations[4]?.sql).toContain("INTERVAL 24 HOUR");
      expect(
        mutations.every((call) => call.parameters.every((value) => !(value instanceof Date))),
      ).toBe(true);
      expect(target.limiter.consume).toHaveBeenCalledTimes(1);
    },
  );

  it("authorizes before replay and returns stored JSON without consuming Redis after a revision change", async () => {
    const target = boundary([clock(), stored()]);
    target.lockContext.mockResolvedValue({ ...context, contentRevision: "2" });
    await expect(target.service.create(target.command)).resolves.toEqual(replay);
    expect(target.lockContext).toHaveBeenCalledTimes(1);
    expect(target.limiter.consume).not.toHaveBeenCalled();
    expect(writes(target)).toHaveLength(0);
  });

  it("does not disclose a stored response when the locked authorization fails", async () => {
    const target = boundary([clock()]);
    target.lockContext.mockRejectedValue(new Error("access revoked"));
    await expect(target.service.create(target.command)).rejects.toThrow("access revoked");
    expect(target.events).not.toContain("replay");
    expect(target.limiter.consume).not.toHaveBeenCalled();
    expect(target.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rejects a reused key with a different payload before consuming Redis", async () => {
    const target = boundary([clock(), stored({ request_hash: Buffer.alloc(32) })]);
    await expect(target.service.create(target.command)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    expect(target.limiter.consume).not.toHaveBeenCalled();
    expect(writes(target)).toHaveLength(0);
  });

  it("rejects a stale new request before consuming Redis", async () => {
    const target = boundary([clock(), noRows()]);
    target.lockContext.mockResolvedValue({ ...context, contentRevision: "2" });
    await expect(target.service.create(target.command)).rejects.toBeInstanceOf(
      InAppReminderContentRevisionChangedException,
    );
    expect(target.limiter.consume).not.toHaveBeenCalled();
    expect(writes(target)).toHaveLength(0);
  });

  it("fails closed when the technical limiter denies a new request", async () => {
    const target = boundary([clock(), noRows()]);
    target.limiter.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 3 });
    await expect(target.service.create(target.command)).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(writes(target)).toHaveLength(0);
    expect(target.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("rolls back expired-key deletion if every recipient is already resolved", async () => {
    const target = boundary([clock(), noRows(), {}, currentClock(), noRows()]);
    await expect(target.service.create(target.command)).rejects.toBeInstanceOf(
      InAppReminderNoUnresolvedRecipientsException,
    );
    expect(writes(target)).toHaveLength(1);
    expect(target.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("honors each recipient's 24-hour cooldown and emits the earliest availability", async () => {
    const target = boundary([
      clock(),
      noRows(),
      {},
      currentClock(),
      unresolved(),
      {
        rows: [
          { member_id: student1, latest_created_at: "2026-09-07 08:00:00.000000" },
          { member_id: student2, latest_created_at: "2026-09-07 07:00:00.000000" },
        ],
      },
    ]);
    await expect(target.service.create(target.command)).rejects.toMatchObject({
      response: expect.objectContaining({
        details: { next_available_at: "2026-09-08T07:00:00.000Z" },
      }),
    });
    expect(writes(target)).toHaveLength(1);
    expect(target.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it.each(["audit", "idempotency", "commit"])(
    "does not retry Redis or report success after a %s failure",
    async (stage) => {
      const failure = Object.assign(new Error("synthetic write failure"), {
        errno: 1213,
        sqlState: "40001",
      });
      const target = boundary([
        clock(),
        noRows(),
        {},
        currentClock(),
        unresolved(),
        noRows(),
        {},
        {},
        stage === "audit" ? { error: failure } : {},
        stage === "idempotency" ? { error: failure } : {},
      ]);
      if (stage === "commit") target.state.commitError = failure;
      await expect(target.service.create(target.command)).rejects.toThrow();
      expect(target.lockContext).toHaveBeenCalledTimes(1);
      expect(target.limiter.consume).toHaveBeenCalledTimes(1);
      expect(
        target.calls.filter((call) => call.sql === "START TRANSACTION READ WRITE"),
      ).toHaveLength(1);
    },
  );

  it.each(["notice", "supply"] as const)(
    "resolves only matching %s recipients in the caller's transaction",
    async (reminderType) => {
      const target = boundary([{}]);
      await target.database.transaction().execute((tx) =>
        target.service.resolve(tx, {
          classId,
          memberId: student1,
          resourceId: resource,
          contentRevision: "2",
          reminderType,
        }),
      );
      const [mutation] = writes(target);
      expect(mutation?.sql).toContain(`\`batch\`.\`${reminderType}_id\``);
      expect(mutation?.sql).toContain("UTC_TIMESTAMP(6)");
      expect(mutation?.parameters).toEqual([classId, student1, classId, resource, "2"]);
      expect(target.calls.slice(-2).map((call) => call.sql)).toEqual(["COMMIT", "ROLLBACK"]);
    },
  );

  it("rejects malformed stored JSON with a fixed message that cannot leak its body", async () => {
    const target = boundary([clock(), stored({ response_body_json: "private malformed value" })]);
    await expect(target.service.create(target.command)).rejects.toThrow(
      "Stored in-app reminder response body is invalid.",
    );
    expect(target.limiter.consume).not.toHaveBeenCalled();
  });
});
