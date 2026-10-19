import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseSecurityAuditEvent,
  serializeSecurityAuditEvent,
  type SecurityAuditEvent,
} from "./event.js";

function passwordResetEvent(override: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    version: 1,
    event_id: randomUUID(),
    occurred_at: "2026-07-19T04:00:00.000Z",
    actor_user_id: "42",
    actor_email_hmac: "a".repeat(43),
    hmac_key_version: "v1",
    actor_ip: "192.0.2.1",
    actor_class_id: null,
    target_class_id: null,
    action: "auth.password_reset_requested",
    resource: "password_reset",
    sanitized_path: "/api/v1/auth/password-reset-requests",
    method: "POST",
    deny_reason: null,
    failure_code: null,
    request_id: randomUUID(),
    user_agent: "storage-contract-test",
    ...override,
  };
}

function expectAccepted(event: SecurityAuditEvent): void {
  expect(parseSecurityAuditEvent(serializeSecurityAuditEvent(event))).toEqual(event);
}

function expectRejected(event: SecurityAuditEvent): void {
  expect(() => serializeSecurityAuditEvent(event)).toThrow(TypeError);
}

function eventForIntegerField(
  field: "actor_class_id" | "actor_user_id" | "target_class_id",
  value: string,
): SecurityAuditEvent {
  if (field === "actor_user_id") return passwordResetEvent({ actor_user_id: value });
  return passwordResetEvent({
    action: "authz.denied",
    actor_email_hmac: null,
    deny_reason: "role_insufficient",
    hmac_key_version: null,
    resource: "classes",
    [field]: value,
  });
}

const allowedIdentityCases: ReadonlyArray<readonly [string, Partial<SecurityAuditEvent>]> = [
  [
    "login failure",
    {
      action: "auth.login_failed",
      actor_user_id: null,
      deny_reason: "invalid_credentials",
      resource: "session",
    },
  ],
  [
    "logout with trusted actor-class attribution",
    {
      action: "auth.logout",
      actor_class_id: "7",
      actor_email_hmac: null,
      deny_reason: null,
      hmac_key_version: null,
      resource: "session",
    },
  ],
  [
    "CSRF failure with trusted class attribution",
    {
      action: "auth.csrf_failed",
      actor_class_id: "7",
      actor_email_hmac: null,
      deny_reason: "csrf_header_invalid",
      hmac_key_version: null,
      resource: "request",
      target_class_id: "8",
    },
  ],
  [
    "authorization denial with trusted class attribution",
    {
      action: "authz.denied",
      actor_class_id: "7",
      actor_email_hmac: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      resource: "classes",
      target_class_id: "8",
    },
  ],
];

const forbiddenIdentityCases: ReadonlyArray<readonly [string, Partial<SecurityAuditEvent>]> = [
  [
    "login actor user",
    { action: "auth.login_failed", deny_reason: "invalid_credentials", resource: "session" },
  ],
  [
    "login actor class",
    {
      action: "auth.login_failed",
      actor_class_id: "7",
      actor_user_id: null,
      deny_reason: "invalid_credentials",
      resource: "session",
    },
  ],
  [
    "login target class",
    {
      action: "auth.login_failed",
      actor_user_id: null,
      deny_reason: "invalid_credentials",
      resource: "session",
      target_class_id: "8",
    },
  ],
  ["logout email HMAC", { action: "auth.logout", deny_reason: null, resource: "session" }],
  [
    "logout target class",
    {
      action: "auth.logout",
      actor_email_hmac: null,
      deny_reason: null,
      hmac_key_version: null,
      resource: "session",
      target_class_id: "8",
    },
  ],
  [
    "CSRF email HMAC",
    {
      action: "auth.csrf_failed",
      deny_reason: "csrf_header_invalid",
      resource: "request",
    },
  ],
  [
    "CSRF without actor or IP",
    {
      action: "auth.csrf_failed",
      actor_email_hmac: null,
      actor_ip: null,
      actor_user_id: null,
      deny_reason: "csrf_header_invalid",
      hmac_key_version: null,
      resource: "request",
    },
  ],
  [
    "anonymous CSRF actor class",
    {
      action: "auth.csrf_failed",
      actor_class_id: "7",
      actor_email_hmac: null,
      actor_user_id: null,
      deny_reason: "csrf_header_invalid",
      hmac_key_version: null,
      resource: "request",
    },
  ],
  [
    "anonymous authorization actor class",
    {
      action: "authz.denied",
      actor_class_id: "7",
      actor_email_hmac: null,
      actor_user_id: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      resource: "classes",
    },
  ],
  [
    "authorization email HMAC",
    { action: "authz.denied", deny_reason: "role_insufficient", resource: "classes" },
  ],
  [
    "authorization without actor or IP",
    {
      action: "authz.denied",
      actor_email_hmac: null,
      actor_ip: null,
      actor_user_id: null,
      deny_reason: "role_insufficient",
      hmac_key_version: null,
      resource: "classes",
    },
  ],
];

describe("security audit PostgreSQL storage contract", () => {
  it.each(["actor_user_id", "actor_class_id", "target_class_id"] as const)(
    "accepts positive BIGINT boundaries for %s",
    (field) => {
      for (const boundary of ["1", "9223372036854775807"]) {
        expectAccepted(eventForIntegerField(field, boundary));
      }
    },
  );

  it.each(["actor_user_id", "actor_class_id", "target_class_id"] as const)(
    "rejects values outside the positive BIGINT range for %s",
    (field) => {
      for (const invalid of ["0", "01", "-1", "-9223372036854775808", "9223372036854775808"]) {
        expectRejected(eventForIntegerField(field, invalid));
      }
    },
  );

  it.each(["192.0.2.1", "2001:db8::1", "::ffff:192.0.2.1"])(
    "accepts a host IP that PostgreSQL INET can store: %s",
    (actorIp) => {
      expectAccepted(passwordResetEvent({ actor_ip: actorIp }));
    },
  );

  it.each([
    "not-an-ip",
    "example.com",
    "192.0.2.999",
    "192.0.2.1:443",
    "[2001:db8::1]:443",
    "192.0.2.1/24",
    "2001:db8::1/64",
    "fe80::1%eth0",
    "fe80::1%25eth0",
    " 192.0.2.1",
    "192.0.2.1 ",
  ])("rejects a non-host actor IP before PostgreSQL: %s", (actorIp) => {
    expectRejected(passwordResetEvent({ actor_ip: actorIp }));
  });
});

describe("new HTTP security action identity allowlists", () => {
  it.each(allowedIdentityCases)("accepts the allowed identity for %s", (_label, override) => {
    expectAccepted(passwordResetEvent(override));
  });

  it.each(forbiddenIdentityCases)(
    "rejects the forbidden identity combination: %s",
    (_label, override) => {
      expectRejected(passwordResetEvent(override));
    },
  );
});

describe("security event stream privacy boundary", () => {
  it.each<readonly [string, Partial<SecurityAuditEvent>]>([
    ["raw email HMAC", { actor_email_hmac: "student@example.com" }],
    ["unsafe key version", { hmac_key_version: "version/secret" }],
    ["credential URL UA", { user_agent: "redis://:s3cr3t@cache:6379/0" }],
    ["credential-shaped path", { sanitized_path: `/api/v1/reset/${"t".repeat(43)}` }],
    ["raw resource", { resource: "redis://:s3cr3t@cache" }],
    ["raw deny reason", { deny_reason: "student@example.com" }],
    ["lowercase method", { method: "post" }],
  ])("rejects %s", (_label, override) => {
    expectRejected(passwordResetEvent(override));
  });

  it("requires the exact email delivery failure identity and code", () => {
    const delivery = passwordResetEvent({
      action: "email.delivery_failed",
      failure_code: "smtp_delivery_failed",
    });
    expectAccepted(delivery);

    for (const override of [
      { actor_class_id: "7" },
      { target_class_id: "8" },
      { actor_user_id: null },
      { actor_email_hmac: null, hmac_key_version: null },
      { failure_code: "smtp_550_student_email" },
    ] satisfies Array<Partial<SecurityAuditEvent>>) {
      expectRejected({ ...delivery, ...override });
    }
  });

  it("keeps rate-limit email and authenticated identities mutually exclusive", () => {
    const preAuthRateLimit = passwordResetEvent({
      action: "rate_limited",
      actor_user_id: null,
      deny_reason: "rate_limited",
      resource: "session",
    });
    expectAccepted(preAuthRateLimit);
    expectRejected({ ...preAuthRateLimit, actor_user_id: "42" });
    expectRejected({ ...preAuthRateLimit, actor_user_id: "42", actor_class_id: "7" });
    expectRejected({ ...preAuthRateLimit, target_class_id: "8" });
  });
});

describe("account deletion identity contract", () => {
  function accountDeletionEvent(override: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
    return passwordResetEvent({
      action: "account.deleted",
      actor_email_hmac: null,
      hmac_key_version: null,
      resource: "account",
      ...override,
    });
  }

  it.each([null, "7"])("accepts the known actor with optional current class: %s", (classId) => {
    expectAccepted(accountDeletionEvent({ actor_class_id: classId }));
  });

  it.each<readonly [string, Partial<SecurityAuditEvent>]>([
    ["missing actor user", { actor_user_id: null }],
    [
      "email HMAC identity",
      {
        actor_email_hmac: "b".repeat(43),
        hmac_key_version: "v1",
      },
    ],
    ["target class", { target_class_id: "8" }],
    ["deny reason", { deny_reason: "unexpected" }],
    ["failure code", { failure_code: "unexpected" }],
  ])("rejects %s", (_label, override) => {
    expectRejected(accountDeletionEvent(override));
  });
});
