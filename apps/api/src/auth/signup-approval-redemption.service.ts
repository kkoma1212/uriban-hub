import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { approvalCodeDigest } from "../admin-signup-approval/admin-signup-approval.policy.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { createPrivacySafeDigest } from "./auth-crypto.js";
import { AccountUnavailableException, SignupApprovalInvalidException } from "./auth.errors.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "./auth.tokens.js";
import type { AuthConfig } from "./auth.types.js";
import {
  authDateValue,
  authPersistenceFailure,
  authUpdateSucceeded,
  createAuthMariaRowCodec,
} from "./mariadb/auth-persistence.js";
import { lockSignupApproval, recordSignupApprovalEvent } from "./mariadb/auth-signup-approval.js";

@Injectable()
export class SignupApprovalRedemptionService {
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    this.mariaDb = environment?.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    this.database = this.mariaDb ? database.withPlugin(createAuthMariaRowCodec()) : database;
  }

  async confirmRole(userId: string, role: "student" | "teacher") {
    if (role !== "student" && role !== "teacher")
      throw new BadRequestException({
        code: "SIGNUP_ROLE_REQUIRED",
        message: "학생 또는 선생님을 선택해 주세요.",
      });
    return this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select(["id", "signup_role", "signup_approved_at", "is_active", "deleted_at"])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user || !user.is_active || user.deleted_at !== null)
        throw new AccountUnavailableException();
      if (user.signup_role === role) return { signup_role: role };
      if (user.signup_role !== null || user.signup_approved_at !== null)
        throw new ConflictException({
          code: "SIGNUP_ROLE_ALREADY_SET",
          message: "이미 확정된 가입 유형은 변경할 수 없습니다.",
        });
      // Only legacy pending accounts can record their missing choice once.
      const update = transaction
        .updateTable("users")
        .set({ signup_role: role, updated_at: authDateValue(new Date(), this.mariaDb) })
        .where("id", "=", userId)
        .where("signup_role", "is", null)
        .where("signup_approved_at", "is", null);
      const changed = this.mariaDb
        ? authUpdateSucceeded(await update.executeTakeFirstOrThrow())
        : (await update.returning("id").executeTakeFirst()) !== undefined;
      if (!changed) throw authPersistenceFailure();
      return { signup_role: role };
    });
  }

  async redeem(userId: string, code: string, requestId: string) {
    if (!/^[0-9]{6}$/u.test(code)) throw new SignupApprovalInvalidException();
    const limit = await this.rateLimiter.consume({
      key: `signup-approval:account:${userId}`,
    });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);

    const result = await this.database.transaction().execute(async (transaction) => {
      // Issuance and redemption both lock this existing account before approval rows.
      const user = await transaction
        .selectFrom("users")
        .select([
          "id",
          "email_normalized",
          "email_verified_at",
          "signup_approved_at",
          "signup_role",
          "is_active",
          "deleted_at",
        ])
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || !user.is_active || user.deleted_at !== null)
        throw new AccountUnavailableException();
      if (user.signup_approved_at !== null) return { signupApproved: true };
      const role = user.signup_role;
      if (role !== "student" && role !== "teacher")
        throw new BadRequestException({
          code: "SIGNUP_ROLE_REQUIRED",
          message: "가입할 계정 유형을 먼저 확인해 주세요.",
        });

      const emailDigest = Buffer.from(
        createPrivacySafeDigest(
          this.config.emailHmacKey,
          "admin-signup-approval-email",
          user.email_normalized,
        ),
        "base64url",
      );
      const codeDigest = approvalCodeDigest(
        this.config.emailHmacKey,
        user.email_normalized,
        role,
        code,
        user.id,
        user.email_verified_at === null ? "email" : "approval",
      );
      const approval = await lockSignupApproval(
        transaction,
        emailDigest,
        codeDigest,
        role,
        new Date(),
        this.mariaDb,
      );
      if (approval.kind === "denied") {
        // Commit the failed-attempt count and audit before returning the public error.
        await recordSignupApprovalEvent(transaction, {
          approvalId: approval.approvalId,
          requestId,
          resultCode: approval.resultCode,
          role,
          userActorId: null,
        });
        return null;
      }

      const emailVerification = user.email_verified_at === null;
      if (emailVerification !== (approval.issuedByAdminAccountId === null))
        throw new SignupApprovalInvalidException();
      const signupApproved = role === "student" || !emailVerification;

      const now = authDateValue(new Date(), this.mariaDb);
      const consume = transaction
        .updateTable("admin_signup_approvals")
        .set({ consumed_at: now, consumed_by_user_id: user.id })
        .where("id", "=", approval.id)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now);
      const consumed = this.mariaDb
        ? authUpdateSucceeded(await consume.executeTakeFirstOrThrow())
        : (await consume.returning("id").executeTakeFirst()) !== undefined;
      if (!consumed) throw new SignupApprovalInvalidException();

      if (role === "teacher" && signupApproved) {
        const profile = await transaction
          .selectFrom("teacher_profiles")
          .select("id")
          .where("user_id", "=", user.id)
          .executeTakeFirst();
        if (profile !== undefined) throw new SignupApprovalInvalidException();
        await transaction
          .insertInto("teacher_profiles")
          .values({
            user_id: user.id,
            status: "active",
            temporary_password_must_change: false,
            temporary_password_expires_at: null,
            created_by_operator_id: null,
            created_by_admin_account_id: approval.issuedByAdminAccountId,
            created_by_signup_approval_id: null,
          })
          .execute();
      }
      const activate = transaction
        .updateTable("users")
        .set({
          ...(signupApproved ? { signup_approved_at: now } : {}),
          ...(emailVerification ? { email_verified_at: now } : {}),
          updated_at: now,
        })
        .where("id", "=", user.id)
        .where("signup_approved_at", "is", null)
        .where("is_active", "=", true)
        .where("deleted_at", "is", null);
      const activated = this.mariaDb
        ? authUpdateSucceeded(await activate.executeTakeFirstOrThrow())
        : (await activate.returning("id").executeTakeFirst()) !== undefined;
      if (!activated) throw authPersistenceFailure();
      await recordSignupApprovalEvent(transaction, {
        approvalId: approval.id,
        requestId,
        resultCode: "approved",
        role,
        userActorId: user.id,
      });
      // "approved" records a successfully consumed code; its issuer identifies
      // email verification versus administrative approval in the existing audit schema.
      return { signupApproved };
    });
    if (result === null) throw new SignupApprovalInvalidException();
    return { next_action: "BOOTSTRAP" as const, signup_approved: result.signupApproved };
  }
}
