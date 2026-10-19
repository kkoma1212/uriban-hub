import { isIP } from "node:net";

export const SECURITY_AUDIT_ACTIONS = [
  "auth.login_failed",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.logout",
  "auth.csrf_failed",
  "authz.denied",
  "rate_limited",
  "email.delivery_failed",
  "account.deleted",
] as const;

export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];

export const SECURITY_AUDIT_STREAM = "{classhub-security-audit}:events:v1";
export const SECURITY_AUDIT_DEAD_LETTER_STREAM = "{classhub-security-audit}:dead-letter:v1";
export const SECURITY_AUDIT_DEAD_LETTER_INDEX = "{classhub-security-audit}:dead-letter-index:v1";
export const SECURITY_AUDIT_CONSUMER_GROUP = "classhub-security-audit-workers:v1";
export const SECURITY_AUDIT_EVENT_FIELD = "event";
export const SECURITY_AUDIT_EVENT_ID_FIELD = "event_id";
export const SECURITY_AUDIT_OCCURRED_AT_FIELD = "occurred_at";

const EVENT_KEYS = [
  "version",
  "event_id",
  "occurred_at",
  "actor_user_id",
  "actor_email_hmac",
  "hmac_key_version",
  "actor_ip",
  "actor_class_id",
  "target_class_id",
  "action",
  "resource",
  "sanitized_path",
  "method",
  "deny_reason",
  "failure_code",
  "request_id",
  "user_agent",
] as const;

export interface SecurityAuditEvent {
  version: 1;
  event_id: string;
  occurred_at: string;
  actor_user_id: string | null;
  actor_email_hmac: string | null;
  hmac_key_version: string | null;
  actor_ip: string | null;
  actor_class_id: string | null;
  target_class_id: string | null;
  action: SecurityAuditAction;
  resource: string | null;
  sanitized_path: string;
  method: string;
  deny_reason: string | null;
  failure_code: string | null;
  request_id: string;
  user_agent: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_INT8_PATTERN = /^[1-9][0-9]*$/u;
const EMAIL_HMAC_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HMAC_KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const CANONICAL_ROUTE_PATTERN = /^\/[A-Za-z0-9_:/.*-]*$/u;
const METHOD_PATTERN = /^[A-Z]{1,16}$/u;
const MAX_SIGNED_INT8 = 9_223_372_036_854_775_807n;
const SENSITIVE_USER_AGENT_PATTERN =
  /(?:authorization|cookie|password|token|bearer\s|postgres(?:ql)?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;
const CREDENTIAL_SHAPED_USER_AGENT_PATTERN =
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?=$|[^A-Za-z0-9_-])/u;
const CREDENTIAL_URL_USERINFO_PATTERN = /[A-Z][A-Z0-9+.-]*:\/\/[^\s/@]+@/iu;
const EMAIL_DELIVERY_FAILURE_CODES = ["smtp_delivery_failed"] as const;
const LOGIN_FAILURE_DENY_REASONS = ["invalid_credentials", "account_locked"] as const;
const RATE_LIMIT_DENY_REASONS = ["rate_limited", "password_reset_request_limit"] as const;
const AUTHORIZATION_DENY_REASONS = ["role_insufficient", "email_not_verified"] as const;
const CSRF_FAILURE_DENY_REASONS = [
  "origin_invalid",
  "csrf_cookie_invalid",
  "csrf_header_invalid",
  "csrf_token_mismatch",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [...EVENT_KEYS].sort();

  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Security audit event has an invalid field set.");
  }
}

function requireString(
  value: unknown,
  name: string,
  options: { maxLength: number; pattern?: RegExp },
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > options.maxLength ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw new TypeError(`Security audit event ${name} is invalid.`);
  }

  return value;
}

function requireNullableCode(value: unknown, name: string): string | null {
  if (value === null) return null;
  const code = requireString(value, name, {
    maxLength: 128,
    pattern: SAFE_CODE_PATTERN,
  });
  if (CREDENTIAL_SHAPED_USER_AGENT_PATTERN.test(code)) {
    throw new TypeError(`Security audit event ${name} is invalid.`);
  }
  return code;
}

function requireNullableEmailHmac(value: unknown): string | null {
  if (value === null) return null;
  return requireString(value, "actor_email_hmac", {
    maxLength: 43,
    pattern: EMAIL_HMAC_PATTERN,
  });
}

function requireNullableHmacKeyVersion(value: unknown): string | null {
  if (value === null) return null;
  const version = requireString(value, "hmac_key_version", {
    maxLength: 64,
    pattern: HMAC_KEY_VERSION_PATTERN,
  });
  if (CREDENTIAL_SHAPED_USER_AGENT_PATTERN.test(version)) {
    throw new TypeError("Security audit event hmac_key_version is invalid.");
  }
  return version;
}

export function sanitizeSecurityAuditUserAgent(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return null;
  if (
    /[^\x20-\x7e]/u.test(value) ||
    SENSITIVE_USER_AGENT_PATTERN.test(value) ||
    CREDENTIAL_SHAPED_USER_AGENT_PATTERN.test(value) ||
    CREDENTIAL_URL_USERINFO_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function requireNullableUserAgent(value: unknown): string | null {
  if (value === null) return null;
  const sanitized = sanitizeSecurityAuditUserAgent(value);
  if (sanitized === null) throw new TypeError("Security audit event user_agent is invalid.");
  return sanitized;
}

function requireNullableInt8(value: unknown, name: string): string | null {
  if (value === null) return null;
  const integer = requireString(value, name, {
    maxLength: 19,
    pattern: POSITIVE_INT8_PATTERN,
  });

  if (BigInt(integer) > MAX_SIGNED_INT8) {
    throw new TypeError(`Security audit event ${name} is invalid.`);
  }

  return integer;
}

function requireNullableIp(value: unknown): string | null {
  if (value === null) return null;
  const address = requireString(value, "actor_ip", { maxLength: 128 });

  if (address.includes("%") || isIP(address) === 0) {
    throw new TypeError("Security audit event actor_ip is invalid.");
  }

  return address;
}

function requireCanonicalTimestamp(value: unknown): string {
  const timestamp = requireString(value, "occurred_at", { maxLength: 24 });
  const parsed = new Date(timestamp);

  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError("Security audit event occurred_at is invalid.");
  }

  return timestamp;
}

function requireAction(value: unknown): SecurityAuditAction {
  if (typeof value !== "string" || !SECURITY_AUDIT_ACTIONS.includes(value as SecurityAuditAction)) {
    throw new TypeError("Security audit event action is invalid.");
  }

  return value as SecurityAuditAction;
}

export function validateSecurityAuditEvent(value: unknown): SecurityAuditEvent {
  if (!isRecord(value)) {
    throw new TypeError("Security audit event must be an object.");
  }
  assertExactKeys(value);

  if (value.version !== 1) {
    throw new TypeError("Security audit event version is invalid.");
  }

  const event: SecurityAuditEvent = {
    version: 1,
    event_id: requireString(value.event_id, "event_id", {
      maxLength: 36,
      pattern: UUID_PATTERN,
    }),
    occurred_at: requireCanonicalTimestamp(value.occurred_at),
    actor_user_id: requireNullableInt8(value.actor_user_id, "actor_user_id"),
    actor_email_hmac: requireNullableEmailHmac(value.actor_email_hmac),
    hmac_key_version: requireNullableHmacKeyVersion(value.hmac_key_version),
    actor_ip: requireNullableIp(value.actor_ip),
    actor_class_id: requireNullableInt8(value.actor_class_id, "actor_class_id"),
    target_class_id: requireNullableInt8(value.target_class_id, "target_class_id"),
    action: requireAction(value.action),
    resource: requireNullableCode(value.resource, "resource"),
    sanitized_path: requireString(value.sanitized_path, "sanitized_path", {
      maxLength: 2_048,
      pattern: CANONICAL_ROUTE_PATTERN,
    }),
    method: requireString(value.method, "method", {
      maxLength: 16,
      pattern: METHOD_PATTERN,
    }),
    deny_reason: requireNullableCode(value.deny_reason, "deny_reason"),
    failure_code: requireNullableCode(value.failure_code, "failure_code"),
    request_id: requireString(value.request_id, "request_id", {
      maxLength: 36,
      pattern: UUID_PATTERN,
    }),
    user_agent: requireNullableUserAgent(value.user_agent),
  };

  if ((event.actor_email_hmac === null) !== (event.hmac_key_version === null)) {
    throw new TypeError("Security audit event email HMAC fields must be paired.");
  }

  if (event.actor_class_id !== null && event.actor_user_id === null) {
    throw new TypeError("Security audit event actor class requires an actor user.");
  }

  if (
    !event.sanitized_path.startsWith("/") ||
    event.sanitized_path.includes("?") ||
    event.sanitized_path.includes("#") ||
    CREDENTIAL_SHAPED_USER_AGENT_PATTERN.test(event.sanitized_path)
  ) {
    throw new TypeError("Security audit event sanitized_path is invalid.");
  }

  if (event.method !== event.method.toUpperCase()) {
    throw new TypeError("Security audit event method must be uppercase.");
  }

  if (
    event.action === "email.delivery_failed" &&
    (!(["email_verification", "password_reset"] as const).includes(
      event.resource as "email_verification" | "password_reset",
    ) ||
      !EMAIL_DELIVERY_FAILURE_CODES.includes(
        event.failure_code as (typeof EMAIL_DELIVERY_FAILURE_CODES)[number],
      ) ||
      event.actor_email_hmac === null ||
      event.actor_user_id === null ||
      event.actor_class_id !== null ||
      event.target_class_id !== null)
  ) {
    throw new TypeError(
      "Email delivery security events require an allowed resource, code, and class-free identity.",
    );
  }

  if (event.action !== "email.delivery_failed" && event.failure_code !== null) {
    throw new TypeError("Only email delivery security events may include a failure code.");
  }

  if (event.action === "email.delivery_failed" && event.deny_reason !== null) {
    throw new TypeError("Email delivery security events may not include a deny reason.");
  }

  if (
    event.action === "auth.password_reset_requested" &&
    (event.resource !== "password_reset" ||
      event.actor_email_hmac === null ||
      event.actor_class_id !== null ||
      event.target_class_id !== null ||
      event.deny_reason !== null)
  ) {
    throw new TypeError(
      "Password reset request events require an email HMAC and class-free identity.",
    );
  }

  if (
    event.action === "auth.password_reset_completed" &&
    (event.resource !== "password_reset" ||
      event.actor_user_id === null ||
      event.actor_email_hmac !== null ||
      event.actor_class_id !== null ||
      event.target_class_id !== null ||
      event.deny_reason !== null)
  ) {
    throw new TypeError(
      "Password reset completion events require a class-free actor without denial identity.",
    );
  }

  if (
    event.action === "rate_limited" &&
    (event.actor_ip === null ||
      event.resource === null ||
      !RATE_LIMIT_DENY_REASONS.includes(
        event.deny_reason as (typeof RATE_LIMIT_DENY_REASONS)[number],
      ) ||
      (event.actor_email_hmac !== null &&
        (event.actor_user_id !== null ||
          event.actor_class_id !== null ||
          event.target_class_id !== null)))
  ) {
    throw new TypeError("Rate limit security events require an IP, resource, and allowed reason.");
  }

  if (
    event.action === "account.deleted" &&
    (event.resource !== "account" ||
      event.actor_user_id === null ||
      event.actor_email_hmac !== null ||
      event.target_class_id !== null ||
      event.deny_reason !== null)
  ) {
    throw new TypeError(
      "Account deletion security events require the account resource and actor without denial identity.",
    );
  }

  if (
    event.action === "auth.login_failed" &&
    (event.resource !== "session" ||
      event.actor_user_id !== null ||
      event.actor_email_hmac === null ||
      event.actor_class_id !== null ||
      event.target_class_id !== null ||
      !LOGIN_FAILURE_DENY_REASONS.includes(
        event.deny_reason as (typeof LOGIN_FAILURE_DENY_REASONS)[number],
      ))
  ) {
    throw new TypeError(
      "Login failure security events require the session resource, email HMAC, and allowed reason.",
    );
  }

  if (
    event.action === "auth.logout" &&
    (event.resource !== "session" ||
      event.actor_user_id === null ||
      event.actor_email_hmac !== null ||
      event.target_class_id !== null ||
      event.deny_reason !== null)
  ) {
    throw new TypeError(
      "Logout security events require the session resource and actor without a deny reason.",
    );
  }

  if (
    event.action === "auth.csrf_failed" &&
    (event.resource !== "request" ||
      event.actor_email_hmac !== null ||
      (event.actor_user_id === null && event.actor_ip === null) ||
      !CSRF_FAILURE_DENY_REASONS.includes(
        event.deny_reason as (typeof CSRF_FAILURE_DENY_REASONS)[number],
      ))
  ) {
    throw new TypeError(
      "CSRF failure security events require the request resource and allowed reason.",
    );
  }

  if (
    event.action === "authz.denied" &&
    (event.resource === null ||
      event.actor_email_hmac !== null ||
      !AUTHORIZATION_DENY_REASONS.includes(
        event.deny_reason as (typeof AUTHORIZATION_DENY_REASONS)[number],
      ) ||
      (event.actor_user_id === null && event.actor_ip === null))
  ) {
    throw new TypeError(
      "Authorization denial security events require resource, allowed reason, and actor or IP.",
    );
  }

  return event;
}

export function serializeSecurityAuditEvent(event: SecurityAuditEvent): string {
  return JSON.stringify(validateSecurityAuditEvent(event));
}

export function parseSecurityAuditEvent(serialized: string): SecurityAuditEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("Security audit event JSON is invalid.");
  }

  return validateSecurityAuditEvent(parsed);
}
