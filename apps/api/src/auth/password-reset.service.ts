import { randomUUID } from "node:crypto";

import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import type { SecurityAuditEvent } from "@classhub/db";

import type { PasswordResetMailer } from "../mail/password-reset-mailer.js";
import { admitAuthMail } from "../mail/auth-mail-admission.js";
import {
  SECURITY_CHANGE_MAILER,
  notifySecurityChange,
  type SecurityChangeMailer,
} from "../mail/security-change-mailer.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RateLimitResult, RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { clearAccountWait, LoginAdmission } from "./login-admission.js";
import { socialDatabase } from "./social/social-auth.database.js";
import { publishSecurityAuditBestEffort } from "../security-audit/security-audit-best-effort.js";
import { sanitizeSecurityAuditUserAgent } from "../security-audit/security-audit-metadata.js";
import { SECURITY_AUDIT_PUBLISHER } from "../security-audit/security-audit.tokens.js";
import type { SecurityAuditPublisher } from "../security-audit/security-audit.types.js";
import {
  createPrivacySafeDigest,
  createPrivacySafeSubject,
  hashVerificationToken,
  issueVerificationToken,
} from "./auth-crypto.js";
import { PasswordResetTokenInvalidOrExpiredException } from "./auth.errors.js";
import { hashPassword } from "./password-hasher.js";
import { NFC_PASSWORD_INPUT_VERSION } from "./password-input-policy.js";
import { requireAcceptedNewPassword } from "./password-input-policy-http.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER, PASSWORD_RESET_MAILER } from "./auth.tokens.js";
import type { AuthConfig } from "./auth.types.js";
import type {
  ConfirmPasswordResetResult,
  PasswordResetRequestContext,
  PasswordResetRequestResult,
} from "./password-reset.types.js";
import {
  createPasswordResetMariaDbRowCodec,
  readPasswordResetTransactionTime,
} from "./mariadb/password-reset-database.js";

function blockedRetryAfterSeconds(...limits: RateLimitResult[]): number {
  const blocked = limits.filter((limit) => !limit.allowed);
  if (blocked.length === 0) throw new Error("A blocked rate limit is required.");
  return Math.max(...blocked.map((limit) => limit.retryAfterSeconds));
}

@Injectable()
export class PasswordResetService {
  private readonly mariaDb: boolean;
  private readonly socialIdentityStorage: boolean;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(PASSWORD_RESET_MAILER) private readonly mailer: PasswordResetMailer,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(SECURITY_AUDIT_PUBLISHER)
    private readonly securityAuditPublisher: SecurityAuditPublisher,
    @Optional() environment?: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
  ) {
    const engine = environment?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.mariaDb = engine === "mariadb";
    if (this.mariaDb) this.database = database.withPlugin(createPasswordResetMariaDbRowCodec());
    // account.service.ts 탈퇴와 같은 기준: 소셜 표가 설치됐을 때만 지운다.
    const authEnvironment = environment as unknown as ConfigService | undefined;
    this.socialIdentityStorage =
      authEnvironment?.get("SOCIAL_AUTH_ENABLED") === true ||
      ["social", "all"].includes(String(authEnvironment?.get("AUTH_DATABASE_EXTENSIONS")));
  }

  async requestReset(
    rawEmail: string,
    context: PasswordResetRequestContext,
  ): Promise<PasswordResetRequestResult> {
    const email = rawEmail.trim().toLowerCase();
    try {
      await this.consumeRequestLimits(email, context.clientIp);
      await admitAuthMail(this.rateLimiter, this.config, email, "password-reset", {
        clientIp: context.clientIp,
      });
    } catch (error) {
      if (error instanceof RateLimitedException) {
        await publishSecurityAuditBestEffort(
          this.securityAuditPublisher,
          this.createAuditEvent({
            action: "rate_limited",
            actorEmailHmac: createPrivacySafeDigest(
              this.config.emailHmacKey,
              "password_reset_email",
              email,
            ),
            actorUserId: null,
            context,
            denyReason: "password_reset_request_limit",
            failureCode: null,
          }),
        );
      }
      throw error;
    }
    const resetToken = issueVerificationToken();

    const issuance = await this.database.transaction().execute(async (transaction) => {
      const now = this.mariaDb
        ? await readPasswordResetTransactionTime(transaction)
        : sql<Date>`now()`;
      const user = await transaction
        .selectFrom("users")
        .select(["deleted_at", "email_normalized", "id", "is_active"])
        .where("email_normalized", "=", email)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();

      if (user === undefined || !user.is_active || user.deleted_at !== null) return null;

      await transaction
        .selectFrom("password_reset_tokens")
        .select("id")
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .forUpdate()
        .execute();

      await transaction
        .updateTable("password_reset_tokens")
        .set({ invalidated_at: now })
        .where("user_id", "=", user.id)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .execute();

      await transaction
        .insertInto("password_reset_tokens")
        .values({
          expires_at: this.mariaDb
            ? sql<Date>`DATE_ADD(${now}, INTERVAL 30 MINUTE)`
            : sql<Date>`now() + interval '30 minutes'`,
          requested_ip: this.mariaDb
            ? sql<string>`INET6_NTOA(INET6_ATON(${context.clientIp}))`
            : context.clientIp,
          ...(this.mariaDb ? { created_at: now } : {}),
          token_hash: resetToken.hash,
          user_id: user.id,
        })
        .execute();

      return { email: user.email_normalized, userId: user.id };
    });

    const emailHmac = createPrivacySafeDigest(
      this.config.emailHmacKey,
      "password_reset_email",
      email,
    );
    await publishSecurityAuditBestEffort(
      this.securityAuditPublisher,
      this.createAuditEvent({
        action: "auth.password_reset_requested",
        actorEmailHmac: emailHmac,
        actorUserId: issuance?.userId ?? null,
        context,
        denyReason: null,
        failureCode: null,
      }),
    );

    if (issuance !== null) {
      // 계정이 있을 때만 메일을 기다리면 응답 시간 차이로 가입 여부가 드러난다(총검수 I1-14).
      // 토큰은 이미 커밋됐다. 메일은 기다리지 않고 보내며, 실패는 아래에서 보안 감사에 남긴다.
      void this.deliverResetEmail(issuance, resetToken.raw, emailHmac, context).catch(
        () => undefined,
      );
    }

    return { request_accepted: true };
  }

  private async deliverResetEmail(
    issuance: { email: string; userId: string },
    rawToken: string,
    emailHmac: string,
    context: PasswordResetRequestContext,
  ): Promise<void> {
    try {
      await this.mailer.sendPasswordResetEmail(issuance.email, rawToken);
    } catch {
      await publishSecurityAuditBestEffort(
        this.securityAuditPublisher,
        this.createAuditEvent({
          action: "email.delivery_failed",
          actorEmailHmac: emailHmac,
          actorUserId: issuance.userId,
          context,
          denyReason: null,
          failureCode: "smtp_delivery_failed",
        }),
      );
    }
  }

  async confirmReset(
    rawToken: string,
    newPassword: string,
    context: PasswordResetRequestContext,
  ): Promise<ConfirmPasswordResetResult> {
    const tokenHash = hashVerificationToken(rawToken);
    const tokenIdentity = await this.database
      .selectFrom("password_reset_tokens")
      .select(["id", "user_id"])
      .where("token_hash", "=", tokenHash)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .where("expires_at", ">", this.mariaDb ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`now()`)
      .executeTakeFirst();

    if (tokenIdentity === undefined) throw new PasswordResetTokenInvalidOrExpiredException();

    let resetEmail: string | undefined;
    let socialLinksRemoved = false;
    const notice = await this.database.transaction().execute(async (transaction) => {
      const now = this.mariaDb
        ? await readPasswordResetTransactionTime(transaction)
        : sql<Date>`now()`;
      const user = await transaction
        .selectFrom("users")
        .select([
          "deleted_at",
          "display_name",
          "email_normalized",
          "is_active",
          "email_verified_at",
        ])
        .where("id", "=", tokenIdentity.user_id)
        .forUpdate()
        .executeTakeFirst();

      if (user === undefined || !user.is_active || user.deleted_at !== null) {
        throw new PasswordResetTokenInvalidOrExpiredException();
      }
      resetEmail = user.email_normalized;

      const token = await transaction
        .selectFrom("password_reset_tokens")
        .select(["invalidated_at", "used_at"])
        .where("id", "=", tokenIdentity.id)
        .where("user_id", "=", tokenIdentity.user_id)
        .forUpdate()
        .executeTakeFirst();

      if (token === undefined || token.used_at !== null || token.invalidated_at !== null) {
        throw new PasswordResetTokenInvalidOrExpiredException();
      }

      const normalizedPassword = requireAcceptedNewPassword(newPassword, {
        displayName: user.display_name,
        email: user.email_normalized,
      });
      const passwordHash = await hashPassword(normalizedPassword);
      const useToken = transaction
        .updateTable("password_reset_tokens")
        .set({ used_at: now })
        .where("id", "=", tokenIdentity.id)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .where("expires_at", ">", now);
      if (this.mariaDb) {
        const used = await useToken.executeTakeFirst();
        if (used.numUpdatedRows !== 1n) throw new PasswordResetTokenInvalidOrExpiredException();
      } else {
        const used = await useToken.returning("id").executeTakeFirst();
        if (used === undefined) throw new PasswordResetTokenInvalidOrExpiredException();
      }

      await transaction
        .updateTable("users")
        .set({
          failed_login_attempts: 0,
          locked_until: null,
          password_hash: passwordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
          password_last_changed_at: now,
          updated_at: now,
        })
        .where("id", "=", tokenIdentity.user_id)
        .executeTakeFirstOrThrow();

      await transaction
        .updateTable("teacher_profiles")
        .set({
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
        })
        .where("user_id", "=", tokenIdentity.user_id)
        .execute();

      await transaction
        .updateTable("sessions")
        .set({ revoked_at: now })
        .where("user_id", "=", tokenIdentity.user_id)
        .where("revoked_at", "is", null)
        .execute();
      // 2026-10-02 사용자 결정(총검수 I1-03·I1-04): 재설정은 '진짜 주인이 계정을 되찾음'이므로
      // 그 전에 붙은 빠른 로그인 연결을 모두 끊는다. 남의 이메일을 먼저 차지한 소셜 연결도 여기서 끊긴다.
      if (this.socialIdentityStorage) {
        const removed = await socialDatabase(transaction, this.mariaDb)
          .deleteFrom("social_identities")
          .where("user_id", "=", tokenIdentity.user_id)
          .executeTakeFirst();
        socialLinksRemoved = Number(removed.numDeletedRows) > 0;
      }
      return user.email_verified_at == null
        ? undefined
        : {
            email: user.email_normalized,
            kind: "password_reset" as const,
            occurredAt: new Date(),
          };
    });

    await notifySecurityChange(this.securityMailer, notice);
    if (notice !== undefined && socialLinksRemoved)
      await notifySecurityChange(this.securityMailer, { ...notice, kind: "social_links_removed" });
    // 비밀번호를 새로 정한 주인은 계정 기준 로그인 대기에서 바로 풀어 준다(2026-10-02 사용자 결정).
    if (resetEmail !== undefined) {
      await clearAccountWait(
        this.rateLimiter,
        new LoginAdmission(this.rateLimiter, this.config).accountBudgets(resetEmail),
      );
    }
    await publishSecurityAuditBestEffort(
      this.securityAuditPublisher,
      this.createAuditEvent({
        action: "auth.password_reset_completed",
        actorEmailHmac: null,
        actorUserId: tokenIdentity.user_id,
        context,
        denyReason: null,
        failureCode: null,
      }),
    );
    return { next_action: "LOGIN", password_reset: true };
  }

  private async consumeRequestLimits(email: string, clientIp: string): Promise<void> {
    const [emailLimit, ipLimit] = await Promise.all([
      this.rateLimiter.consume({
        key: `password-reset:email:${createPrivacySafeSubject(
          this.config.emailHmacKey,
          this.config.emailHmacKeyVersion,
          "password_reset_email",
          email,
        )}`,
      }),
      this.rateLimiter.consume({
        key: `password-reset:ip:${createPrivacySafeSubject(
          this.config.emailHmacKey,
          this.config.emailHmacKeyVersion,
          "password_reset_ip",
          clientIp,
        )}`,
      }),
    ]);

    if (!emailLimit.allowed || !ipLimit.allowed) {
      throw new RateLimitedException(
        blockedRetryAfterSeconds(emailLimit, ipLimit),
        !emailLimit.allowed ? emailLimit : ipLimit,
      );
    }
  }

  private createAuditEvent(input: {
    action:
      | "auth.password_reset_completed"
      | "auth.password_reset_requested"
      | "email.delivery_failed"
      | "rate_limited";
    actorEmailHmac: string | null;
    actorUserId: string | null;
    context: PasswordResetRequestContext;
    denyReason: "password_reset_request_limit" | null;
    failureCode: "smtp_delivery_failed" | null;
  }): SecurityAuditEvent {
    return {
      version: 1,
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor_user_id: input.actorUserId,
      actor_email_hmac: input.actorEmailHmac,
      hmac_key_version: input.actorEmailHmac === null ? null : this.config.emailHmacKeyVersion,
      actor_ip: input.context.clientIp,
      actor_class_id: null,
      target_class_id: null,
      action: input.action,
      resource: "password_reset",
      sanitized_path:
        input.action === "auth.password_reset_completed"
          ? "/api/v1/auth/password-resets/confirm"
          : "/api/v1/auth/password-reset-requests",
      method: "POST",
      deny_reason: input.denyReason,
      failure_code: input.failureCode,
      request_id: input.context.requestId,
      user_agent: sanitizeSecurityAuditUserAgent(input.context.userAgent),
    };
  }
}
