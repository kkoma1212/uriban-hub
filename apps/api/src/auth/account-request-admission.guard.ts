import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { createPrivacySafeSubject } from "./auth-crypto.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "./auth.tokens.js";
import type { AuthConfig } from "./auth.types.js";
import { loginNetworkSubject } from "./login-admission.js";

const ADMISSION_SCOPE = "classhub:account-request-admission";
type AccountRequestScope = "account-request" | "reset-confirm";

export const AccountRequestBudget = (scope: AccountRequestScope) =>
  SetMetadata(ADMISSION_SCOPE, scope);

@Injectable()
export class AccountRequestAdmissionGuard implements CanActivate {
  constructor(
    @Inject(AUTH_RATE_LIMITER) private readonly limiter: RedisRateLimiter,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.get<AccountRequestScope | undefined>(
      ADMISSION_SCOPE,
      context.getHandler(),
    );
    if (scope !== "account-request" && scope !== "reset-confirm") {
      throw new Error("Account request admission scope is missing.");
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const network = loginNetworkSubject(request.ip);
    const body = request.body;
    const value =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)[scope === "account-request" ? "email" : "token"]
        : undefined;
    // Validation still belongs to the DTO. Malformed input uses one bounded bucket.
    const subject =
      typeof value === "string" && value.length <= 320
        ? scope === "account-request"
          ? value.trim().toLowerCase()
          : value
        : "invalid-input";
    const opaque = (kind: string, input: string) =>
      createPrivacySafeSubject(
        this.config.emailHmacKey,
        this.config.emailHmacKeyVersion,
        `account_admission_${scope}_${kind}`,
        input,
      );
    // These fixed ceilings run before DTO pipes, database policy reads, KDF work or SMTP.
    // Spend shared capacity only after the originating network and pair are admitted.
    for (const budget of [
      {
        key: `auth-admission:${scope}:network:${opaque("network", network)}`,
        limit: scope === "account-request" ? 300 : 60,
      },
      {
        key: `auth-admission:${scope}:pair:${opaque("pair", JSON.stringify([network, subject]))}`,
        limit: 10,
      },
      { key: `auth-admission:${scope}:service:v1`, limit: scope === "account-request" ? 600 : 120 },
    ]) {
      const limit = await this.limiter.consume({ ...budget, windowSeconds: 60 });
      if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    }
    return true;
  }
}
