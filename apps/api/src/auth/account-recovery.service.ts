import { Inject, Injectable } from "@nestjs/common";

import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NOTIFICATION_MAILER,
  notificationDelivery,
  type NotificationMailer,
} from "../mail/notification-mailer.js";
import { createPrivacySafeSubject } from "./auth-crypto.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "./auth.tokens.js";
import type { AuthConfig } from "./auth.types.js";
import { admitAuthMail } from "../mail/auth-mail-admission.js";

@Injectable()
export class AccountRecoveryService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(NOTIFICATION_MAILER) private readonly mailer: NotificationMailer,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async requestAccount(rawEmail: string, clientIp: string): Promise<{ request_accepted: true }> {
    const email = rawEmail.trim().toLowerCase();
    const limits = await Promise.all([
      this.rateLimiter.consume({ key: this.key("email", email) }),
      this.rateLimiter.consume({ key: this.key("ip", clientIp) }),
    ]);
    const blocked = limits.filter((limit) => !limit.allowed);
    if (blocked.length > 0) {
      const governing = blocked.reduce((longest, limit) =>
        limit.retryAfterSeconds > longest.retryAfterSeconds ? limit : longest,
      );
      throw new RateLimitedException(governing.retryAfterSeconds, governing);
    }

    await admitAuthMail(this.rateLimiter, this.config, email, "account-recovery", { clientIp });
    const account = await this.database
      .selectFrom("users")
      .select("email_normalized")
      .where("email_normalized", "=", email)
      .where("is_active", "=", true)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    // Both paths perform the same mail operation. Only the mailbox owner learns the result.
    // SMTP rejection or outage must not expose account existence in the HTTP response.
    await notificationDelivery(() =>
      this.mailer.sendAccountRecoveryEmail(email, account !== undefined),
    );
    return { request_accepted: true };
  }

  private key(kind: "email" | "ip", value: string): string {
    return `account-recovery:${kind}:${createPrivacySafeSubject(
      this.config.emailHmacKey,
      this.config.emailHmacKeyVersion,
      `account_recovery_${kind}`,
      value,
    )}`;
  }
}
