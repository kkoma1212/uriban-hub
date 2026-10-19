import type { SecurityAuditEvent } from "./event.js";

export const SECURITY_AUDIT_AUTHORIZATION_DEDUP_WINDOW_MS = 60_000;
export const SECURITY_AUDIT_CSRF_DEDUP_WINDOW_MS = 60_000;
export const SECURITY_AUDIT_RATE_LIMIT_DEDUP_WINDOW_MS = 5 * 60_000;

export interface SecurityAuditDeduplicationScope {
  identity: string;
  windowMs: number;
}

function canonicalActorIp(actorIp: string | null): string | null {
  if (actorIp === null || !actorIp.includes(":")) return actorIp;

  try {
    const hostname = new URL(`http://[${actorIp}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : actorIp;
  } catch {
    return actorIp;
  }
}

export function securityAuditDeduplicationScope(
  event: SecurityAuditEvent,
): SecurityAuditDeduplicationScope | null {
  const actorIp = canonicalActorIp(event.actor_ip);

  if (event.action === "authz.denied") {
    return {
      identity: JSON.stringify([
        event.action,
        event.actor_user_id,
        actorIp,
        event.target_class_id,
        event.resource,
        event.deny_reason,
      ]),
      windowMs: SECURITY_AUDIT_AUTHORIZATION_DEDUP_WINDOW_MS,
    };
  }

  if (event.action === "auth.csrf_failed") {
    return {
      identity: JSON.stringify([
        event.action,
        event.actor_user_id,
        actorIp,
        event.target_class_id,
        event.method,
        event.sanitized_path,
        event.deny_reason,
      ]),
      windowMs: SECURITY_AUDIT_CSRF_DEDUP_WINDOW_MS,
    };
  }

  if (event.action === "rate_limited") {
    return {
      identity: JSON.stringify([
        event.action,
        actorIp,
        event.method,
        event.sanitized_path,
        event.deny_reason,
      ]),
      windowMs: SECURITY_AUDIT_RATE_LIMIT_DEDUP_WINDOW_MS,
    };
  }

  return null;
}
