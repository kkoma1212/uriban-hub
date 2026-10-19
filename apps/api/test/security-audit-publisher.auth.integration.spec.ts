import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { SECURITY_AUDIT_STREAM, type SecurityAuditEvent } from "@classhub/db";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRedisSecurityAuditPublisher } from "../src/security-audit/security-audit.publisher.js";

let redisContainer: StartedNativeTestService;
let redisInspector: RedisClientType;
let redisUrl: string;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function rateLimitEvent(override: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor_user_id: null,
    actor_email_hmac: "a".repeat(43),
    hmac_key_version: "test-v1",
    actor_ip: "192.0.2.55",
    actor_class_id: null,
    target_class_id: null,
    action: "rate_limited",
    resource: "session",
    sanitized_path: "/api/v1/auth/login",
    method: "POST",
    deny_reason: "rate_limited",
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "integration-test-agent",
    ...override,
  };
}

beforeAll(async () => {
  redisContainer = await startNativeTestService("redis");
  redisUrl = `redis://${reachableHost(redisContainer)}:${redisContainer.getMappedPort(6379)}`;
  redisInspector = createClient({ url: redisUrl });
  await redisInspector.connect();
});

beforeEach(async () => {
  await redisInspector.flushDb();
});

afterAll(async () => {
  if (redisInspector?.isOpen) await redisInspector.quit();
  if (redisContainer !== undefined) await redisContainer.stop();
});

describe("security audit publisher upstream deduplication", () => {
  it("keeps one stream representative while the worker is paused and allows one after expiry", async () => {
    const fallbackEntries: unknown[] = [];
    const publisher = createRedisSecurityAuditPublisher(redisUrl, {
      error: (entry) => fallbackEntries.push(entry),
    });
    const base = rateLimitEvent();

    try {
      await Promise.all(
        Array.from({ length: 16 }, () =>
          publisher.publish(
            rateLimitEvent({
              event_id: randomUUID(),
              occurred_at: base.occurred_at,
              request_id: randomUUID(),
            }),
          ),
        ),
      );

      expect(await redisInspector.xLen(SECURITY_AUDIT_STREAM)).toBe(1);
      const gateKeys = await redisInspector.keys("{classhub-security-audit}:publish-dedup:v1:*");
      expect(gateKeys).toHaveLength(1);
      expect(gateKeys[0]).toMatch(
        /^\{classhub-security-audit\}:publish-dedup:v1:[A-Za-z0-9_-]{43}$/u,
      );
      expect(gateKeys[0]).not.toContain(base.actor_ip!);
      expect(gateKeys[0]).not.toContain(base.sanitized_path);
      const ttl = await redisInspector.pTTL(gateKeys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300_000);

      await redisInspector.pExpire(gateKeys[0]!, 1);
      await delay(10);
      await publisher.publish(rateLimitEvent());

      expect(await redisInspector.xLen(SECURITY_AUDIT_STREAM)).toBe(2);
      expect(fallbackEntries).toEqual([]);
    } finally {
      await publisher.close();
    }
  });
});
