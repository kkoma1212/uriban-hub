import type { DB, JsonValue } from "@classhub/db";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type Transaction } from "kysely";

import { issueVerificationToken } from "../auth/auth-crypto.js";
import { readPasswordResetTransactionTime } from "../auth/mariadb/password-reset-database.js";
import { adminAuthDate, adminAuthJson } from "../admin-auth/admin-auth.database.js";
import { countCodePoints } from "../common/validation/text-validation.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import { setMariaDbAdminUserStatus } from "./admin-users.database.js";
import {
  SECURITY_CHANGE_MAILER,
  notifySecurityChange,
  type SecurityChangeMailer,
} from "../mail/security-change-mailer.js";
import { PASSWORD_RESET_MAILER } from "../auth/auth.tokens.js";
import type { PasswordResetMailer } from "../mail/password-reset-mailer.js";
import { maskEmail } from "../common/privacy/mask-email.js";
import { adminError } from "./admin-error.js";

const mariaUserListCodec = createMariaDbRowCodec({
  id: mariaDbId,
  is_active: mariaDbBoolean,
  email_verified_at: mariaDbNullable(mariaDbDateTime),
  signup_approved_at: mariaDbNullable(mariaDbDateTime),
  deleted_at: mariaDbNullable(mariaDbDateTime),
  created_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
});

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function isDatabaseId(value: string): boolean {
  if (!/^[1-9]\d*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

@Injectable()
export class AdminUsersService {
  private readonly engine: "postgres" | "mariadb";
  private readonly writeDatabase: ClassHubDatabase;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
    @Optional()
    @Inject(PASSWORD_RESET_MAILER)
    private readonly passwordResetMailer?: PasswordResetMailer,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator user database engine.");
    this.engine = engine;
    this.writeDatabase = engine === "mariadb" ? database.withPlugin(mariaUserListCodec) : database;
  }

  /** revealEmail=false(상담 담당만인 관리자)면 '선생님·학생 목록'처럼 메일을 가린다(총검수 C2-09·I2-04). */
  async list(rawSearch: string, { revealEmail = true }: { revealEmail?: boolean } = {}) {
    const search = rawSearch.normalize("NFC").trim();
    if (countCodePoints(search) < 2 || countCodePoints(search) > 100) {
      throw adminError(BadRequestException, "ADMIN_USER_SEARCH_REQUIRED");
    }
    const pattern = `%${escapeLikePattern(search)}%`;
    const database =
      this.engine === "mariadb" ? this.database.withPlugin(mariaUserListCodec) : this.database;
    const rows = await database
      .selectFrom("users")
      .select([
        "id",
        "email_normalized",
        "display_name",
        "is_active",
        "email_verified_at",
        "signup_approved_at",
        "created_at",
        "updated_at",
      ])
      .where("deleted_at", "is", null)
      .where((expression) =>
        this.engine === "mariadb"
          ? sql<boolean>`(LOWER(email_normalized) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
            OR LOWER(display_name) LIKE LOWER(${pattern}) ESCAPE ${"\\"})`
          : expression.or([
              expression("email_normalized", "ilike", pattern),
              expression("display_name", "ilike", pattern),
            ]),
      )
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(51)
      .execute();
    return {
      truncated: rows.length > 50,
      users: rows.slice(0, 50).map((row) => ({
        id: row.id,
        email: revealEmail ? row.email_normalized : maskEmail(row.email_normalized),
        display_name: row.display_name,
        is_active: row.is_active,
        email_verified: row.email_verified_at !== null,
        signup_approved: row.signup_approved_at !== null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    };
  }

  async updateStatus(
    id: string,
    status: "active" | "inactive",
    reason: string,
    adminId: string,
    requestId: string,
  ) {
    if (!isDatabaseId(id)) throw adminError(NotFoundException, "USER_NOT_FOUND");
    const result = await this.writeDatabase.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select([
          "id",
          "email_verified_at",
          "signup_approved_at",
          "is_active",
          "deleted_at",
          "created_at",
          "updated_at",
          "display_name",
          "email_normalized",
        ])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || user.deleted_at !== null) {
        throw adminError(NotFoundException, "USER_NOT_FOUND");
      }
      const nextActive = status === "active";
      if (user.is_active === nextActive) {
        throw new BadRequestException({
          code: "ADMIN_USER_STATUS_UNCHANGED",
          message: "이미 선택한 계정 상태입니다. 변경할 상태를 선택해 주세요.",
        });
      }
      if (!nextActive) {
        const activeTeacherMembership = await transaction
          .selectFrom("class_members as member")
          .innerJoin("classes as class", "class.id", "member.class_id")
          .select("member.id")
          .where("member.user_id", "=", id)
          .where("member.role", "=", "teacher")
          .where("member.status", "=", "approved")
          .where("class.status", "=", "active")
          .executeTakeFirst();
        if (activeTeacherMembership !== undefined) {
          throw adminError(ConflictException, "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED");
        }
      }
      const occurredAt = new Date();
      const now = adminAuthDate(occurredAt, this.engine);
      const fields = [
        "id",
        "email_normalized",
        "display_name",
        "is_active",
        "email_verified_at",
        "signup_approved_at",
        "created_at",
        "updated_at",
      ] as const;
      const update = transaction
        .updateTable("users")
        .set({ is_active: nextActive, updated_at: now })
        .where("id", "=", id);
      if (this.engine === "mariadb") {
        await setMariaDbAdminUserStatus(transaction, id, nextActive, occurredAt);
      }
      const updated =
        this.engine === "mariadb"
          ? await transaction
              .selectFrom("users")
              .select(fields)
              .where("id", "=", id)
              .where("is_active", "=", nextActive)
              .where("updated_at", "=", now)
              .executeTakeFirst()
          : await update.returning(fields).executeTakeFirstOrThrow();
      if (updated === undefined || updated.id !== id || updated.is_active !== nextActive)
        throw new Error("Unexpected administrator user status update result.");
      if (!nextActive) {
        await transaction
          .updateTable("sessions")
          .set({ revoked_at: now })
          .where("user_id", "=", id)
          .where("revoked_at", "is", null)
          .execute();
      }
      await this.audit(
        transaction,
        adminId,
        "admin.user.status_changed",
        id,
        { is_active: user.is_active },
        { is_active: nextActive },
        reason,
        requestId,
      );
      return {
        user: {
          id: updated.id,
          email: updated.email_normalized,
          display_name: updated.display_name,
          is_active: updated.is_active,
          email_verified: updated.email_verified_at !== null,
          signup_approved: updated.signup_approved_at !== null,
          created_at: updated.created_at,
          updated_at: updated.updated_at,
        },
      };
    });
    if (result.user.email_verified)
      await notifySecurityChange(this.securityMailer, {
        email: result.user.email,
        kind: status === "active" ? "account_enabled" : "account_disabled",
        occurredAt: result.user.updated_at,
      });
    return result;
  }

  async issuePasswordReset(
    id: string,
    reason: string,
    adminId: string,
    requestId: string,
    requestedIp: string,
  ) {
    if (!isDatabaseId(id)) throw adminError(NotFoundException, "USER_NOT_FOUND");
    const resetToken = issueVerificationToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const recipient = await this.writeDatabase.transaction().execute(async (transaction) => {
      // PG's created_at default is transaction time, not the time spent waiting for the user lock.
      const createdAt =
        this.engine === "mariadb" ? await readPasswordResetTransactionTime(transaction) : undefined;
      const user = await transaction
        .selectFrom("users")
        .select(["id", "is_active", "deleted_at", "email_normalized"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined || user.deleted_at !== null) {
        throw adminError(NotFoundException, "USER_NOT_FOUND");
      }
      if (!user.is_active) throw adminError(BadRequestException, "ADMIN_USER_ACCOUNT_INACTIVE");
      await transaction
        .updateTable("password_reset_tokens")
        .set({ invalidated_at: adminAuthDate(new Date(), this.engine) })
        .where("user_id", "=", id)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .execute();
      await transaction
        .insertInto("password_reset_tokens")
        .values({
          ...(createdAt === undefined ? {} : { created_at: createdAt }),
          expires_at: adminAuthDate(expiresAt, this.engine),
          issued_by_admin_account_id: adminId,
          requested_ip:
            this.engine === "mariadb"
              ? sql<string>`INET6_NTOA(INET6_ATON(${requestedIp}))`
              : requestedIp,
          token_hash: resetToken.hash,
          user_id: id,
        })
        .execute();
      await this.audit(
        transaction,
        adminId,
        "admin.user.password_reset_issued",
        id,
        null,
        { expires_at: expiresAt.toISOString() },
        reason,
        requestId,
      );
      return user.email_normalized;
    });
    // 2026-10-02 사용자 결정(총검수 C2-05): 링크 원문을 관리자에게 주지 않고 사용자의 가입 메일로 바로 보낸다.
    // 관리자는 보냈는지와 가린 주소만 본다. 메일이 실패하면 다시 발급하면 된다(새 발급이 옛 링크를 무효화).
    let mail: "sent" | "failed" = "failed";
    if (this.passwordResetMailer !== undefined) {
      try {
        await this.passwordResetMailer.sendPasswordResetEmail(recipient, resetToken.raw);
        mail = "sent";
      } catch {
        // SMTP 오류 내용에는 수신자·서버 정보가 섞일 수 있어 남기지 않는다.
      }
    }
    return { expires_at: expiresAt.toISOString(), mail, email_masked: maskEmail(recipient) };
  }

  private async audit(
    transaction: Transaction<DB>,
    actorAdminId: string,
    action: string,
    targetId: string,
    before: JsonValue | null,
    after: JsonValue | null,
    reason: string,
    requestId: string,
  ) {
    await transaction
      .insertInto("admin_operation_audit_logs")
      .values({
        action,
        actor_admin_account_id: actorAdminId,
        after_json: adminAuthJson(after, this.engine),
        before_json: adminAuthJson(before, this.engine),
        reason,
        request_id: requestId,
        target_id: targetId,
        target_type: "user",
      })
      .execute();
  }
}
