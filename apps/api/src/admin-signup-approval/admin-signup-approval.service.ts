import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { createPrivacySafeDigest } from "../auth/auth-crypto.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { admitAuthMail } from "../mail/auth-mail-admission.js";
import { decryptSignupCode, encryptSignupCode } from "../mail/signup-code-vault.js";
import {
  NOTIFICATION_MAILER,
  notificationDelivery,
  type NotificationMailer,
} from "../mail/notification-mailer.js";
import {
  createMariaDbRowCodec,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
  mariaDbBoolean,
} from "../common/database/mariadb-values.js";
import {
  approvalCodeDigest,
  issueAdminSignupApprovalCode,
  normalizeApprovalEmail,
  ADMIN_SIGNUP_APPROVAL_TTL_MS,
  ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS,
  matchesApprovalCode,
  type AdminSignupApprovalRole,
} from "./admin-signup-approval.policy.js";

const approvalId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new Error("Invalid MariaDB signup approval identifier.");
  return value;
};
const mariaCodec = createMariaDbRowCodec({
  id: approvalId,
  user_id: mariaDbId,
  is_active: mariaDbBoolean,
  consumed_at: mariaDbNullable(mariaDbDateTime),
  revoked_at: mariaDbNullable(mariaDbDateTime),
  expires_at: mariaDbDateTime,
  issued_at: mariaDbDateTime,
  email_verified_at: mariaDbNullable(mariaDbDateTime),
});

@Injectable()
export class AdminSignupApprovalService {
  private readonly engine: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(NOTIFICATION_MAILER)
    private readonly notifications: NotificationMailer | undefined,
    @Inject(AUTH_RATE_LIMITER) private readonly mailLimiter: RedisRateLimiter,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid signup approval database engine.");
    this.engine = engine;
    if (engine === "mariadb") this.database = database.withPlugin(mariaCodec);
  }

  private date(value: Date) {
    return this.engine === "mariadb" ? mariaDbDateBinding(value) : value;
  }

  private json<T>(value: T) {
    return this.engine === "mariadb" && value !== null ? sql<T>`${JSON.stringify(value)}` : value;
  }

  async list() {
    const now = this.engine === "mariadb" ? sql`UTC_TIMESTAMP(6)` : sql`clock_timestamp()`;
    const rows = await this.database
      .selectFrom("admin_signup_approvals")
      .select([
        "consumed_at",
        "expires_at",
        "id",
        "issued_at",
        "revoked_at",
        "role",
        sql<"active" | "consumed" | "expired" | "revoked">`
          CASE
            WHEN consumed_at IS NOT NULL THEN 'consumed'
            WHEN revoked_at IS NOT NULL THEN 'revoked'
            WHEN expires_at <= ${now} THEN 'expired'
            ELSE 'active'
          END
        `.as("status"),
      ])
      .orderBy(
        sql`
        CASE
          WHEN consumed_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ${now}
          THEN 0
          ELSE 1
        END
      `,
      )
      .orderBy("issued_at", "desc")
      .limit(100)
      .execute();

    return {
      approvals: rows.map((row) => ({
        consumed_at: row.consumed_at?.toISOString() ?? null,
        expires_at: row.expires_at.toISOString(),
        id: row.id,
        issued_at: row.issued_at.toISOString(),
        revoked_at: row.revoked_at?.toISOString() ?? null,
        role: row.role,
        status: row.status,
      })),
    };
  }

  async issue(
    email: string,
    role: AdminSignupApprovalRole,
    adminId: string | null,
    requestId: string,
    reuseCurrent = false,
    clientIp?: string,
    initialSignupMailAdmitted = false,
  ) {
    if (
      initialSignupMailAdmitted &&
      (adminId !== null || !reuseCurrent || clientIp === undefined)
    ) {
      throw new Error("Initial signup mail admission requires an anonymous signup request.");
    }
    let code = issueAdminSignupApprovalCode();
    const secret = this.config.get("EMAIL_HMAC_KEY", { infer: true });
    const normalized = normalizeApprovalEmail(email);
    const emailDigest = Buffer.from(
      createPrivacySafeDigest(secret, "admin-signup-approval-email", normalized),
      "base64url",
    );
    const expiresAt = new Date(Date.now() + ADMIN_SIGNUP_APPROVAL_TTL_MS);
    const row = await this.database.transaction().execute(async (transaction) => {
      // Both engines use the same users -> approval lock order as redemption.
      const account = await transaction
        .selectFrom("users")
        .select([
          "id as user_id",
          "signup_role",
          "signup_approved_at",
          "email_verified_at",
          "is_active",
        ])
        .where("email_normalized", "=", normalized)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!account)
        throw new NotFoundException({
          code: "SIGNUP_ACCOUNT_NOT_FOUND",
          message: "가입한 계정을 찾을 수 없습니다. 전체 이메일 주소를 확인해 주세요.",
        });
      if (account.signup_role !== role)
        throw new ConflictException({
          code: "SIGNUP_ROLE_MISMATCH",
          message:
            account.signup_role === null
              ? "가입 유형이 확인되지 않았습니다. 가입자가 로그인해 계정 유형을 먼저 확인해야 합니다."
              : "가입할 때 선택한 계정 유형과 다릅니다. 학생·선생님 선택을 확인해 주세요.",
        });
      if (!account.is_active || account.signup_approved_at !== null)
        throw new ConflictException({
          code: "SIGNUP_ACCOUNT_NOT_PENDING",
          message: "가입 승인 대기 중인 사용 가능한 계정에만 번호를 발급할 수 있습니다.",
        });
      if (adminId !== null && account.email_verified_at === null)
        throw new ConflictException({
          code: "SIGNUP_EMAIL_VERIFICATION_REQUIRED",
          message:
            "가입자가 이메일 인증을 먼저 마쳐야 합니다. 선생님은 교사 확인 후 승인번호를 발급해 주세요.",
        });
      if (adminId === null && account.email_verified_at !== null)
        throw new ConflictException({
          code: "SIGNUP_EMAIL_ALREADY_VERIFIED",
          message: "이메일 인증은 완료되었습니다. 선생님은 관리자에게 교사 승인을 요청해 주세요.",
        });
      const purpose = adminId === null ? "email" : "approval";
      // Reserve before replacing a code, including administrator-triggered resends.
      if (!initialSignupMailAdmitted)
        await admitAuthMail(
          this.mailLimiter,
          {
            emailHmacKey: secret,
            emailHmacKeyVersion: this.config.get("EMAIL_HMAC_KEY_VERSION", { infer: true }),
          },
          normalized,
          adminId === null ? "signup-email" : "signup-approval",
          {
            ...(clientIp === undefined ? {} : { clientIp }),
            actor:
              adminId === null
                ? { kind: "user", id: account.user_id }
                : { kind: "admin", id: adminId },
          },
        );
      const codeDigest = approvalCodeDigest(
        secret,
        normalized,
        role,
        code,
        account.user_id,
        purpose,
      );
      if (reuseCurrent) {
        const current = await transaction
          .selectFrom("admin_signup_approvals")
          .select([
            "id",
            "expires_at",
            "code_encrypted",
            "code_digest",
            "failed_attempts",
            "issued_by_admin_account_id",
          ])
          .where("email_key_digest", "=", emailDigest)
          .where("role", "=", role)
          .where("consumed_at", "is", null)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", this.date(new Date()))
          .forUpdate()
          .executeTakeFirst();
        if (
          current?.code_encrypted &&
          current.failed_attempts < ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS &&
          current.issued_by_admin_account_id === adminId
        ) {
          const previousCode = decryptSignupCode(current.code_encrypted, secret, normalized, role);
          if (
            matchesApprovalCode(
              current.code_digest,
              approvalCodeDigest(secret, normalized, role, previousCode, account.user_id, purpose),
            )
          ) {
            code = previousCode;
            return current;
          }
        }
      }
      const revocation = transaction
        .updateTable("admin_signup_approvals")
        .set({ revoked_at: this.date(new Date()) })
        .where("email_key_digest", "=", emailDigest)
        .where("role", "=", role)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null);
      const reissued =
        this.engine === "mariadb"
          ? (await revocation.executeTakeFirstOrThrow()).numUpdatedRows > 0n
          : (await revocation.returning("id").executeTakeFirst()) !== undefined;
      const insertion = transaction.insertInto("admin_signup_approvals").values({
        email_key_digest: emailDigest,
        role,
        code_digest: codeDigest,
        expires_at: this.date(expiresAt),
        issued_by_admin_account_id: adminId,
        recipient_email: normalized,
        code_encrypted: encryptSignupCode(code, secret, normalized, role),
      });
      let created;
      if (this.engine === "mariadb") {
        await insertion.executeTakeFirstOrThrow();
        // UUID is generated by the table; the strict INSERT ACL does not allow id.
        created = await transaction
          .selectFrom("admin_signup_approvals")
          .select(["id", "expires_at"])
          .where("code_digest", "=", codeDigest)
          .where("email_key_digest", "=", emailDigest)
          .where("role", "=", role)
          .executeTakeFirstOrThrow();
      } else created = await insertion.returning(["id", "expires_at"]).executeTakeFirstOrThrow();
      const issuanceAction = reissued ? "reissue" : "issue";
      await transaction
        .insertInto("admin_signup_approval_events")
        .values({
          action: issuanceAction,
          admin_actor_account_id: adminId,
          approval_id: created.id,
          request_id: requestId,
          result_code: reissued ? "reissued" : "issued",
          role,
          user_actor_id: adminId === null ? account.user_id : null,
        })
        .execute();
      if (adminId !== null)
        await transaction
          .insertInto("admin_operation_audit_logs")
          .values({
            action: reissued ? "admin.signup_approval.reissued" : "admin.signup_approval.issued",
            actor_admin_account_id: adminId,
            after_json: this.json({ role, status: "active" }),
            before_json: null,
            reason: null,
            request_id: requestId,
            target_id: created.id,
            target_type: "signup_approval",
          })
          .execute();
      return created;
    });
    const mailer = this.notifications;
    const emailDeliveryStatus =
      mailer === undefined
        ? "failed"
        : await notificationDelivery(() =>
            mailer.sendSignupApprovalEmail(normalized, { code, role, expiresAt: row.expires_at }),
          );
    return {
      id: String(row.id),
      code,
      expiresAt: row.expires_at,
      email_delivery_status: emailDeliveryStatus,
    };
  }

  async sendForAccount(userId: string, requestId: string, clientIp?: string) {
    const account = await this.database
      .selectFrom("users")
      .select(["email_normalized", "signup_role"])
      .where("id", "=", userId)
      .where("deleted_at", "is", null)
      .where("is_active", "=", true)
      .where("signup_approved_at", "is", null)
      .executeTakeFirst();
    if (!account || (account.signup_role !== "student" && account.signup_role !== "teacher"))
      throw new NotFoundException({
        code: "SIGNUP_ACCOUNT_NOT_PENDING",
        message: "인증 대기 중인 가입 계정을 확인해 주세요.",
      });
    const result = await this.issue(
      account.email_normalized,
      account.signup_role,
      null,
      requestId,
      true,
      clientIp,
    );
    return {
      email_delivery_status: result.email_delivery_status,
      expires_at: result.expiresAt.toISOString(),
    };
  }

  /** Only the highest administrator's mail-management route exposes active codes. */
  async listMailApprovals() {
    const rows = await this.database
      .selectFrom("admin_signup_approvals")
      .select([
        "id",
        "recipient_email",
        "role",
        "code_encrypted",
        "issued_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
      ])
      .where("recipient_email", "is not", null)
      .orderBy("issued_at", "desc")
      .limit(100)
      .execute();
    const now = Date.now();
    return rows.map(({ code_encrypted, ...row }) => ({
      ...row,
      code:
        code_encrypted &&
        row.recipient_email &&
        !row.consumed_at &&
        !row.revoked_at &&
        row.expires_at.getTime() > now
          ? decryptSignupCode(
              code_encrypted,
              this.config.get("EMAIL_HMAC_KEY", { infer: true }),
              row.recipient_email,
              row.role,
            )
          : null,
      status: row.consumed_at
        ? "consumed"
        : row.revoked_at
          ? "revoked"
          : row.expires_at.getTime() <= now
            ? "expired"
            : "active",
    }));
  }

  async findAccount(email: string, role: AdminSignupApprovalRole) {
    const account = await this.database
      .selectFrom("users")
      .select([
        "id as user_id",
        "display_name",
        "email_normalized as email",
        "signup_role",
        "email_verified_at",
      ])
      .where("email_normalized", "=", normalizeApprovalEmail(email))
      .where("signup_role", "=", role)
      .where("signup_approved_at", "is", null)
      .where("deleted_at", "is", null)
      .where("is_active", "=", true)
      .executeTakeFirst();
    if (!account) return { account: null };
    const { email_verified_at, ...publicAccount } = account;
    return { account: { ...publicAccount, email_verified: email_verified_at !== null } };
  }

  async revoke(id: string, adminId: string, requestId: string) {
    return this.database.transaction().execute(async (transaction) => {
      const selected =
        this.engine === "mariadb"
          ? await transaction
              .selectFrom("admin_signup_approvals")
              .select(["id", "role"])
              .where("id", "=", id)
              .where("consumed_at", "is", null)
              .where("revoked_at", "is", null)
              .forUpdate()
              .executeTakeFirst()
          : undefined;
      if (this.engine === "mariadb" && selected === undefined) return { revoked: false };
      const revocation = transaction
        .updateTable("admin_signup_approvals")
        .set({ revoked_at: this.date(new Date()) })
        .where("id", "=", id)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null);
      const row =
        this.engine === "mariadb"
          ? (await revocation.executeTakeFirstOrThrow()).numUpdatedRows === 1n
            ? selected
            : undefined
          : await revocation.returning(["id", "role"]).executeTakeFirst();
      if (row !== undefined) {
        await transaction
          .insertInto("admin_signup_approval_events")
          .values({
            action: "revoke",
            admin_actor_account_id: adminId,
            approval_id: row.id,
            request_id: requestId,
            result_code: "revoked",
            role: row.role,
            user_actor_id: null,
          })
          .execute();
        await transaction
          .insertInto("admin_operation_audit_logs")
          .values({
            action: "admin.signup_approval.revoked",
            actor_admin_account_id: adminId,
            after_json: this.json({ role: row.role, status: "revoked" }),
            before_json: this.json({ role: row.role, status: "active" }),
            reason: null,
            request_id: requestId,
            target_id: row.id,
            target_type: "signup_approval",
          })
          .execute();
      }
      return { revoked: row !== undefined };
    });
  }
}
