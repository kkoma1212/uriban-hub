import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import type { SecurityAuditEvent } from "@classhub/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyRequest } from "fastify";

import { createPrivacySafeDigest } from "../auth/auth-crypto.js";
import type { AuthenticatedFastifyRequest } from "../auth/authenticated-request.js";
import type { SecurityAuditSessionIdentity } from "../auth/auth.types.js";
import { CSRF_COOKIE_NAME, readCookie } from "../auth/session-cookie.js";
import { isSessionSecret } from "../auth/session-crypto.js";
import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { AppEnvironment } from "../config/environment.js";
import { sanitizeSecurityAuditUserAgent } from "./security-audit-metadata.js";
import { SECURITY_AUDIT_PUBLISHER } from "./security-audit.tokens.js";
import type { SecurityAuditPublisher } from "./security-audit.types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SIGNED_INT8 = 9_223_372_036_854_775_807n;
const POSITIVE_INT8_PATTERN = /^[1-9][0-9]{0,18}$/u;
const CANONICAL_ROUTE_PATTERN = /^\/[A-Za-z0-9_:/.*-]*$/u;

const LOGIN_ROUTE = "/api/v1/auth/login";
const LOGIN_FAILURE_REASONS = new Map<string, string>([
  [ERROR_CODES.INVALID_CREDENTIALS, "invalid_credentials"],
  [ERROR_CODES.ACCOUNT_LOCKED, "account_locked"],
  [ERROR_CODES.RATE_LIMITED, "rate_limited"],
]);
const AUTHORIZATION_DENIAL_REASONS = new Map<string, string>([
  [ERROR_CODES.ROLE_INSUFFICIENT, "role_insufficient"],
  [ERROR_CODES.EMAIL_NOT_VERIFIED, "email_not_verified"],
]);
const PRE_AUTH_ORIGIN_ROUTES = new Set([
  "POST /api/v1/auth/sign-up",
  "POST /api/v1/auth/email-verifications/confirm",
  "POST /api/v1/auth/password-reset-requests",
  "POST /api/v1/auth/password-resets/confirm",
  "POST /api/v1/auth/login",
]);
const SELF_AUDITED_RATE_LIMIT_ROUTES = new Set(["POST /api/v1/auth/password-reset-requests"]);
const VERIFIED_CURRENT_CLASS_ROUTE_PATTERNS = [
  /^\/api\/v1\/home(?:\/|$)/u,
  /^\/api\/v1\/notices(?:\/|$)/u,
  /^\/api\/v1\/supplies(?:\/|$)/u,
  /^\/api\/v1\/schedules(?:\/|$)/u,
  /^\/api\/v1\/members(?:\/|$)/u,
  /^\/api\/v1\/attendance-notifications(?:\/|$)/u,
  /^\/api\/v1\/audit-logs(?:\/|$)/u,
  /^\/api\/v1\/meals(?:\/|$)/u,
  /^\/api\/v1\/classes\/current(?:\/|$)/u,
  /^\/api\/v1\/membership-requests\/current(?:\/|$)/u,
  /^\/api\/v1\/memberships\/current(?:\/|$)/u,
] as const;

export interface SecurityAuditEmailIdentity {
  hmac: string;
  keyVersion: string;
}

export interface SecurityAuditHttpContext {
  actorIp: string | null;
  actorClassId: string | null;
  actorUserId: string | null;
  targetClassId: string | null;
  csrfCookieValid: boolean;
  csrfHeaderValid: boolean;
  method: string;
  requestId: string;
  sanitizedPath: string;
  userAgent: string | null;
}

function canonicalRoute(request: FastifyRequest): string {
  const configuredRoute = request.routeOptions?.url;
  if (typeof configuredRoute !== "string") return "/unknown";

  const queryStart = configuredRoute.indexOf("?");
  const hashStart = configuredRoute.indexOf("#");
  const cutoff = Math.min(
    queryStart === -1 ? configuredRoute.length : queryStart,
    hashStart === -1 ? configuredRoute.length : hashStart,
  );
  const path = configuredRoute.slice(0, cutoff);

  return path.length <= 2_048 && CANONICAL_ROUTE_PATTERN.test(path) ? path : "/unknown";
}

function safeRequestId(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : randomUUID();
}

function safePositiveInt8(value: unknown): string | null {
  if (typeof value !== "string" || !POSITIVE_INT8_PATTERN.test(value)) return null;
  try {
    return BigInt(value) <= MAX_SIGNED_INT8 ? value : null;
  } catch {
    return null;
  }
}

function safeAuditIdentity(
  request: FastifyRequest,
  sanitizedPath: string,
): Pick<SecurityAuditHttpContext, "actorClassId" | "actorUserId" | "targetClassId"> {
  const authenticatedRequest = request as AuthenticatedFastifyRequest;
  const identity =
    authenticatedRequest.securityAuditIdentity ?? authenticatedRequest.authenticatedSession;
  const actorUserId = safePositiveInt8(identity?.userId);
  const actorClassId = actorUserId === null ? null : safePositiveInt8(identity?.currentClassId);
  const targetClassId =
    actorClassId !== null &&
    VERIFIED_CURRENT_CLASS_ROUTE_PATTERNS.some((pattern) => pattern.test(sanitizedPath))
      ? actorClassId
      : null;
  return {
    actorClassId,
    actorUserId,
    targetClassId,
  };
}

function safeClientIp(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 128 &&
    !value.includes("%") &&
    isIP(value) !== 0
    ? value
    : null;
}

function resourceFromRoute(route: string): string {
  const segment = route
    .replace(/^\/api\/v1\//u, "")
    .split("/")
    .find((value) => value.length > 0 && !value.startsWith(":"));
  return (segment ?? "request").slice(0, 128);
}

export function createSecurityAuditHttpContext(request: FastifyRequest): SecurityAuditHttpContext {
  const csrfHeader = request.headers["x-csrf-token"];
  const csrfCookie = readCookie(request.headers.cookie, CSRF_COOKIE_NAME);
  const method = request.method.toUpperCase();
  const sanitizedPath = canonicalRoute(request);
  const auditIdentity = safeAuditIdentity(request, sanitizedPath);

  return {
    actorIp: safeClientIp(request.ip),
    ...auditIdentity,
    csrfCookieValid: isSessionSecret(csrfCookie),
    csrfHeaderValid: typeof csrfHeader === "string" && isSessionSecret(csrfHeader),
    method: method.length > 0 && method.length <= 16 ? method : "UNKNOWN",
    requestId: safeRequestId(request.id),
    sanitizedPath,
    userAgent: sanitizeSecurityAuditUserAgent(request.headers["user-agent"]),
  };
}

export function readLoginEmail(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const email = (body as Record<string, unknown>).email;
  return typeof email === "string" ? email : undefined;
}

export function isLoginFailureAuditCandidate(
  context: SecurityAuditHttpContext,
  errorCode: string,
): boolean {
  return (
    context.method === "POST" &&
    context.sanitizedPath === LOGIN_ROUTE &&
    LOGIN_FAILURE_REASONS.has(errorCode)
  );
}

type EventClassification = Pick<SecurityAuditEvent, "action" | "deny_reason" | "resource">;

function classifyFailure(
  context: SecurityAuditHttpContext,
  errorCode: string,
): EventClassification | null {
  if (errorCode === ERROR_CODES.RATE_LIMITED) {
    const routeKey = `${context.method} ${context.sanitizedPath}`;
    if (SELF_AUDITED_RATE_LIMIT_ROUTES.has(routeKey)) return null;

    return {
      action: "rate_limited",
      deny_reason: "rate_limited",
      resource:
        context.method === "POST" && context.sanitizedPath === LOGIN_ROUTE
          ? "session"
          : resourceFromRoute(context.sanitizedPath),
    };
  }

  if (isLoginFailureAuditCandidate(context, errorCode)) {
    return {
      action: "auth.login_failed",
      deny_reason: LOGIN_FAILURE_REASONS.get(errorCode)!,
      resource: "session",
    };
  }

  if (errorCode === ERROR_CODES.ORIGIN_NOT_ALLOWED) {
    const routeKey = `${context.method} ${context.sanitizedPath}`;
    if (
      PRE_AUTH_ORIGIN_ROUTES.has(routeKey) ||
      (context.actorUserId === null && context.actorIp === null) ||
      context.sanitizedPath.startsWith("/api/v1/local-test-admin")
    ) {
      return null;
    }
    return { action: "auth.csrf_failed", deny_reason: "origin_invalid", resource: "request" };
  }

  if (errorCode === ERROR_CODES.CSRF_INVALID) {
    const denyReason = !context.csrfCookieValid
      ? "csrf_cookie_invalid"
      : !context.csrfHeaderValid
        ? "csrf_header_invalid"
        : "csrf_token_mismatch";
    return { action: "auth.csrf_failed", deny_reason: denyReason, resource: "request" };
  }

  const authorizationReason = AUTHORIZATION_DENIAL_REASONS.get(errorCode);
  if (authorizationReason !== undefined) {
    return {
      action: "authz.denied",
      deny_reason: authorizationReason,
      resource: resourceFromRoute(context.sanitizedPath),
    };
  }

  return null;
}

@Injectable()
export class SecurityAuditHttpProducer {
  private readonly logger = new Logger(SecurityAuditHttpProducer.name);

  constructor(
    @Inject(SECURITY_AUDIT_PUBLISHER)
    private readonly publisher: SecurityAuditPublisher,
    @Inject(ConfigService)
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  createEmailIdentity(rawEmail: string | undefined): SecurityAuditEmailIdentity | null {
    if (typeof rawEmail !== "string") return null;
    const normalized = rawEmail.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 320) return null;

    return {
      hmac: createPrivacySafeDigest(
        this.config.get("EMAIL_HMAC_KEY", { infer: true }),
        "security_audit_email",
        normalized,
      ),
      keyVersion: this.config.get("EMAIL_HMAC_KEY_VERSION", { infer: true }),
    };
  }

  async recordFailure(
    context: SecurityAuditHttpContext,
    errorCode: string,
    emailIdentity: SecurityAuditEmailIdentity | null = null,
  ): Promise<void> {
    const classification = classifyFailure(context, errorCode);
    if (classification === null) return;

    const usesOpaqueEmailIdentity =
      classification.action === "auth.login_failed" ||
      (classification.action === "rate_limited" &&
        context.method === "POST" &&
        context.sanitizedPath === LOGIN_ROUTE);

    await this.publishBestEffort({
      version: 1,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor_user_id: usesOpaqueEmailIdentity ? null : context.actorUserId,
      actor_email_hmac: usesOpaqueEmailIdentity ? (emailIdentity?.hmac ?? null) : null,
      hmac_key_version: usesOpaqueEmailIdentity ? (emailIdentity?.keyVersion ?? null) : null,
      actor_ip: context.actorIp,
      actor_class_id: usesOpaqueEmailIdentity ? null : context.actorClassId,
      target_class_id: usesOpaqueEmailIdentity ? null : context.targetClassId,
      action: classification.action,
      resource: classification.resource,
      sanitized_path: context.sanitizedPath,
      method: context.method,
      deny_reason: classification.deny_reason,
      failure_code: null,
      request_id: context.requestId,
      user_agent: context.userAgent,
    });
  }

  async recordLogout(
    context: SecurityAuditHttpContext,
    identity: SecurityAuditSessionIdentity,
  ): Promise<void> {
    const actorUserId = safePositiveInt8(identity.userId);
    if (actorUserId === null) return;
    const actorClassId = safePositiveInt8(identity.currentClassId);

    await this.publishBestEffort({
      version: 1,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor_user_id: actorUserId,
      actor_email_hmac: null,
      hmac_key_version: null,
      actor_ip: context.actorIp,
      actor_class_id: actorClassId,
      target_class_id: null,
      action: "auth.logout",
      resource: "session",
      sanitized_path: context.sanitizedPath,
      method: context.method,
      deny_reason: null,
      failure_code: null,
      request_id: context.requestId,
      user_agent: context.userAgent,
    });
  }

  private async publishBestEffort(event: SecurityAuditEvent): Promise<void> {
    try {
      await this.publisher.publish(event);
    } catch {
      try {
        this.logger.error({
          action: "security_audit.producer_failed",
          event_id: event.event_id,
          failure_code: "security_publisher_unhandled",
          request_id: event.request_id,
        });
      } catch {
        // Logging must not turn a best-effort audit failure into a product failure.
      }
    }
  }
}
