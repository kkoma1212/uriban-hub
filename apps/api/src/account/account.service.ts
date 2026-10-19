import { randomBytes, randomUUID } from "node:crypto";

import type { SecurityAuditEvent } from "@classhub/db";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { createPrivacySafeSubject } from "../auth/auth-crypto.js";
import { socialDatabase } from "../auth/social/social-auth.database.js";
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { hashPassword, verifyPassword } from "../auth/password-hasher.js";
import {
  NFC_PASSWORD_INPUT_VERSION,
  passwordForVerification,
} from "../auth/password-input-policy.js";
import { requireAcceptedNewPassword } from "../auth/password-input-policy-http.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { AuthConfig } from "../auth/auth.types.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { countCodePoints, isAllowedPlainText } from "../common/validation/text-validation.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { sanitizeSecurityAuditUserAgent } from "../security-audit/security-audit-metadata.js";
import { SECURITY_AUDIT_PUBLISHER } from "../security-audit/security-audit.tokens.js";
import type { SecurityAuditPublisher } from "../security-audit/security-audit.types.js";
import {
  AccountDeletionBlockedByClassException,
  AccountProfileBlockedException,
  InvalidAccountDisplayNameException,
  InvalidAccountDeletionConfirmationException,
  InvalidCurrentPasswordException,
} from "./account.errors.js";
import type {
  ChangePasswordCommand,
  ChangePasswordResult,
  DeleteAccountCommand,
  DeleteAccountResult,
  UpdateAccountProfileCommand,
  UpdateAccountProfileResult,
} from "./account.types.js";
import { minimizeDeletedAccountGuardianConsent } from "./guardian-consent-minimization.js";
import { createMariaDbAccountRowCodec } from "./mariadb/account-row-codec.js";
import { finishMariaDbAccountDeletion } from "./mariadb/account-deletion.js";
import { executeAccountDeletion, mapMariaDbAccountError } from "./mariadb/account-errors.js";
import { deleteAccountProfilePhotoIfInstalled } from "../profile-photos/profile-photo-deletion.js";
import { deleteAccountPushSubscriptionsIfInstalled } from "../push-subscriptions/push-subscription-deletion.js";
import {
  SECURITY_CHANGE_MAILER,
  notifySecurityChange,
  type SecurityChangeMailer,
} from "../mail/security-change-mailer.js";

const DELETED_DISPLAY_NAME = "탈퇴한 사용자";
const CONSENT_RETENTION_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly database: ClassHubDatabase;
  private readonly mariaDb: boolean;
  private readonly socialIdentityStorage: boolean;
  private readonly profilePhotosInstalled: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(SECURITY_AUDIT_PUBLISHER)
    private readonly securityAuditPublisher: SecurityAuditPublisher,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    @Optional()
    @Inject(SECURITY_CHANGE_MAILER)
    private readonly securityMailer?: SecurityChangeMailer,
  ) {
    const engine = environment?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported database engine");
    this.mariaDb = engine === "mariadb";
    const authEnvironment = environment as unknown as ConfigService | undefined;
    this.socialIdentityStorage =
      authEnvironment?.get("SOCIAL_AUTH_ENABLED") === true ||
      ["social", "all"].includes(String(authEnvironment?.get("AUTH_DATABASE_EXTENSIONS")));
    this.profilePhotosInstalled =
      authEnvironment?.get("PROFILE_PHOTOS_DATABASE_INSTALLED") === true;
    this.database = this.mariaDb ? database.withPlugin(createMariaDbAccountRowCodec()) : database;
  }

  async updateProfile(command: UpdateAccountProfileCommand): Promise<UpdateAccountProfileResult> {
    return this.execute(() => this.updateProfileInDatabase(command));
  }

  async changePassword(command: ChangePasswordCommand): Promise<ChangePasswordResult> {
    return this.execute(() => this.changePasswordInDatabase(command));
  }

  async deleteAccount(command: DeleteAccountCommand): Promise<DeleteAccountResult> {
    return this.execute(() => this.deleteAccountInDatabase(command), true);
  }

  private async execute<T>(operation: () => Promise<T>, deleting = false): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mariaDb ? mapMariaDbAccountError(error, deleting) : error;
    }
  }

  private async updateProfileInDatabase(
    command: UpdateAccountProfileCommand,
  ): Promise<UpdateAccountProfileResult> {
    const displayName = command.displayName.trim();
    if (
      countCodePoints(displayName) < 2 ||
      countCodePoints(displayName) > 20 ||
      !isAllowedPlainText(displayName)
    ) {
      throw new InvalidAccountDisplayNameException();
    }

    return this.database.transaction().execute(async (transaction) => {
      const account = await transaction
        .selectFrom("users")
        .select(["deleted_at", "display_name", "is_active", "updated_at"])
        .where("id", "=", command.userId)
        .forUpdate()
        .executeTakeFirst();

      if (account === undefined || !account.is_active || account.deleted_at !== null) {
        throw new UnauthenticatedException();
      }

      const teacherProfile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", command.userId)
        .forUpdate()
        .executeTakeFirst();

      const session = await transaction
        .selectFrom("sessions")
        .select(["expires_at", "revoked_at"])
        .where("id", "=", command.sessionId)
        .where("user_id", "=", command.userId)
        .forUpdate()
        .executeTakeFirst();
      const databaseClock = await (
        this.mariaDb
          ? sql<{ now: Date }>`SELECT UTC_TIMESTAMP(6) AS now`
          : sql<{ now: Date }>`SELECT clock_timestamp() AS now`
      ).execute(transaction);
      const now = databaseClock.rows[0]?.now;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("Database clock did not return a valid Date.");
      }

      if (
        session === undefined ||
        session.revoked_at !== null ||
        session.expires_at.getTime() <= now.getTime()
      ) {
        throw new UnauthenticatedException();
      }

      if (
        teacherProfile?.status === "revoked" ||
        teacherProfile?.temporary_password_must_change === true
      ) {
        throw new AccountProfileBlockedException();
      }

      if (account.display_name === displayName) {
        return {
          display_name: account.display_name,
          profile_updated: false,
          updated_at: account.updated_at.toISOString(),
        };
      }

      const update = transaction
        .updateTable("users")
        .set({ display_name: displayName, updated_at: now })
        .where("id", "=", command.userId)
        .where("is_active", "=", true)
        .where("deleted_at", "is", null);
      let updated;
      if (this.mariaDb) {
        const result = await update.executeTakeFirstOrThrow();
        if (result.numUpdatedRows !== 1n) throw new UnauthenticatedException();
        updated = await transaction
          .selectFrom("users")
          .select(["display_name", "updated_at"])
          .where("id", "=", command.userId)
          .executeTakeFirst();
      } else {
        updated = await update.returning(["display_name", "updated_at"]).executeTakeFirst();
      }
      if (updated === undefined) throw new UnauthenticatedException();

      return {
        display_name: updated.display_name,
        profile_updated: true,
        updated_at: updated.updated_at.toISOString(),
      };
    });
  }

  private async changePasswordInDatabase(
    command: ChangePasswordCommand,
  ): Promise<ChangePasswordResult> {
    await this.rateLimiter.ensureAvailable();
    const passwordIdentity = await this.database
      .selectFrom("users")
      .select(["deleted_at", "display_name", "email_normalized", "is_active"])
      .where("id", "=", command.userId)
      .executeTakeFirst();
    if (
      passwordIdentity === undefined ||
      !passwordIdentity.is_active ||
      passwordIdentity.deleted_at !== null
    ) {
      throw new UnauthenticatedException();
    }
    const normalizedNewPassword = requireAcceptedNewPassword(command.newPassword, {
      displayName: passwordIdentity.display_name,
      email: passwordIdentity.email_normalized,
    });
    const newPasswordHash = await hashPassword(normalizedNewPassword);

    const notice = await this.database.transaction().execute(async (transaction) => {
      const now = new Date();
      const account = await transaction
        .selectFrom("users")
        .select([
          "deleted_at",
          "display_name",
          "email_normalized",
          "email_verified_at",
          "is_active",
          "password_hash",
          "password_input_version",
        ])
        .where("id", "=", command.userId)
        .forUpdate()
        .executeTakeFirst();

      if (account === undefined || !account.is_active || account.deleted_at !== null) {
        throw new UnauthenticatedException();
      }

      const session = await transaction
        .selectFrom("sessions")
        .select(["expires_at", "revoked_at"])
        .where("id", "=", command.sessionId)
        .where("user_id", "=", command.userId)
        .forUpdate()
        .executeTakeFirst();

      if (
        session === undefined ||
        session.revoked_at !== null ||
        session.expires_at.getTime() <= now.getTime()
      ) {
        throw new UnauthenticatedException();
      }

      const currentPassword = passwordForVerification(
        command.currentPassword,
        account.password_input_version,
      );
      const currentPasswordMatches = await verifyPassword(
        currentPassword ?? command.currentPassword,
        account.password_hash,
      );
      if (currentPassword === null || !currentPasswordMatches) {
        const limit = await this.rateLimiter.consume({
          key: `password-change-failure:user:${command.userId}:ip:${this.privateIpSubject(
            command.clientIp,
          )}`,
        });

        if (!limit.allowed || limit.remaining === 0)
          throw new RateLimitedException(limit.retryAfterSeconds, limit);
        throw new InvalidCurrentPasswordException();
      }

      requireAcceptedNewPassword(normalizedNewPassword, {
        displayName: account.display_name,
        email: account.email_normalized,
      });

      await transaction
        .updateTable("users")
        .set({
          password_hash: newPasswordHash,
          password_input_version: NFC_PASSWORD_INPUT_VERSION,
          password_last_changed_at: now,
          updated_at: now,
        })
        .where("id", "=", command.userId)
        .executeTakeFirstOrThrow();

      await transaction
        .updateTable("teacher_profiles")
        .set({
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
        })
        .where("user_id", "=", command.userId)
        .execute();

      await transaction
        .updateTable("sessions")
        .set({ revoked_at: now })
        .where("user_id", "=", command.userId)
        .where("revoked_at", "is", null)
        .execute();
      return account.email_verified_at == null
        ? undefined
        : {
            email: account.email_normalized,
            kind: "password_changed" as const,
            occurredAt: now,
          };
    });

    await notifySecurityChange(this.securityMailer, notice);
    return { next_action: "LOGIN", password_changed: true };
  }

  private async deleteAccountInDatabase(
    command: DeleteAccountCommand,
  ): Promise<DeleteAccountResult> {
    if (command.confirmation !== "탈퇴") {
      throw new InvalidAccountDeletionConfirmationException();
    }

    await this.rateLimiter.ensureAvailable();
    const unusablePasswordHash = `deleted$${randomBytes(32).toString("base64url")}`;

    // users를 먼저 잡고 classes를 나중에 잡는 경로다. 자리배치·모둠배치 생성은 반대
    // 순서라 겹치면 교착이 난다(P1-02). 재시도 범위는 트랜잭션까지만이다 — 아래
    // 보안감사 이벤트 발행은 밖에 있어야 재시도돼도 두 번 나가지 않는다.
    const deletion = await executeAccountDeletion(
      this.database,
      this.mariaDb,
      async (transaction) => {
        const account = await transaction
          .selectFrom("users")
          .select(["deleted_at", "is_active", "password_hash", "password_input_version"])
          .where("id", "=", command.userId)
          .forUpdate()
          .executeTakeFirst();

        if (account === undefined || !account.is_active || account.deleted_at !== null) {
          throw new UnauthenticatedException();
        }

        const session = await transaction
          .selectFrom("sessions")
          .select(["expires_at", "revoked_at"])
          .where("id", "=", command.sessionId)
          .where("user_id", "=", command.userId)
          .forUpdate()
          .executeTakeFirst();

        const databaseClock = await (
          this.mariaDb
            ? sql<{ now: Date }>`SELECT UTC_TIMESTAMP(6) AS now`
            : sql<{ now: Date }>`SELECT clock_timestamp() AS now`
        ).execute(transaction);
        const now = databaseClock.rows[0]?.now;
        if (now === undefined) throw new Error("Database clock did not return a timestamp.");

        if (
          session === undefined ||
          session.revoked_at !== null ||
          session.expires_at.getTime() <= now.getTime()
        ) {
          throw new UnauthenticatedException();
        }

        const currentPassword = passwordForVerification(
          command.currentPassword,
          account.password_input_version,
        );
        const currentPasswordMatches = await verifyPassword(
          currentPassword ?? command.currentPassword,
          account.password_hash,
        );
        if (currentPassword === null || !currentPasswordMatches) {
          const limit = await this.rateLimiter.consume({
            key: `account-deletion-failure:user:${command.userId}:ip:${this.deletionIpSubject(
              command.clientIp,
            )}`,
          });

          if (!limit.allowed || limit.remaining === 0)
            throw new RateLimitedException(limit.retryAfterSeconds, limit);
          throw new InvalidCurrentPasswordException();
        }

        if (this.socialIdentityStorage) {
          await socialDatabase(transaction, this.mariaDb)
            .deleteFrom("social_identities")
            .where("user_id", "=", command.userId)
            .execute();
        }
        // 사진 기능을 꺼도 설치돼 있으면 지운다(표 유무만 확인). 뒤 단계가 실패하면 함께 되돌아간다.
        await deleteAccountProfilePhotoIfInstalled(transaction, this.mariaDb, command.userId, {
          declaredInstalled: this.profilePhotosInstalled,
        });
        await deleteAccountPushSubscriptionsIfInstalled(transaction, this.mariaDb, command.userId);
        if (this.mariaDb) {
          return finishMariaDbAccountDeletion(transaction, command, unusablePasswordHash);
        }

        const membershipClassIds = await transaction
          .selectFrom("class_members")
          .select("class_id")
          .where("user_id", "=", command.userId)
          .distinct()
          .orderBy("class_id")
          .execute();
        const classIds = membershipClassIds.map(({ class_id }) => class_id);
        const lockedClasses =
          classIds.length === 0
            ? []
            : await transaction
                .selectFrom("classes")
                .select(["id", "status"])
                .where("id", "in", classIds)
                .orderBy("id")
                .forUpdate()
                .execute();
        const classStatusById = new Map(
          lockedClasses.map((targetClass) => [targetClass.id, targetClass.status]),
        );
        const lockedMemberships = await transaction
          .selectFrom("class_members")
          .select(["class_id", "id", "role", "status"])
          .where("user_id", "=", command.userId)
          .orderBy("class_id")
          .orderBy("id")
          .forUpdate()
          .execute();

        const ownsLiveClass = lockedMemberships.some(
          (membership) =>
            membership.role === "teacher" &&
            membership.status === "approved" &&
            ["active", "suspended"].includes(classStatusById.get(membership.class_id) ?? ""),
        );
        if (ownsLiveClass) throw new AccountDeletionBlockedByClassException();

        const currentMembership = lockedMemberships.find(
          (membership) => membership.status === "pending" || membership.status === "approved",
        );
        const currentStudentMembership =
          currentMembership?.role === "student" ? currentMembership : undefined;

        await transaction
          .selectFrom("email_verification_tokens")
          .select("id")
          .where("user_id", "=", command.userId)
          .where("used_at", "is", null)
          .where("invalidated_at", "is", null)
          .orderBy("id")
          .forUpdate()
          .execute();
        await transaction
          .selectFrom("password_reset_tokens")
          .select("id")
          .where("user_id", "=", command.userId)
          .where("used_at", "is", null)
          .where("invalidated_at", "is", null)
          .orderBy("id")
          .forUpdate()
          .execute();

        if (currentStudentMembership !== undefined) {
          const fromStatus = currentStudentMembership.status as "approved" | "pending";
          const changed = await transaction
            .updateTable("class_members")
            .set({
              display_name_in_class: null,
              row_version: sql`row_version + 1`,
              status: "account_deleted",
              status_changed_at: now,
              student_number: null,
              updated_at: now,
            })
            .where("id", "=", currentStudentMembership.id)
            .where("role", "=", "student")
            .where("status", "=", fromStatus)
            .returning("id")
            .executeTakeFirst();
          if (changed === undefined) throw new UnauthenticatedException();

          const actorMemberId = fromStatus === "approved" ? currentStudentMembership.id : null;
          await transaction
            .insertInto("class_member_status_history")
            .values({
              actor_member_id: actorMemberId,
              actor_operator_id: null,
              actor_user_id: command.userId,
              class_id: currentStudentMembership.class_id,
              from_status: fromStatus,
              member_id: currentStudentMembership.id,
              reason: null,
              to_status: "account_deleted",
            })
            .execute();

          await transaction
            .insertInto("audit_logs")
            .values({
              action: "member.account_deleted",
              actor_display_name_snapshot: DELETED_DISPLAY_NAME,
              actor_member_id: actorMemberId,
              actor_role_snapshot: "student",
              actor_user_id: command.userId,
              after_json: {
                display_name_snapshot: DELETED_DISPLAY_NAME,
                member_id: currentStudentMembership.id,
                reason: null,
                role: "student",
                status: "account_deleted",
              },
              before_json: {
                display_name_snapshot: DELETED_DISPLAY_NAME,
                member_id: currentStudentMembership.id,
                reason: null,
                role: "student",
                status: fromStatus,
              },
              class_id: currentStudentMembership.class_id,
              reason: null,
              request_id: command.requestId,
              target_id: currentStudentMembership.id,
              target_snapshot: null,
              target_type: "member",
            })
            .execute();
        }

        const otherMembershipIds = lockedMemberships
          .filter((membership) => membership.id !== currentStudentMembership?.id)
          .map((membership) => membership.id);
        if (otherMembershipIds.length > 0) {
          await transaction
            .updateTable("class_members")
            .set({ display_name_in_class: null, student_number: null, updated_at: now })
            .where("id", "in", otherMembershipIds)
            .execute();
        }

        await transaction
          .updateTable("email_verification_tokens")
          .set({ invalidated_at: now })
          .where("user_id", "=", command.userId)
          .where("used_at", "is", null)
          .where("invalidated_at", "is", null)
          .execute();
        await transaction
          .updateTable("password_reset_tokens")
          .set({ invalidated_at: now })
          .where("user_id", "=", command.userId)
          .where("used_at", "is", null)
          .where("invalidated_at", "is", null)
          .execute();
        await transaction
          .updateTable("sessions")
          .set({ revoked_at: now })
          .where("user_id", "=", command.userId)
          .where("revoked_at", "is", null)
          .execute();

        const assessmentTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.student_assessment_records') IS NOT NULL AS exists
      `.execute(transaction);
        if (assessmentTable.rows[0]?.exists) {
          await transaction
            .deleteFrom("student_assessment_records")
            .where("owner_user_id", "=", command.userId)
            .execute();
        }

        const pollVotesTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.poll_votes') IS NOT NULL AS exists
      `.execute(transaction);
        const membershipIds = lockedMemberships.map(({ id }) => id);
        if (pollVotesTable.rows[0]?.exists && membershipIds.length > 0) {
          await transaction
            .deleteFrom("poll_votes")
            .where("member_id", "in", membershipIds)
            .execute();
        }

        const seatAssignmentsTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.seat_draw_assignments') IS NOT NULL AS exists
      `.execute(transaction);
        if (seatAssignmentsTable.rows[0]?.exists && membershipIds.length > 0) {
          await transaction
            .deleteFrom("seat_draw_assignments")
            .where("member_id", "in", membershipIds)
            .execute();
        }

        const teamAssignmentsTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.team_draw_assignments') IS NOT NULL AS exists
      `.execute(transaction);
        if (teamAssignmentsTable.rows[0]?.exists && membershipIds.length > 0) {
          await transaction
            .deleteFrom("team_draw_assignments")
            .where("member_id", "in", membershipIds)
            .execute();
        }

        /*
         * **선거와 당번도 지운다**(2026-08-22 감사 RED/BLUE-03, Hex 승인).
         *
         * 방침 §3.4 는 계정을 지우면 "해당 학생의 행이 삭제된다"고 약속하는데
         * 선거·당번은 남고 있었다. 후보 기록과 당번 배정에는 **그때의 표시명과 학생
         * 번호가 사본으로** 들어 있어서, 탈퇴한 뒤에도 교사 화면에 이름이 계속 보였다.
         *
         * 참여 기록은 DELETE 권한이 없어 못 지웠다 — 마이그레이션 36000 이 열었다.
         * 개표 결과는 `election_tallies` 에 따로 세므로 이 삭제로 바뀌지 않는다.
         */
        const electionParticipantsTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.election_participants') IS NOT NULL AS exists
      `.execute(transaction);
        if (electionParticipantsTable.rows[0]?.exists && membershipIds.length > 0) {
          await transaction
            .deleteFrom("election_participants")
            .where("member_id", "in", membershipIds)
            .execute();
          /*
           * ⚠️ **후보 행은 지우지 않고 이름만 지운다.** 개표 결과(`election_tallies`)가
           * 후보를 `ON DELETE RESTRICT` 로 참조하므로, 행을 지우면 삭제가 막히거나
           * **지난 선거의 개표 결과가 함께 사라진다.** 남겨야 하는 것은 "몇 표였나"이고
           * 지워야 하는 것은 "누구였나"라서, 표시명과 학생번호만 비운다.
           */
          await transaction
            .updateTable("election_candidates")
            .set({ display_name_snapshot: DELETED_DISPLAY_NAME, student_number_snapshot: null })
            .where("member_id", "in", membershipIds)
            .execute();
        }

        const dutyAssignmentsTable = await sql<{ exists: boolean }>`
        SELECT to_regclass('public.duty_assignments') IS NOT NULL AS exists
      `.execute(transaction);
        if (dutyAssignmentsTable.rows[0]?.exists && membershipIds.length > 0) {
          await transaction
            .deleteFrom("duty_assignments")
            .where("member_id", "in", membershipIds)
            .execute();
        }

        await transaction
          .updateTable("user_consents")
          .set({
            ip_address: null,
            retention_expires_at: new Date(now.getTime() + CONSENT_RETENTION_MILLISECONDS),
            withdrawn_at: now,
          })
          .where("user_id", "=", command.userId)
          .where("withdrawn_at", "is", null)
          .where("retention_expires_at", "is", null)
          .execute();

        await minimizeDeletedAccountGuardianConsent(transaction, command.userId);

        await transaction
          .updateTable("users")
          .set({
            anonymized_at: now,
            deleted_at: now,
            display_name: DELETED_DISPLAY_NAME,
            email_normalized: `deleted+${command.userId}@invalid.local`,
            failed_login_attempts: 0,
            is_active: false,
            locked_until: null,
            password_hash: unusablePasswordHash,
            password_last_changed_at: now,
            updated_at: now,
          })
          .where("id", "=", command.userId)
          .where("is_active", "=", true)
          .where("deleted_at", "is", null)
          .returning("id")
          .executeTakeFirstOrThrow();

        return { actorClassId: currentMembership?.class_id ?? null, occurredAt: now };
      },
    );

    const event: SecurityAuditEvent = {
      version: 1,
      event_id: randomUUID(),
      occurred_at: deletion.occurredAt.toISOString(),
      actor_user_id: command.userId,
      actor_email_hmac: null,
      hmac_key_version: null,
      actor_ip: command.clientIp,
      actor_class_id: deletion.actorClassId,
      target_class_id: null,
      action: "account.deleted",
      resource: "account",
      sanitized_path: "/api/v1/account/deletion",
      method: "POST",
      deny_reason: null,
      failure_code: null,
      request_id: command.requestId,
      user_agent: sanitizeSecurityAuditUserAgent(command.userAgent),
    };
    try {
      await this.securityAuditPublisher.publish(event);
    } catch {
      try {
        this.logger.error({
          action: "security_audit.publish_failed",
          event_id: event.event_id,
          failure_code: "security_publisher_unhandled",
          request_id: command.requestId,
        });
      } catch {
        // A broken fallback logger must not change the committed deletion result.
      }
    }

    return { account_deleted: true, next_action: "LOGIN" };
  }

  private privateIpSubject(clientIp: string): string {
    return createPrivacySafeSubject(
      this.config.emailHmacKey,
      this.config.emailHmacKeyVersion,
      "password_change_failure_ip",
      clientIp,
    );
  }

  private deletionIpSubject(clientIp: string): string {
    return createPrivacySafeSubject(
      this.config.emailHmacKey,
      this.config.emailHmacKeyVersion,
      "account_deletion_failure_ip",
      clientIp,
    );
  }
}
