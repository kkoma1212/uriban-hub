import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseSecurityAuditEvent,
  serializeSecurityAuditEvent,
  type SecurityAuditEvent,
} from "./event.js";

function validEvent(): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date("2026-07-17T03:04:05.678Z").toISOString(),
    actor_user_id: "42",
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

describe("security audit event contract", () => {
  it("round-trips the versioned canonical event", () => {
    const event = validEvent();
    expect(parseSecurityAuditEvent(serializeSecurityAuditEvent(event))).toEqual(event);
  });

  it.each([
    ["a raw query", { sanitized_path: "/api/v1/auth/password-reset-requests?token=secret" }],
    ["an unpaired HMAC", { hmac_key_version: null }],
    ["a raw email instead of HMAC", { actor_email_hmac: "student@example.com" }],
    ["an unsafe HMAC key version", { hmac_key_version: "version/secret" }],
    ["a credential-shaped route", { sanitized_path: `/api/v1/reset/${"t".repeat(43)}` }],
    ["a credential URL user agent", { user_agent: "redis://:s3cr3t@cache:6379/0" }],
    ["a lowercase method", { method: "post" }],
    ["an unknown action", { action: "auth.unknown" }],
    ["an invalid resource", { resource: "email_verification" }],
    ["a noncanonical timestamp", { occurred_at: "2026-07-17T03:04:05Z" }],
  ])("rejects %s", (_label, override) => {
    expect(() => serializeSecurityAuditEvent({ ...validEvent(), ...override } as never)).toThrow(
      TypeError,
    );
  });

  it("requires delivery failures to use a classified code and allowed resource", () => {
    const event = {
      ...validEvent(),
      action: "email.delivery_failed" as const,
      failure_code: "smtp_delivery_failed",
    };

    expect(parseSecurityAuditEvent(serializeSecurityAuditEvent(event))).toEqual(event);
    expect(() => serializeSecurityAuditEvent({ ...event, failure_code: null })).toThrow(TypeError);
    expect(() =>
      serializeSecurityAuditEvent({ ...event, failure_code: "550_user_student@example.com" }),
    ).toThrow(TypeError);
    expect(() => serializeSecurityAuditEvent({ ...event, actor_class_id: "7" })).toThrow(TypeError);
    expect(() => serializeSecurityAuditEvent({ ...event, target_class_id: "8" })).toThrow(
      TypeError,
    );
    expect(() =>
      serializeSecurityAuditEvent({
        ...event,
        actor_email_hmac: null,
        hmac_key_version: null,
      }),
    ).toThrow(TypeError);
    expect(() => serializeSecurityAuditEvent({ ...event, deny_reason: "smtp_error" })).toThrow(
      TypeError,
    );
  });

  it("enforces action-specific password reset and rate-limit fields", () => {
    const requested = validEvent();
    expect(() => serializeSecurityAuditEvent({ ...requested, deny_reason: "unexpected" })).toThrow(
      TypeError,
    );
    expect(() => serializeSecurityAuditEvent({ ...requested, failure_code: "unexpected" })).toThrow(
      TypeError,
    );
    expect(() =>
      serializeSecurityAuditEvent({
        ...requested,
        actor_email_hmac: null,
        hmac_key_version: null,
      }),
    ).toThrow(TypeError);
    expect(() => serializeSecurityAuditEvent({ ...requested, actor_class_id: "7" })).toThrow(
      TypeError,
    );
    expect(() => serializeSecurityAuditEvent({ ...requested, target_class_id: "8" })).toThrow(
      TypeError,
    );
    expect(() =>
      serializeSecurityAuditEvent({
        ...requested,
        action: "auth.password_reset_completed",
        actor_email_hmac: null,
        actor_user_id: null,
        hmac_key_version: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      serializeSecurityAuditEvent({
        ...requested,
        action: "auth.password_reset_completed",
        actor_class_id: "7",
        actor_email_hmac: null,
        hmac_key_version: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      serializeSecurityAuditEvent({
        ...requested,
        action: "rate_limited",
        deny_reason: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      serializeSecurityAuditEvent({
        ...requested,
        action: "account.deleted",
        resource: "user",
      }),
    ).toThrow(TypeError);
  });

  it.each([
    [
      "auth.login_failed",
      {
        action: "auth.login_failed",
        actor_user_id: null,
        deny_reason: "invalid_credentials",
        resource: "session",
      },
    ],
    [
      "auth.logout",
      {
        action: "auth.logout",
        actor_email_hmac: null,
        deny_reason: null,
        hmac_key_version: null,
        resource: "session",
      },
    ],
    [
      "auth.csrf_failed",
      {
        action: "auth.csrf_failed",
        actor_email_hmac: null,
        deny_reason: "csrf_token_mismatch",
        hmac_key_version: null,
        resource: "request",
      },
    ],
    [
      "authz.denied",
      {
        action: "authz.denied",
        actor_email_hmac: null,
        deny_reason: "role_insufficient",
        hmac_key_version: null,
        resource: "classes",
      },
    ],
  ])("accepts the fail-closed %s event contract", (_action, override) => {
    const event = { ...validEvent(), ...override } as SecurityAuditEvent;
    expect(parseSecurityAuditEvent(serializeSecurityAuditEvent(event))).toEqual(event);
  });

  it.each([
    [
      "login resource",
      { action: "auth.login_failed", deny_reason: "invalid_credentials", resource: "request" },
    ],
    [
      "login HMAC",
      {
        action: "auth.login_failed",
        actor_email_hmac: null,
        deny_reason: "invalid_credentials",
        hmac_key_version: null,
        resource: "session",
      },
    ],
    ["login reason", { action: "auth.login_failed", deny_reason: "unknown", resource: "session" }],
    [
      "legacy login rate-limit reason",
      { action: "auth.login_failed", deny_reason: "rate_limited", resource: "session" },
    ],
    ["logout resource", { action: "auth.logout", deny_reason: null, resource: "request" }],
    [
      "logout actor",
      { action: "auth.logout", actor_user_id: null, deny_reason: null, resource: "session" },
    ],
    ["logout reason", { action: "auth.logout", deny_reason: "unexpected", resource: "session" }],
    [
      "CSRF resource",
      { action: "auth.csrf_failed", deny_reason: "csrf_header_invalid", resource: "session" },
    ],
    ["CSRF reason", { action: "auth.csrf_failed", deny_reason: "unknown", resource: "request" }],
    [
      "authorization resource",
      { action: "authz.denied", deny_reason: "role_insufficient", resource: null },
    ],
    ["authorization reason", { action: "authz.denied", deny_reason: null, resource: "classes" }],
    [
      "authorization unknown reason",
      { action: "authz.denied", deny_reason: "student_email", resource: "classes" },
    ],
    [
      "authorization actor",
      {
        action: "authz.denied",
        actor_ip: null,
        actor_user_id: null,
        deny_reason: "role_insufficient",
        resource: "classes",
      },
    ],
  ])("rejects an invalid %s contract", (_label, override) => {
    expect(() => serializeSecurityAuditEvent({ ...validEvent(), ...override } as never)).toThrow(
      TypeError,
    );
  });
});
