import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SecurityAuditEvent } from "./event.js";
import {
  SECURITY_AUDIT_AUTHORIZATION_DEDUP_WINDOW_MS,
  SECURITY_AUDIT_CSRF_DEDUP_WINDOW_MS,
  SECURITY_AUDIT_RATE_LIMIT_DEDUP_WINDOW_MS,
  securityAuditDeduplicationScope,
} from "./dedup.js";

function event(override: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    actor_user_id: "42",
    actor_email_hmac: null,
    hmac_key_version: null,
    actor_ip: "192.0.2.1",
    actor_class_id: "7",
    target_class_id: "7",
    action: "authz.denied",
    resource: "notices",
    sanitized_path: "/api/v1/notices",
    method: "POST",
    deny_reason: "role_insufficient",
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "test-agent",
    ...override,
  };
}

describe("securityAuditDeduplicationScope", () => {
  it("uses the PRD windows for authorization, CSRF, and rate-limit events", () => {
    expect(securityAuditDeduplicationScope(event())?.windowMs).toBe(
      SECURITY_AUDIT_AUTHORIZATION_DEDUP_WINDOW_MS,
    );
    expect(
      securityAuditDeduplicationScope(
        event({
          action: "auth.csrf_failed",
          deny_reason: "csrf_token_mismatch",
          resource: "request",
        }),
      )?.windowMs,
    ).toBe(SECURITY_AUDIT_CSRF_DEDUP_WINDOW_MS);
    expect(
      securityAuditDeduplicationScope(
        event({ action: "rate_limited", deny_reason: "rate_limited" }),
      )?.windowMs,
    ).toBe(SECURITY_AUDIT_RATE_LIMIT_DEDUP_WINDOW_MS);
  });

  it("includes only each action's declared scope fields", () => {
    const authorization = securityAuditDeduplicationScope(event());
    expect(authorization).not.toBeNull();
    expect(securityAuditDeduplicationScope(event({ event_id: randomUUID() }))).toEqual(
      authorization,
    );
    expect(
      securityAuditDeduplicationScope(event({ deny_reason: "email_not_verified" })),
    ).not.toEqual(authorization);

    const csrf = securityAuditDeduplicationScope(
      event({ action: "auth.csrf_failed", deny_reason: "origin_invalid", resource: "request" }),
    );
    expect(
      securityAuditDeduplicationScope(
        event({
          action: "auth.csrf_failed",
          deny_reason: "origin_invalid",
          resource: "request",
          sanitized_path: "/api/v1/supplies",
        }),
      ),
    ).not.toEqual(csrf);

    const rate = securityAuditDeduplicationScope(
      event({ action: "rate_limited", deny_reason: "rate_limited" }),
    );
    expect(
      securityAuditDeduplicationScope(
        event({ action: "rate_limited", deny_reason: "password_reset_request_limit" }),
      ),
    ).not.toEqual(rate);
  });

  it.each([
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["0:0:0:0:0:ffff:c000:201", "::ffff:192.0.2.1"],
  ])("canonicalizes equivalent IPv6 forms to the same identity", (expanded, canonical) => {
    expect(securityAuditDeduplicationScope(event({ actor_ip: expanded }))).toEqual(
      securityAuditDeduplicationScope(event({ actor_ip: canonical })),
    );
  });

  it("does not gate append-only events outside the dedup contract", () => {
    expect(
      securityAuditDeduplicationScope(
        event({ action: "auth.logout", deny_reason: null, resource: "session" }),
      ),
    ).toBeNull();
  });
});
