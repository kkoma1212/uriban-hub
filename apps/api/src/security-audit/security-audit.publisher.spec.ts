import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SecurityAuditEvent } from "@classhub/db";

import { RedisSecurityAuditPublisher } from "./security-audit.publisher.js";

function event(): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor_user_id: null,
    actor_email_hmac: "a".repeat(43),
    hmac_key_version: "v1",
    actor_ip: "127.0.0.1",
    actor_class_id: null,
    target_class_id: null,
    action: "auth.password_reset_requested",
    resource: "password_reset",
    sanitized_path: "/api/v1/auth/password-reset-requests",
    method: "POST",
    deny_reason: null,
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "test-agent",
  };
}

describe("RedisSecurityAuditPublisher", () => {
  it("publishes only the strict event envelope", async () => {
    const client = {
      isOpen: false,
      isReady: false,
      connect: vi.fn(async function (this: { isOpen: boolean; isReady: boolean }) {
        this.isOpen = true;
        this.isReady = true;
      }),
      destroy: vi.fn(),
      xAdd: vi.fn().mockResolvedValue("1-0"),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);
    const auditEvent = event();

    await publisher.publish(auditEvent);

    expect(client.xAdd).toHaveBeenCalledWith(
      "{classhub-security-audit}:events:v1",
      "*",
      expect.objectContaining({
        event_id: auditEvent.event_id,
        occurred_at: auditEvent.occurred_at,
      }),
    );
    const payload = JSON.parse(client.xAdd.mock.calls[0]![2].event as string) as object;
    expect(payload).toEqual(auditEvent);
    expect(fallbackLogger.error).not.toHaveBeenCalled();
  });

  it("atomically gates deduplicated events without putting raw scope data in Redis keys", async () => {
    const client = {
      isOpen: true,
      isReady: true,
      connect: vi.fn(),
      destroy: vi.fn(),
      eval: vi.fn().mockResolvedValue("1-0"),
      xAdd: vi.fn(),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);
    const rateLimited = {
      ...event(),
      action: "rate_limited" as const,
      actor_email_hmac: null,
      deny_reason: "rate_limited",
      hmac_key_version: null,
      resource: "auth",
    };

    await expect(publisher.publish(rateLimited)).resolves.toBeUndefined();

    expect(client.xAdd).not.toHaveBeenCalled();
    expect(client.eval).toHaveBeenCalledOnce();
    const [script, options] = client.eval.mock.calls[0]! as [
      string,
      { arguments: string[]; keys: string[] },
    ];
    expect(script.indexOf('"XADD"')).toBeGreaterThan(script.indexOf('"EXISTS"'));
    expect(script.indexOf('"PSETEX"')).toBeGreaterThan(script.indexOf('"XADD"'));
    expect(options.keys[0]).toBe("{classhub-security-audit}:events:v1");
    expect(options.keys[1]).toMatch(
      /^\{classhub-security-audit\}:publish-dedup:v1:[A-Za-z0-9_-]{43}$/u,
    );
    expect(options.keys[1]).not.toContain(rateLimited.actor_ip);
    expect(options.keys[1]).not.toContain(rateLimited.sanitized_path);
    expect(options.arguments.at(-1)).toBe("300000");
    expect(fallbackLogger.error).not.toHaveBeenCalled();
  });

  it("contains an upstream gate failure at the publisher boundary", async () => {
    const client = {
      isOpen: true,
      isReady: true,
      connect: vi.fn(),
      destroy: vi.fn(),
      eval: vi.fn().mockRejectedValue(new Error("gate secret")),
      xAdd: vi.fn(),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);

    await expect(
      publisher.publish({
        ...event(),
        action: "rate_limited",
        actor_email_hmac: null,
        deny_reason: "rate_limited",
        hmac_key_version: null,
        resource: "auth",
      }),
    ).resolves.toBeUndefined();

    expect(client.destroy).toHaveBeenCalledOnce();
    expect(fallbackLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ failure_code: "security_stream_unavailable" }),
    );
  });

  it("swallows Redis failure and emits only a classified fallback entry", async () => {
    const client = {
      isOpen: true,
      isReady: true,
      connect: vi.fn(),
      destroy: vi.fn(),
      xAdd: vi.fn().mockRejectedValue(new Error("redis host and raw secret")),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);
    const auditEvent = event();

    await expect(publisher.publish(auditEvent)).resolves.toBeUndefined();

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(fallbackLogger.error).toHaveBeenCalledWith({
      action: "security_audit.publish_failed",
      event_id: auditEvent.event_id,
      failure_code: "security_stream_unavailable",
      request_id: auditEvent.request_id,
    });
    expect(JSON.stringify(fallbackLogger.error.mock.calls)).not.toContain("raw secret");
  });

  it("classifies an invalid event without touching Redis or exposing its bad path", async () => {
    const client = {
      isOpen: false,
      isReady: false,
      connect: vi.fn(),
      destroy: vi.fn(),
      xAdd: vi.fn(),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);
    const invalid = { ...event(), sanitized_path: "/reset?token=raw-secret" };

    await expect(publisher.publish(invalid)).resolves.toBeUndefined();

    expect(client.xAdd).not.toHaveBeenCalled();
    expect(fallbackLogger.error).toHaveBeenCalledWith({
      action: "security_audit.publish_failed",
      event_id: invalid.event_id,
      failure_code: "security_event_invalid",
      request_id: invalid.request_id,
    });
    expect(JSON.stringify(fallbackLogger.error.mock.calls)).not.toContain("raw-secret");
  });

  it("does not copy invalid identifiers into the fallback log", async () => {
    const client = {
      isOpen: false,
      isReady: false,
      connect: vi.fn(),
      destroy: vi.fn(),
      xAdd: vi.fn(),
    };
    const fallbackLogger = { error: vi.fn() };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);
    const invalid = {
      ...event(),
      event_id: "secret@example.com",
      request_id: "raw-reset-token",
    };

    await expect(publisher.publish(invalid)).resolves.toBeUndefined();

    expect(fallbackLogger.error).toHaveBeenCalledWith({
      action: "security_audit.publish_failed",
      event_id: "unknown",
      failure_code: "security_event_invalid",
      request_id: "unknown",
    });
    expect(JSON.stringify(fallbackLogger.error.mock.calls)).not.toContain("secret@example.com");
    expect(JSON.stringify(fallbackLogger.error.mock.calls)).not.toContain("raw-reset-token");
  });

  it("contains Redis cleanup and fallback logger failures", async () => {
    const client = {
      isOpen: true,
      isReady: true,
      connect: vi.fn(),
      destroy: vi.fn(() => {
        throw new Error("cleanup failure with secret");
      }),
      xAdd: vi.fn().mockRejectedValue(new Error("redis failure with secret")),
    };
    const fallbackLogger = {
      error: vi.fn(() => {
        throw new Error("stderr failure with secret");
      }),
    };
    const publisher = new RedisSecurityAuditPublisher(client as never, fallbackLogger);

    await expect(publisher.publish(event())).resolves.toBeUndefined();
    await expect(publisher.close()).resolves.toBeUndefined();

    expect(client.destroy).toHaveBeenCalledTimes(2);
    expect(fallbackLogger.error).toHaveBeenCalledOnce();
  });
});
