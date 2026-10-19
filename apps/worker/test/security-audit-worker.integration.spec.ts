import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  securityAuditDeduplicationScope,
  createDatabase,
  SECURITY_AUDIT_CONSUMER_GROUP,
  SECURITY_AUDIT_DEAD_LETTER_INDEX,
  SECURITY_AUDIT_DEAD_LETTER_STREAM,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_EVENT_ID_FIELD,
  SECURITY_AUDIT_OCCURRED_AT_FIELD,
  SECURITY_AUDIT_STREAM,
  serializeSecurityAuditEvent,
  type DB,
  type SecurityAuditEvent,
} from "@classhub/db";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SecurityAuditWorker,
  type SecurityAuditWorkerLogger,
  type SecurityAuditWorkerOptions,
} from "../src/security-audit/security-audit-worker.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

class RecordingLogger implements SecurityAuditWorkerLogger {
  readonly entries: Array<Parameters<SecurityAuditWorkerLogger["error"]>[0]> = [];

  error(entry: Parameters<SecurityAuditWorkerLogger["error"]>[0]): void {
    this.entries.push(entry);
  }
}

let postgres: StartedNativeTestService;
let redisContainer: StartedNativeTestService;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let workerDatabase: ReturnType<typeof createDatabase<DB>>;
let redis: RedisClientType;
let now: Date;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(
    5432,
  )}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(postgresUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql
      .raw(
        `
        CREATE TABLE pgmigrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          run_on TIMESTAMPTZ NOT NULL
        )
      `,
      )
      .execute(migrator);
    for (const migrationPath of await loadAllTestMigrationPaths()) {
      const migration = await readFile(migrationPath, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

function createEvent(override: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: now.toISOString(),
    actor_user_id: null,
    actor_email_hmac: "A".repeat(43),
    hmac_key_version: "test-v1",
    actor_ip: "127.0.0.11",
    actor_class_id: null,
    target_class_id: null,
    action: "auth.password_reset_requested",
    resource: "password_reset",
    sanitized_path: "/api/v1/auth/password-reset-requests",
    method: "POST",
    deny_reason: null,
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "worker-integration-test",
    ...override,
  };
}

async function publish(event: SecurityAuditEvent): Promise<string> {
  return redis.xAdd(SECURITY_AUDIT_STREAM, "*", {
    [SECURITY_AUDIT_EVENT_FIELD]: serializeSecurityAuditEvent(event),
    [SECURITY_AUDIT_EVENT_ID_FIELD]: event.event_id,
    [SECURITY_AUDIT_OCCURRED_AT_FIELD]: event.occurred_at,
  });
}

function createWorker(
  logger: RecordingLogger,
  options: Partial<SecurityAuditWorkerOptions> = {},
): SecurityAuditWorker {
  return new SecurityAuditWorker(redis, workerDatabase, logger, {
    consumerName: `integration-${randomUUID()}`,
    now: () => new Date(now),
    retryMinIdleMs: 0,
    ...options,
  });
}

function authorizationDeniedDedupIdentity(event: SecurityAuditEvent): string {
  const scope = securityAuditDeduplicationScope(event);
  if (scope === null) {
    throw new TypeError("Authorization denial fixture must have a deduplication scope.");
  }
  return scope.identity;
}

async function waitForPendingCount(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const pending = await redis.xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP);
    if (pending.pending >= expected) return;
    await delay(10);
  }

  throw new Error(`Timed out waiting for ${expected} pending security events.`);
}

async function countSecurityRows(eventId?: string): Promise<string> {
  let query = bootstrapDatabase
    .selectFrom("security_audit_logs")
    .select((expression) => expression.fn.countAll<string>().as("count"));
  if (eventId !== undefined) query = query.where("event_id", "=", eventId);
  return (await query.executeTakeFirstOrThrow()).count;
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    }),
    startNativeTestService("redis"),
  ]);

  bootstrapDatabase = createDatabase<DB>(
    postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();
  workerDatabase = createDatabase<DB>(postgresUrl("classhub_worker", "local_worker_password"));
  redis = createClient({
    url: `redis://${reachableHost(redisContainer)}:${redisContainer.getMappedPort(6379)}`,
  });
  redis.on("error", () => undefined);
  await redis.connect();
}, 120_000);

beforeEach(async () => {
  now = new Date("2026-07-17T04:00:00.000Z");
  await redis.flushDb();
  await sql`GRANT INSERT ON security_audit_logs TO classhub_worker`.execute(bootstrapDatabase);
  await sql`TRUNCATE security_audit_logs RESTART IDENTITY`.execute(bootstrapDatabase);
});

afterAll(async () => {
  if (redis?.isOpen) redis.destroy();
  await Promise.allSettled([workerDatabase?.destroy(), bootstrapDatabase?.destroy()]);
  await Promise.allSettled([postgres?.stop(), redisContainer?.stop()]);
}, 120_000);

describe("security audit worker integration", () => {
  it("stores duplicate event IDs once and acknowledges both stream messages", async () => {
    const event = createEvent();
    await publish(event);
    await publish(event);
    const logger = new RecordingLogger();
    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 2, deadLettered: 0, deferred: 0, invalid: 0 });
    expect(await countSecurityRows(event.event_id)).toBe("1");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(logger.entries).toHaveLength(0);

    const stored = await bootstrapDatabase
      .selectFrom("security_audit_logs")
      .select([
        "action",
        "actor_class_id",
        "actor_email_hmac",
        "actor_ip",
        "actor_user_id",
        "created_at",
        "deny_reason",
        "event_id",
        "failure_code",
        "hmac_key_version",
        "method",
        "request_id",
        "resource",
        "sanitized_path",
        "target_class_id",
        "user_agent",
      ])
      .where("event_id", "=", event.event_id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      action: event.action,
      actor_class_id: event.actor_class_id,
      actor_email_hmac: event.actor_email_hmac,
      actor_ip: event.actor_ip,
      actor_user_id: event.actor_user_id,
      created_at: new Date(event.occurred_at),
      deny_reason: event.deny_reason,
      event_id: event.event_id,
      failure_code: event.failure_code,
      hmac_key_version: event.hmac_key_version,
      method: event.method,
      request_id: event.request_id,
      resource: event.resource,
      sanitized_path: event.sanitized_path,
      target_class_id: event.target_class_id,
      user_agent: event.user_agent,
    });
  });

  it("stores ordinary events with distinct IDs even when their other fields match", async () => {
    const first = createEvent();
    const second = createEvent({
      actor_email_hmac: first.actor_email_hmac,
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    await publish(first);
    await publish(second);

    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result).toEqual({ acknowledged: 2, deadLettered: 0, deferred: 0, invalid: 0 });
    expect(await countSecurityRows()).toBe("2");
  });
  it("accepts exactly five minutes of future skew and fail-closes one millisecond later", async () => {
    const atBoundary = createEvent({
      occurred_at: new Date(now.getTime() + 5 * 60 * 1_000).toISOString(),
    });
    const beyondBoundary = createEvent({
      actor_email_hmac: "B".repeat(43),
      event_id: randomUUID(),
      occurred_at: new Date(now.getTime() + 5 * 60 * 1_000 + 1).toISOString(),
      request_id: randomUUID(),
    });
    await publish(atBoundary);
    await publish(beyondBoundary);
    const logger = new RecordingLogger();

    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 1, deadLettered: 1, deferred: 0, invalid: 1 });
    expect(await countSecurityRows(atBoundary.event_id)).toBe("1");
    expect(await countSecurityRows(beyondBoundary.event_id)).toBe("0");
    expect(await countSecurityRows()).toBe("1");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(
      (await redis.xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP)).pending,
    ).toBe(0);

    const deadLetters = await redis.xRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "-", "+");
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.message).toMatchObject({
      event: "",
      event_id: "unknown",
      final_failure_code: "invalid_event",
      occurred_at: "unknown",
    });
    const serializedDeadLetter = JSON.stringify(deadLetters);
    expect(serializedDeadLetter).not.toContain(beyondBoundary.event_id);
    expect(serializedDeadLetter).not.toContain(beyondBoundary.actor_email_hmac);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        event_id: "unknown",
        failure_code: "invalid_event",
      }),
    ]);
  });

  it("stores IPv4, IPv6, and the positive BIGINT maximum through the worker", async () => {
    const ipv4 = createEvent({ actor_ip: "192.0.2.1" });
    const ipv6 = createEvent({
      action: "authz.denied",
      actor_email_hmac: null,
      actor_ip: "2001:db8::1",
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      method: "GET",
      resource: "classes",
      sanitized_path: "/api/v1/classes/current",
      target_class_id: "9223372036854775807",
    });
    await publish(ipv4);
    await publish(ipv6);

    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result).toEqual({ acknowledged: 2, deadLettered: 0, deferred: 0, invalid: 0 });
    const rows = await bootstrapDatabase
      .selectFrom("security_audit_logs")
      .select(["actor_ip", "event_id", "target_class_id"])
      .execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor_ip: "192.0.2.1", event_id: ipv4.event_id }),
        expect.objectContaining({
          actor_ip: "2001:db8::1",
          event_id: ipv6.event_id,
          target_class_id: "9223372036854775807",
        }),
      ]),
    );
  });

  it("deduplicates concurrent authorization denials with distinct event IDs", async () => {
    const first = createEvent({
      action: "authz.denied",
      actor_email_hmac: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      method: "GET",
      resource: "member_management",
      sanitized_path: "/api/v1/classes/:classId/members",
      target_class_id: "77",
    });
    const second = createEvent({
      ...first,
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    await publish(first);
    await publish(second);

    let releaseBlocker = (): void => undefined;
    let signalBlockerLocked = (): void => undefined;
    const blockerLocked = new Promise<void>((resolve) => {
      signalBlockerLocked = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const identity = authorizationDeniedDedupIdentity(first);
    const blocker = bootstrapDatabase.transaction().execute(async (transaction) => {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${identity}, 0::bigint)
        )
      `.execute(transaction);
      signalBlockerLocked();
      await blockerRelease;
    });
    await blockerLocked;

    const logger = new RecordingLogger();
    const processing = Promise.all([
      createWorker(logger, { batchSize: 1 }).runOnce(),
      createWorker(logger, { batchSize: 1 }).runOnce(),
    ]);

    try {
      await waitForPendingCount(2);
    } finally {
      releaseBlocker();
    }
    await blocker;
    const results = await processing;

    expect(results.reduce((sum, result) => sum + result.acknowledged, 0)).toBe(2);
    expect(await countSecurityRows()).toBe("1");
    const stored = await bootstrapDatabase
      .selectFrom("security_audit_logs")
      .select("event_id")
      .executeTakeFirstOrThrow();
    expect([first.event_id, second.event_id]).toContain(stored.event_id);
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(logger.entries).toHaveLength(0);
  });

  it("uses the full authorization denial key and permits the one-minute boundary", async () => {
    const first = createEvent({
      action: "authz.denied",
      actor_email_hmac: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      method: "GET",
      resource: "member_management",
      sanitized_path: "/api/v1/classes/:classId/members",
      target_class_id: "77",
    });
    const withinWindow = createEvent({
      ...first,
      event_id: randomUUID(),
      occurred_at: new Date(now.getTime() + 59_999).toISOString(),
      request_id: randomUUID(),
    });
    const atBoundary = createEvent({
      ...first,
      event_id: randomUUID(),
      occurred_at: new Date(now.getTime() + 60_000).toISOString(),
      request_id: randomUUID(),
    });
    const variants = [
      createEvent({ ...first, actor_ip: "127.0.0.12", event_id: randomUUID() }),
      createEvent({ ...first, event_id: randomUUID(), target_class_id: "78" }),
      createEvent({ ...first, event_id: randomUUID(), resource: "class_management" }),
      createEvent({ ...first, deny_reason: "email_not_verified", event_id: randomUUID() }),
    ];
    for (const event of [first, withinWindow, atBoundary, ...variants]) {
      await publish(event);
    }

    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result.acknowledged).toBe(7);
    expect(await countSecurityRows()).toBe("6");
    const storedEventIds = new Set(
      (await bootstrapDatabase.selectFrom("security_audit_logs").select("event_id").execute()).map(
        (row) => row.event_id,
      ),
    );
    expect(storedEventIds.has(withinWindow.event_id)).toBe(false);
    expect(storedEventIds.has(atBoundary.event_id)).toBe(true);
    for (const variant of variants) expect(storedEventIds.has(variant.event_id)).toBe(true);
  });

  it("deduplicates rate limits for five minutes and keeps boundary or different endpoints", async () => {
    const first = createEvent({
      action: "rate_limited",
      actor_email_hmac: null,
      deny_reason: "rate_limited",
      hmac_key_version: null,
      resource: "password_reset",
      sanitized_path: "/api/v1/auth/password-reset-requests",
    });
    const withinWindow = createEvent({
      ...first,
      event_id: randomUUID(),
      occurred_at: new Date(now.getTime() + 299_999).toISOString(),
      request_id: randomUUID(),
    });
    const atBoundary = createEvent({
      ...first,
      event_id: randomUUID(),
      occurred_at: new Date(now.getTime() + 300_000).toISOString(),
      request_id: randomUUID(),
    });
    const differentPath = createEvent({
      ...first,
      event_id: randomUUID(),
      request_id: randomUUID(),
      sanitized_path: "/api/v1/auth/login",
    });
    const differentMethod = createEvent({
      ...first,
      event_id: randomUUID(),
      method: "GET",
      request_id: randomUUID(),
    });
    const differentReason = createEvent({
      ...first,
      deny_reason: "password_reset_request_limit",
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    for (const event of [
      first,
      withinWindow,
      atBoundary,
      differentPath,
      differentMethod,
      differentReason,
    ]) {
      await publish(event);
    }

    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result.acknowledged).toBe(6);
    expect(await countSecurityRows()).toBe("5");
    const storedEventIds = new Set(
      (await bootstrapDatabase.selectFrom("security_audit_logs").select("event_id").execute()).map(
        (row) => row.event_id,
      ),
    );
    expect(storedEventIds.has(withinWindow.event_id)).toBe(false);
    expect(storedEventIds.has(atBoundary.event_id)).toBe(true);
    expect(storedEventIds.has(differentPath.event_id)).toBe(true);
    expect(storedEventIds.has(differentMethod.event_id)).toBe(true);
    expect(storedEventIds.has(differentReason.event_id)).toBe(true);
  });

  it("deduplicates IP-only CSRF failures by the shared request scope", async () => {
    const first = createEvent({
      action: "auth.csrf_failed",
      actor_email_hmac: null,
      deny_reason: "origin_invalid",
      hmac_key_version: null,
      resource: "request",
      sanitized_path: "/api/v1/classes/:classId/members",
    });
    const duplicate = createEvent({
      ...first,
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    const differentIp = createEvent({
      ...first,
      actor_ip: "127.0.0.12",
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    const differentPath = createEvent({
      ...first,
      event_id: randomUUID(),
      request_id: randomUUID(),
      sanitized_path: "/api/v1/classes/:classId/notices",
    });
    for (const event of [first, duplicate, differentIp, differentPath]) {
      await publish(event);
    }

    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result.acknowledged).toBe(4);
    expect(await countSecurityRows()).toBe("3");
    const storedEventIds = new Set(
      (await bootstrapDatabase.selectFrom("security_audit_logs").select("event_id").execute()).map(
        (row) => row.event_id,
      ),
    );
    expect(storedEventIds.has(duplicate.event_id)).toBe(false);
    for (const event of [first, differentIp, differentPath]) {
      expect(storedEventIds.has(event.event_id)).toBe(true);
    }
  });

  it("leaves a DB failure pending and stores it after permission recovery", async () => {
    const event = createEvent();
    await publish(event);
    await sql`REVOKE INSERT ON security_audit_logs FROM classhub_worker`.execute(bootstrapDatabase);
    const logger = new RecordingLogger();
    const worker = createWorker(logger);

    expect(await worker.runOnce()).toMatchObject({
      deferred: 1,
      databaseFailures: { permission_denied: 1 },
    });
    expect(
      (await redis.xPending(SECURITY_AUDIT_STREAM, "classhub-security-audit-workers:v1")).pending,
    ).toBe(1);
    expect(await countSecurityRows(event.event_id)).toBe("0");

    await sql`GRANT INSERT ON security_audit_logs TO classhub_worker`.execute(bootstrapDatabase);
    expect(await worker.runOnce()).toMatchObject({ acknowledged: 1 });
    expect(await countSecurityRows(event.event_id)).toBe("1");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(logger.entries).toHaveLength(0);
  });

  it("reports a missing actor reference while retaining the event for retry", async () => {
    const event = createEvent({ actor_user_id: "9223372036854775807" });
    await publish(event);
    const logger = new RecordingLogger();
    const result = await createWorker(logger).runOnce();
    expect(result).toEqual({
      acknowledged: 0,
      deadLettered: 0,
      deferred: 1,
      invalid: 0,
      databaseFailures: { reference_missing: 1 },
    });
    expect(
      (await redis.xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP)).pending,
    ).toBe(1);
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(1);
    expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(0);
    expect(await countSecurityRows(event.event_id)).toBe("0");
    expect(JSON.stringify(result)).not.toContain(event.actor_user_id);
    expect(logger.entries).toHaveLength(0);
  });

  it("acknowledges an event older than 24 hours when its event ID is already stored", async () => {
    const event = createEvent();
    await publish(event);
    expect(await createWorker(new RecordingLogger()).runOnce()).toMatchObject({
      acknowledged: 1,
    });

    now = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    await publish(event);
    const logger = new RecordingLogger();
    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 1, deadLettered: 0, deferred: 0, invalid: 0 });
    expect(await countSecurityRows(event.event_id)).toBe("1");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(0);
    expect(logger.entries).toHaveLength(0);
  });

  it("acknowledges an old dedup-suppressed event when its scope representative is stored", async () => {
    const representative = createEvent({
      action: "authz.denied",
      actor_email_hmac: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      method: "GET",
      resource: "member_management",
      sanitized_path: "/api/v1/classes/:classId/members",
      target_class_id: "77",
    });
    const suppressed = createEvent({
      ...representative,
      event_id: randomUUID(),
      request_id: randomUUID(),
    });
    await publish(representative);
    expect(await createWorker(new RecordingLogger()).runOnce()).toMatchObject({
      acknowledged: 1,
    });

    await publish(suppressed);
    const delivered = await redis.xReadGroup(
      SECURITY_AUDIT_CONSUMER_GROUP,
      "stale-consumer",
      { id: ">", key: SECURITY_AUDIT_STREAM },
      { COUNT: 1 },
    );
    expect(delivered?.[0]?.messages).toHaveLength(1);
    now = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const logger = new RecordingLogger();

    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 1, deadLettered: 0, deferred: 0, invalid: 0 });
    expect(await countSecurityRows()).toBe("1");
    expect(await countSecurityRows(suppressed.event_id)).toBe("0");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(0);
    expect(logger.entries).toHaveLength(0);
  });

  it("moves duplicate events older than 24 hours to one dead letter and logs once", async () => {
    const event = createEvent({
      occurred_at: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    });
    await publish(event);
    await publish(event);
    const logger = new RecordingLogger();

    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 0, deadLettered: 1, deferred: 0, invalid: 0 });
    expect(await countSecurityRows(event.event_id)).toBe("0");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
    expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(1);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        action: "security_audit.dead_lettered",
        event_id: event.event_id,
        failure_code: "database_retry_window_exceeded",
      }),
    ]);
  });

  it("dead-letters at 24 hours when the final DB probe is unavailable and stays closed after recovery", async () => {
    const event = createEvent({
      occurred_at: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    });
    await publish(event);
    await sql`REVOKE SELECT ON security_audit_logs FROM classhub_worker`.execute(bootstrapDatabase);
    const logger = new RecordingLogger();

    try {
      const result = await createWorker(logger).runOnce();

      expect(result).toEqual({
        acknowledged: 0,
        deadLettered: 1,
        deferred: 0,
        invalid: 0,
        databaseFailures: { permission_denied: 1 },
      });
      expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
      expect(
        (await redis.xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP)).pending,
      ).toBe(0);
      const deadLetters = await redis.xRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "-", "+");
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.message).toMatchObject({
        event: serializeSecurityAuditEvent(event),
        event_id: event.event_id,
        final_failure_code: "database_retry_window_exceeded",
      });

      await sql`GRANT SELECT ON security_audit_logs TO classhub_worker`.execute(bootstrapDatabase);
      const afterRecovery = await createWorker(logger).runOnce();
      expect(afterRecovery).toEqual({
        acknowledged: 0,
        deadLettered: 0,
        deferred: 0,
        invalid: 0,
      });
      expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
      expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(1);
      expect(logger.entries).toHaveLength(1);
    } finally {
      await sql`GRANT SELECT ON security_audit_logs TO classhub_worker`.execute(bootstrapDatabase);
    }
  });

  it("trims dead-letter stream entries older than the 180-day security retention", async () => {
    const retentionMs = 180 * 24 * 60 * 60 * 1_000;
    const cutoffMs = now.getTime() - retentionMs;
    const expiredId = `${cutoffMs - 1}-0`;
    const boundaryId = `${cutoffMs}-0`;
    await redis.xAdd(SECURITY_AUDIT_DEAD_LETTER_STREAM, expiredId, {
      marker: "expired",
    });
    await redis.xAdd(SECURITY_AUDIT_DEAD_LETTER_STREAM, boundaryId, {
      marker: "boundary",
    });
    const event = createEvent({
      occurred_at: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    });
    await publish(event);

    expect(await createWorker(new RecordingLogger()).runOnce()).toMatchObject({
      deadLettered: 1,
    });

    const deadLetters = await redis.xRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "-", "+");
    expect(deadLetters.map((entry) => entry.id)).not.toContain(expiredId);
    expect(deadLetters.map((entry) => entry.id)).toContain(boundaryId);
    expect(deadLetters).toHaveLength(2);
  });

  it("trims an expired dead letter and its dedup index without a new dead letter", async () => {
    const retentionMs = 180 * 24 * 60 * 60 * 1_000;
    const event = createEvent({
      occurred_at: new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    });
    await publish(event);
    expect(await createWorker(new RecordingLogger()).runOnce()).toMatchObject({
      deadLettered: 1,
    });
    const originalDeadLetters = await redis.xRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "-", "+");
    expect(originalDeadLetters).toHaveLength(1);
    expect(await redis.hLen(SECURITY_AUDIT_DEAD_LETTER_INDEX)).toBe(1);

    const deadLetterTimestamp = Number(originalDeadLetters[0]!.id.split("-", 1)[0]);
    now = new Date(deadLetterTimestamp + retentionMs + 1);
    const result = await createWorker(new RecordingLogger()).runOnce();

    expect(result).toEqual({ acknowledged: 0, deadLettered: 0, deferred: 0, invalid: 0 });
    expect(await redis.xLen(SECURITY_AUDIT_DEAD_LETTER_STREAM)).toBe(0);
    expect(await redis.hLen(SECURITY_AUDIT_DEAD_LETTER_INDEX)).toBe(0);
  });

  it("walks a bounded pending cursor and still reads a new event in the same cycle", async () => {
    const setupWorker = createWorker(new RecordingLogger(), {
      batchSize: 1,
      maxClaimPages: 2,
    });
    await setupWorker.initialize();
    const pendingEvents = [createEvent(), createEvent(), createEvent()];
    for (const event of pendingEvents) await publish(event);
    const delivered = await redis.xReadGroup(
      SECURITY_AUDIT_CONSUMER_GROUP,
      "stale-consumer",
      { id: ">", key: SECURITY_AUDIT_STREAM },
      { COUNT: 3 },
    );
    expect(delivered?.[0]?.messages).toHaveLength(3);
    const newEvent = createEvent();
    await publish(newEvent);

    const firstCycle = await setupWorker.runOnce();

    expect(firstCycle).toEqual({
      acknowledged: 3,
      deadLettered: 0,
      deferred: 0,
      invalid: 0,
    });
    expect(await countSecurityRows()).toBe("3");
    expect(
      (await redis.xPending(SECURITY_AUDIT_STREAM, SECURITY_AUDIT_CONSUMER_GROUP)).pending,
    ).toBe(1);

    const secondCycle = await setupWorker.runOnce();

    expect(secondCycle).toMatchObject({ acknowledged: 1 });
    expect(await countSecurityRows()).toBe("4");
    expect(await redis.xLen(SECURITY_AUDIT_STREAM)).toBe(0);
  });

  it("dead-letters malformed input without copying its sensitive raw payload", async () => {
    const rawPayload = JSON.stringify({
      email: "secret@example.com",
      password: "NeverStore123",
      token: "raw-reset-token",
    });
    await redis.xAdd(SECURITY_AUDIT_STREAM, "*", {
      [SECURITY_AUDIT_EVENT_FIELD]: rawPayload,
      [SECURITY_AUDIT_EVENT_ID_FIELD]: randomUUID(),
      [SECURITY_AUDIT_OCCURRED_AT_FIELD]: now.toISOString(),
    });
    const logger = new RecordingLogger();

    const result = await createWorker(logger).runOnce();

    expect(result).toEqual({ acknowledged: 0, deadLettered: 1, deferred: 0, invalid: 1 });
    const deadLetters = await redis.xRange(SECURITY_AUDIT_DEAD_LETTER_STREAM, "-", "+");
    expect(deadLetters).toHaveLength(1);
    const serializedDeadLetter = JSON.stringify(deadLetters);
    expect(serializedDeadLetter).not.toContain("secret@example.com");
    expect(serializedDeadLetter).not.toContain("NeverStore123");
    expect(serializedDeadLetter).not.toContain("raw-reset-token");
    expect(logger.entries).toEqual([
      expect.objectContaining({ event_id: "unknown", failure_code: "invalid_event" }),
    ]);
  });
});
