import { randomUUID } from "node:crypto";

import type { SecurityAuditEvent } from "@classhub/db";
import { Logger } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createPrivacySafeDigest } from "../auth/auth-crypto.js";
import { CSRF_COOKIE_NAME } from "../auth/session-cookie.js";
import { ERROR_CODES } from "../common/errors/error-codes.js";
import {
  createSecurityAuditHttpContext,
  SecurityAuditHttpProducer,
  type SecurityAuditHttpContext,
} from "./security-audit-http.producer.js";

const EMAIL_HMAC_KEY = "unit-test-security-audit-hmac-key-at-least-32-bytes";
const EMAIL_HMAC_KEY_VERSION = "unit-v1";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const VALID_SECRET = "a".repeat(43);

function makeProducer(publish = vi.fn().mockResolvedValue(undefined)): {
  producer: SecurityAuditHttpProducer;
  publish: ReturnType<typeof vi.fn>;
} {
  const config = {
    get: vi.fn((key: string) => {
      if (key === "EMAIL_HMAC_KEY") return EMAIL_HMAC_KEY;
      if (key === "EMAIL_HMAC_KEY_VERSION") return EMAIL_HMAC_KEY_VERSION;
      throw new Error(`unexpected config key: ${key}`);
    }),
  };
  return {
    producer: new SecurityAuditHttpProducer({ publish } as never, config as never),
    publish,
  };
}

function context(overrides: Partial<SecurityAuditHttpContext> = {}): SecurityAuditHttpContext {
  return {
    actorIp: "127.0.0.1",
    actorClassId: null,
    actorUserId: null,
    targetClassId: null,
    csrfCookieValid: true,
    csrfHeaderValid: true,
    method: "POST",
    requestId: REQUEST_ID,
    sanitizedPath: "/api/v1/auth/login",
    userAgent: "classhub-test-agent",
    ...overrides,
  };
}

function publishedEvent(publish: ReturnType<typeof vi.fn>): SecurityAuditEvent {
  return publish.mock.calls[0]![0] as SecurityAuditEvent;
}

describe("SecurityAuditHttpProducer", () => {
  it.each([
    [ERROR_CODES.INVALID_CREDENTIALS, "invalid_credentials"],
    [ERROR_CODES.ACCOUNT_LOCKED, "account_locked"],
  ])("publishes exactly one opaque login failure for %s", async (errorCode, expectedReason) => {
    const rawEmail = "Student.Sentinel@Example.COM";
    const { producer, publish } = makeProducer();
    const identity = producer.createEmailIdentity(rawEmail);

    await producer.recordFailure(context(), errorCode, identity);

    expect(publish).toHaveBeenCalledOnce();
    expect(publishedEvent(publish)).toMatchObject({
      actor_user_id: null,
      actor_email_hmac: createPrivacySafeDigest(
        EMAIL_HMAC_KEY,
        "security_audit_email",
        rawEmail.toLowerCase(),
      ),
      hmac_key_version: EMAIL_HMAC_KEY_VERSION,
      action: "auth.login_failed",
      resource: "session",
      sanitized_path: "/api/v1/auth/login",
      method: "POST",
      deny_reason: expectedReason,
      failure_code: null,
      request_id: REQUEST_ID,
    });
    expect(JSON.stringify(publishedEvent(publish))).not.toContain(rawEmail);
  });

  it("uses the deduplicated rate-limit action while preserving opaque login identity", async () => {
    const rawEmail = "Rate.Limited@Example.COM";
    const { producer, publish } = makeProducer();
    const identity = producer.createEmailIdentity(rawEmail);

    await producer.recordFailure(context(), ERROR_CODES.RATE_LIMITED, identity);

    expect(publish).toHaveBeenCalledOnce();
    expect(publishedEvent(publish)).toMatchObject({
      action: "rate_limited",
      actor_class_id: null,
      actor_email_hmac: createPrivacySafeDigest(
        EMAIL_HMAC_KEY,
        "security_audit_email",
        rawEmail.toLowerCase(),
      ),
      actor_user_id: null,
      deny_reason: "rate_limited",
      hmac_key_version: EMAIL_HMAC_KEY_VERSION,
      resource: "session",
      sanitized_path: "/api/v1/auth/login",
      target_class_id: null,
    });
    expect(JSON.stringify(publishedEvent(publish))).not.toContain(rawEmail);
  });

  it("classifies non-login 429 responses for the worker rate-limit dedup scope", async () => {
    const { producer, publish } = makeProducer();

    await producer.recordFailure(
      context({
        actorClassId: "456",
        actorUserId: "123",
        sanitizedPath: "/api/v1/notices",
        targetClassId: "456",
      }),
      ERROR_CODES.RATE_LIMITED,
    );

    expect(publish).toHaveBeenCalledOnce();
    expect(publishedEvent(publish)).toMatchObject({
      action: "rate_limited",
      actor_class_id: "456",
      actor_email_hmac: null,
      actor_user_id: "123",
      deny_reason: "rate_limited",
      hmac_key_version: null,
      resource: "notices",
      sanitized_path: "/api/v1/notices",
      target_class_id: "456",
    });
  });

  it("requires the exact login route, method, and structured login code", async () => {
    const { producer, publish } = makeProducer();
    const identity = producer.createEmailIdentity("student@example.com");

    await producer.recordFailure(
      context({ sanitizedPath: "/api/v1/auth/password-reset-requests" }),
      ERROR_CODES.RATE_LIMITED,
      identity,
    );
    await producer.recordFailure(
      context({ method: "GET" }),
      ERROR_CODES.INVALID_CREDENTIALS,
      identity,
    );
    await producer.recordFailure(context(), ERROR_CODES.VALIDATION_FAILED, identity);

    expect(publish).not.toHaveBeenCalled();
  });

  it("excludes pre-auth Origin failures but records protected routes with IP-only identity", async () => {
    const { producer, publish } = makeProducer();
    const preAuthPaths = [
      "/api/v1/auth/sign-up",
      "/api/v1/auth/email-verifications/confirm",
      "/api/v1/auth/password-reset-requests",
      "/api/v1/auth/password-resets/confirm",
      "/api/v1/auth/login",
    ];

    for (const sanitizedPath of preAuthPaths) {
      await producer.recordFailure(context({ sanitizedPath }), ERROR_CODES.ORIGIN_NOT_ALLOWED);
    }
    await producer.recordFailure(
      context({ sanitizedPath: "/api/v1/local-test-admin/accounts" }),
      ERROR_CODES.LOCAL_ADMIN_CSRF_INVALID,
    );
    await producer.recordFailure(
      context({ sanitizedPath: "/api/v1/auth/logout" }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );
    await producer.recordFailure(
      context({ sanitizedPath: "/api/v1/auth/csrf-token" }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );
    await producer.recordFailure(
      context({ sanitizedPath: "/api/v1/membership-requests" }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );
    await producer.recordFailure(
      context({ actorIp: null, sanitizedPath: "/api/v1/auth/logout" }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );

    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_ip: "127.0.0.1",
        actor_user_id: null,
        deny_reason: "origin_invalid",
        sanitized_path: "/api/v1/auth/logout",
      }),
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_ip: "127.0.0.1",
        actor_user_id: null,
        deny_reason: "origin_invalid",
        sanitized_path: "/api/v1/auth/csrf-token",
      }),
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_ip: "127.0.0.1",
        actor_user_id: null,
        deny_reason: "origin_invalid",
        sanitized_path: "/api/v1/membership-requests",
      }),
    ]);
  });

  it("records session and authenticated-route Origin failures with trusted identity", async () => {
    const { producer, publish } = makeProducer();

    await producer.recordFailure(
      context({
        actorClassId: "9",
        actorUserId: "42",
        sanitizedPath: "/api/v1/auth/logout",
      }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );
    await producer.recordFailure(
      context({
        actorClassId: "9",
        actorUserId: "42",
        sanitizedPath: "/api/v1/classes/current/notices",
        targetClassId: "9",
      }),
      ERROR_CODES.ORIGIN_NOT_ALLOWED,
    );

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_class_id: "9",
        actor_user_id: "42",
        deny_reason: "origin_invalid",
        sanitized_path: "/api/v1/auth/logout",
      }),
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_class_id: "9",
        actor_user_id: "42",
        deny_reason: "origin_invalid",
        sanitized_path: "/api/v1/classes/current/notices",
        target_class_id: "9",
      }),
    ]);
  });

  it.each([
    [{ csrfCookieValid: false, csrfHeaderValid: false }, "csrf_cookie_invalid"],
    [{ csrfCookieValid: true, csrfHeaderValid: false }, "csrf_header_invalid"],
    [{ csrfCookieValid: true, csrfHeaderValid: true }, "csrf_token_mismatch"],
  ])("classifies CSRF failures from booleans only", async (overrides, expectedReason) => {
    const { producer, publish } = makeProducer();

    await producer.recordFailure(
      context({
        actorClassId: "6",
        actorUserId: "7",
        sanitizedPath: "/api/v1/auth/email-verifications/resend",
        ...overrides,
      }),
      ERROR_CODES.CSRF_INVALID,
    );

    expect(publishedEvent(publish)).toMatchObject({
      action: "auth.csrf_failed",
      actor_class_id: "6",
      actor_user_id: "7",
      deny_reason: expectedReason,
    });
    expect(Object.keys(publishedEvent(publish))).not.toContain("csrfCookie");
    expect(Object.keys(publishedEvent(publish))).not.toContain("csrfHeader");
  });

  it("records only structured authorization denials and never validation or not-found errors", async () => {
    const { producer, publish } = makeProducer();
    const deniedContext = context({
      actorClassId: "501",
      actorUserId: "81",
      sanitizedPath: "/api/v1/classes/current/invite-code",
      targetClassId: "501",
    });

    await producer.recordFailure(deniedContext, ERROR_CODES.ROLE_INSUFFICIENT);
    await producer.recordFailure(deniedContext, ERROR_CODES.VALIDATION_FAILED);
    await producer.recordFailure(deniedContext, ERROR_CODES.NOT_FOUND);

    expect(publish).toHaveBeenCalledOnce();
    expect(publishedEvent(publish)).toMatchObject({
      action: "authz.denied",
      actor_user_id: "81",
      actor_class_id: "501",
      target_class_id: "501",
      resource: "classes",
      deny_reason: "role_insufficient",
    });
  });

  it("publishes logout only for a certain active-session actor", async () => {
    const { producer, publish } = makeProducer();
    const logoutContext = context({ sanitizedPath: "/api/v1/auth/logout" });

    await producer.recordLogout(logoutContext, { currentClassId: "17", userId: "91" });
    await producer.recordLogout(logoutContext, { currentClassId: null, userId: "invalid-user-id" });

    expect(publish).toHaveBeenCalledOnce();
    expect(publishedEvent(publish)).toMatchObject({
      action: "auth.logout",
      actor_class_id: "17",
      actor_user_id: "91",
      resource: "session",
      sanitized_path: "/api/v1/auth/logout",
      deny_reason: null,
    });
  });

  it("swallows publisher and fallback logger failures", async () => {
    const secret = "postgresql://user:password@db/private";
    const publish = vi.fn().mockRejectedValue(new Error(secret));
    const { producer } = makeProducer(publish);
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
      throw new Error("logger unavailable");
    });

    try {
      await expect(
        producer.recordFailure(context(), ERROR_CODES.INVALID_CREDENTIALS),
      ).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "security_audit.producer_failed",
          failure_code: "security_publisher_unhandled",
          request_id: REQUEST_ID,
        }),
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("createSecurityAuditHttpContext", () => {
  it("keeps only canonical, bounded request metadata and ignores URL/body secrets", () => {
    const rawEmail = "body-secret@example.com";
    const rawPassword = "password-sentinel-never-copy";
    const request = {
      id: "not-a-uuid",
      ip: "not-an-ip",
      method: "post",
      routeOptions: {
        url: "/api/v1/classes/:classId/notices?token=query-secret#fragment-secret",
      },
      url: `/api/v1/classes/1/notices?email=${rawEmail}`,
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${VALID_SECRET}; private_cookie=raw-cookie-secret`,
        "user-agent": "Bearer raw-token-sentinel",
        "x-csrf-token": VALID_SECRET,
      },
      body: {
        email: rawEmail,
        password: rawPassword,
        token: "body-token-sentinel",
      },
      params: { classId: "999" },
      authenticatedSession: { currentClassId: "456", userId: "123" },
    } as unknown as FastifyRequest;

    const auditContext = createSecurityAuditHttpContext(request);

    expect(auditContext).toMatchObject({
      actorIp: null,
      actorClassId: "456",
      actorUserId: "123",
      csrfCookieValid: true,
      csrfHeaderValid: true,
      method: "POST",
      sanitizedPath: "/api/v1/classes/:classId/notices",
      targetClassId: null,
      userAgent: null,
    });
    expect(auditContext.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    const serialized = JSON.stringify(auditContext);
    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain(rawPassword);
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("raw-cookie-secret");
  });

  it.each([
    "/api/v1/home",
    "/api/v1/notices/:noticeId",
    "/api/v1/supplies/:supplyId",
    "/api/v1/schedules/:scheduleId",
    "/api/v1/members/:memberId",
    "/api/v1/attendance-notifications/:notificationId",
    "/api/v1/audit-logs",
    "/api/v1/meals/week",
    "/api/v1/classes/current/invite-code",
    "/api/v1/membership-requests/current/cancel",
    "/api/v1/memberships/current/leave",
  ])("uses the trusted current class as target only for verified scope %s", (route) => {
    const request = {
      id: REQUEST_ID,
      ip: "127.0.0.1",
      method: "GET",
      routeOptions: { url: route },
      headers: {},
      securityAuditIdentity: { currentClassId: "456", userId: "123" },
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request)).toMatchObject({
      actorClassId: "456",
      actorUserId: "123",
      targetClassId: "456",
    });
  });

  it.each([
    "/api/v1/memberships-evil/current",
    "/api/v1/memberships",
    "/api/v1/membership-requests",
    "/api/v1/classes",
    "/api/v1/account",
    "/api/v1/classes/:classId",
    "/api/v1/meals-archive",
    "/api/v1/auth/logout",
  ])("does not infer a target class outside the verified current-class scope %s", (route) => {
    const request = {
      id: REQUEST_ID,
      ip: "127.0.0.1",
      method: "POST",
      routeOptions: { url: route },
      headers: {},
      params: { classId: "999" },
      body: { class_id: "999" },
      securityAuditIdentity: { currentClassId: "456", userId: "123" },
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request)).toMatchObject({
      actorClassId: "456",
      actorUserId: "123",
      targetClassId: null,
    });
  });

  it("rejects identifiers above signed BIGINT even when their shape is numeric", () => {
    const request = {
      id: REQUEST_ID,
      ip: "127.0.0.1",
      method: "GET",
      routeOptions: { url: "/api/v1/home" },
      headers: {},
      securityAuditIdentity: {
        currentClassId: "9223372036854775808",
        userId: "9223372036854775808",
      },
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request)).toMatchObject({
      actorClassId: null,
      actorUserId: null,
      targetClassId: null,
    });
  });

  it.each([
    VALID_SECRET,
    `Mozilla/5.0 credential=${VALID_SECRET}`,
    `prefix ${"b".repeat(64)} suffix`,
    `${"safe/1.0 ".repeat(125)}${VALID_SECRET}`,
  ])("drops a user-agent containing a bare credential-shaped value", (userAgent) => {
    const request = {
      id: REQUEST_ID,
      ip: "127.0.0.1",
      method: "GET",
      routeOptions: { url: "/api/v1/home" },
      headers: { "user-agent": userAgent },
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request).userAgent).toBeNull();
  });

  it("drops IPv6 zone identifiers before event validation", () => {
    const request = {
      id: REQUEST_ID,
      ip: "fe80::1%eth0",
      method: "GET",
      routeOptions: { url: "/api/v1/home" },
      headers: {},
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request).actorIp).toBeNull();
  });

  it("rejects an oversized user-agent and preserves a valid request UUID and IP", () => {
    const requestId = randomUUID();
    const request = {
      id: requestId,
      ip: "2001:db8::1",
      method: "GET",
      routeOptions: { url: "/api/v1/notices" },
      headers: { "user-agent": "ClassHubDesktop/1.0 ".repeat(80) },
    } as unknown as FastifyRequest;

    const auditContext = createSecurityAuditHttpContext(request);

    expect(auditContext.requestId).toBe(requestId);
    expect(auditContext.actorIp).toBe("2001:db8::1");
    expect(auditContext.userAgent).toBeNull();
  });

  it("preserves a long printable non-credential user-agent within the bound", () => {
    const userAgent = "ClassHubDesktop/1.0 ".repeat(40);
    const request = {
      id: REQUEST_ID,
      ip: "127.0.0.1",
      method: "GET",
      routeOptions: { url: "/api/v1/home" },
      headers: { "user-agent": userAgent },
    } as unknown as FastifyRequest;

    expect(createSecurityAuditHttpContext(request).userAgent).toBe(userAgent);
  });
});
