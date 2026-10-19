import { createPrivacySafeSubject } from "../auth/auth-crypto.js";
import type { AuthConfig } from "../auth/auth.types.js";
import { loginNetworkSubject } from "../auth/login-admission.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RedisRateLimiter,
} from "../common/rate-limit/redis-rate-limiter.js";

export type AuthMailKind =
  | "signup-email"
  | "signup-approval"
  | "password-reset"
  | "account-recovery"
  | "guardian-consent"
  | "email-verification";

export interface AuthMailSource {
  clientIp?: string;
  actor?: { kind: "user" | "admin"; id: string };
}

// Fixed abuse ceilings are independent of the administrator's business limits.
// A network can contain a whole school; its allowance is larger than one actor's.
export const AUTH_MAIL_LIMITS = Object.freeze({
  cooldownSeconds: 60,
  recipientHour: 10,
  recipientDay: 30,
  networkHour: 300,
  networkDay: 1_000,
  actorHour: 100,
  actorDay: 300,
  serviceHour: 3_000,
  serviceDay: 10_000,
});

export async function admitAuthMail(
  limiter: Pick<RedisRateLimiter, "consumeAll">,
  config: Pick<AuthConfig, "emailHmacKey" | "emailHmacKeyVersion">,
  rawEmail: string,
  kind: AuthMailKind,
  source: AuthMailSource,
): Promise<void> {
  if (source.clientIp === undefined && source.actor === undefined) {
    throw new Error("An authentication mail source is required.");
  }
  const opaque = (domain: string, value: string) =>
    createPrivacySafeSubject(
      config.emailHmacKey,
      config.emailHmacKeyVersion,
      `auth_mail_${domain}`,
      value,
    );
  const recipient = opaque("recipient", rawEmail.trim().toLowerCase());
  const budgets: Required<RateLimitRequest>[] = [
    {
      key: `auth-mail:v1:cooldown:${kind}:${recipient}`,
      limit: 1,
      windowSeconds: AUTH_MAIL_LIMITS.cooldownSeconds,
    },
  ];
  const addWindows = (key: string, hour: number, day: number) => {
    budgets.push(
      { key: `${key}:hour`, limit: hour, windowSeconds: 3_600 },
      { key: `${key}:day`, limit: day, windowSeconds: 86_400 },
    );
  };
  addWindows(
    `auth-mail:v1:recipient:${recipient}`,
    AUTH_MAIL_LIMITS.recipientHour,
    AUTH_MAIL_LIMITS.recipientDay,
  );
  if (source.clientIp !== undefined) {
    const network = opaque("network", loginNetworkSubject(source.clientIp));
    addWindows(
      `auth-mail:v1:network:${network}`,
      AUTH_MAIL_LIMITS.networkHour,
      AUTH_MAIL_LIMITS.networkDay,
    );
  }
  if (source.actor !== undefined) {
    const actor = opaque("actor", JSON.stringify([source.actor.kind, source.actor.id]));
    addWindows(
      `auth-mail:v1:actor:${actor}`,
      AUTH_MAIL_LIMITS.actorHour,
      AUTH_MAIL_LIMITS.actorDay,
    );
  }
  addWindows("auth-mail:v1:service", AUTH_MAIL_LIMITS.serviceHour, AUTH_MAIL_LIMITS.serviceDay);
  const result = await limiter.consumeAll(budgets);
  if (!result.allowed) throw new RateLimitedException(result.retryAfterSeconds, result);
}
