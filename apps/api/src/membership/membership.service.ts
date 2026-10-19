import { withSerializationRetry, type DB } from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql, type Transaction } from "kysely";

import { hasApprovedAccountAccess } from "../auth/account-access-policy.js";
import { createPrivacySafeSubject } from "../auth/auth-crypto.js";
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import type { AuthConfig } from "../auth/auth.types.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NOTIFICATION_MAILER,
  notificationDelivery,
  type NotificationMailer,
} from "../mail/notification-mailer.js";
import {
  CurrentMembershipExistsException,
  EmailNotVerifiedException,
  InvalidInviteCodeException,
  MembershipRequestNotAllowedException,
  MembershipStatusChangedException,
} from "./membership.errors.js";
import type {
  CreateMembershipRequestCommand,
  CreateMembershipRequestResult,
  OwnMembershipTransitionCommand,
  OwnMembershipTransitionResult,
} from "./membership.types.js";

const REUSABLE_STATUSES = new Set(["rejected", "canceled", "left", "removed", "rejoin_allowed"]);

@Injectable()
export class MembershipService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
    @Optional()
    @Inject(NOTIFICATION_MAILER)
    protected readonly notifications?: NotificationMailer,
  ) {}

  async createRequest(
    command: CreateMembershipRequestCommand,
  ): Promise<CreateMembershipRequestResult> {
    const inviteCode = command.inviteCode.trim().toUpperCase();
    const ipLimit = await this.rateLimiter.consume({
      key: `invite-code:ip:${createPrivacySafeSubject(
        this.authConfig.emailHmacKey,
        this.authConfig.emailHmacKeyVersion,
        "invite_code_ip",
        `${command.userId}:${command.clientIp}`,
      )}`,
    });
    if (!ipLimit.allowed) throw new RateLimitedException(ipLimit.retryAfterSeconds, ipLimit);

    const accountLimit = await this.rateLimiter.consume({
      key: `membership-request:user:${command.userId}`,
    });
    if (!accountLimit.allowed)
      throw new RateLimitedException(accountLimit.retryAfterSeconds, accountLimit);

    const preliminaryInvite = await this.database.transaction().execute(async (transaction) => {
      await this.lockAndValidateRequestEligibility(transaction, command.userId);

      const invite = await transaction
        .selectFrom("class_invite_codes")
        .innerJoin("classes", "classes.id", "class_invite_codes.class_id")
        .select("class_invite_codes.class_id")
        .where("class_invite_codes.code", "=", inviteCode)
        .where("class_invite_codes.revoked_at", "is", null)
        .where("class_invite_codes.expires_at", ">", new Date())
        .where("classes.status", "=", "active")
        .executeTakeFirst();
      if (invite === undefined) {
        if (accountLimit.remaining === 0)
          throw new RateLimitedException(accountLimit.retryAfterSeconds, accountLimit);
        throw new InvalidInviteCodeException();
      }
      return invite;
    });

    let notification: { className: string; email: string } | undefined;
    const result = await this.database
      .transaction()
      .execute<CreateMembershipRequestResult>(async (transaction) => {
        const now = new Date();
        const account = await this.lockAndValidateRequestEligibility(transaction, command.userId);

        const targetClass = await transaction
          .selectFrom("classes")
          .select(["id", "name", "status"])
          .where("id", "=", preliminaryInvite.class_id)
          .forUpdate()
          .executeTakeFirst();
        if (targetClass === undefined || targetClass.status !== "active") {
          throw new InvalidInviteCodeException();
        }

        const validInvite = await transaction
          .selectFrom("class_invite_codes")
          .select("id")
          .where("class_id", "=", targetClass.id)
          .where("code", "=", inviteCode)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", now)
          .forUpdate()
          .executeTakeFirst();
        if (validInvite === undefined) throw new InvalidInviteCodeException();

        const existing = await transaction
          .selectFrom("class_members")
          .select(["display_name_in_class", "id", "role", "row_version", "status"])
          .where("class_id", "=", targetClass.id)
          .where("user_id", "=", command.userId)
          .forUpdate()
          .executeTakeFirst();

        if (existing !== undefined && !REUSABLE_STATUSES.has(existing.status)) {
          throw new MembershipRequestNotAllowedException();
        }

        const previousReason =
          existing === undefined
            ? null
            : ((
                await transaction
                  .selectFrom("class_member_status_history")
                  .select("reason")
                  .where("member_id", "=", existing.id)
                  .where("to_status", "=", existing.status)
                  .orderBy("created_at", "desc")
                  .orderBy("id", "desc")
                  .executeTakeFirst()
              )?.reason ?? null);

        const member =
          existing === undefined
            ? await transaction
                .insertInto("class_members")
                .values({
                  class_id: targetClass.id,
                  role: "student",
                  status: "pending",
                  user_id: command.userId,
                })
                .returning(["display_name_in_class", "id", "role", "row_version", "status"])
                .executeTakeFirstOrThrow()
            : await transaction
                .updateTable("class_members")
                .set({
                  row_version: sql`row_version + 1`,
                  status: "pending",
                  status_changed_at: now,
                  updated_at: now,
                })
                .where("id", "=", existing.id)
                .where("status", "=", existing.status)
                .returning(["display_name_in_class", "id", "role", "row_version", "status"])
                .executeTakeFirstOrThrow();

        await transaction
          .insertInto("class_member_status_history")
          .values({
            actor_member_id: null,
            actor_operator_id: null,
            actor_user_id: command.userId,
            class_id: targetClass.id,
            from_status: existing?.status ?? null,
            member_id: member.id,
            reason: null,
            to_status: "pending",
          })
          .execute();

        const displayNameSnapshot = member.display_name_in_class ?? account.display_name;
        const afterSnapshot = {
          display_name_snapshot: displayNameSnapshot,
          member_id: member.id,
          reason: null,
          role: "student",
          status: "pending",
        };
        const beforeSnapshot =
          existing === undefined
            ? null
            : {
                display_name_snapshot: existing.display_name_in_class ?? account.display_name,
                member_id: existing.id,
                reason: previousReason,
                role: existing.role,
                status: existing.status,
              };

        await transaction
          .insertInto("audit_logs")
          .values({
            action: "member.requested",
            actor_display_name_snapshot: account.display_name,
            actor_member_id: null,
            actor_role_snapshot: "student",
            actor_user_id: command.userId,
            after_json: afterSnapshot,
            before_json: beforeSnapshot,
            class_id: targetClass.id,
            reason: null,
            request_id: command.requestId,
            target_id: member.id,
            target_snapshot: null,
            target_type: "member",
          })
          .execute();

        notification = { className: targetClass.name, email: account.email_normalized };
        return {
          class_id: targetClass.id,
          membership_id: member.id,
          next_action: "BOOTSTRAP" as const,
          row_version: member.row_version,
          status: "pending" as const,
        };
      });
    if (this.notifications === undefined) return result;
    return {
      ...result,
      ...(await this.sendRequestNotifications(result.class_id, notification)),
    };
  }

  protected async sendRequestNotifications(
    classId: string,
    details: { className: string; email: string } | undefined,
  ): Promise<
    Pick<
      CreateMembershipRequestResult,
      "email_delivery_status" | "teacher_notification_delivery_status"
    >
  > {
    const notifications = this.notifications;
    if (notifications === undefined || details === undefined) {
      return { email_delivery_status: "failed", teacher_notification_delivery_status: "failed" };
    }
    // The request transaction has committed before recipient lookup or SMTP starts.
    const [studentDelivery, teacherDelivery] = await Promise.all([
      notificationDelivery(() =>
        notifications.sendClassJoinRequestedEmail(details.email, details.className),
      ),
      notificationDelivery(async () => {
        const teachers = await this.database
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .innerJoin("classes as class", "class.id", "member.class_id")
          .innerJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
          .select("account.email_normalized")
          .where("member.class_id", "=", classId)
          .where("member.role", "=", "teacher")
          .where("member.status", "=", "approved")
          .where("class.status", "=", "active")
          .where("account.is_active", "=", true)
          .where("account.deleted_at", "is", null)
          .where("profile.status", "=", "active")
          .where("profile.temporary_password_must_change", "=", false)
          .execute();
        const deliveries = await Promise.all(
          [...new Set(teachers.map((teacher) => teacher.email_normalized))].map((email) =>
            notificationDelivery(() =>
              notifications.sendClassJoinRequestEmail(email, details.className),
            ),
          ),
        );
        return deliveries.length > 0 && deliveries.every((delivery) => delivery === "sent")
          ? "sent"
          : "failed";
      }),
    ]);
    return {
      email_delivery_status: studentDelivery,
      teacher_notification_delivery_status: teacherDelivery,
    };
  }

  private async lockAndValidateRequestEligibility(
    transaction: Transaction<DB>,
    userId: string,
  ): Promise<{ display_name: string; email_normalized: string }> {
    const account = await transaction
      .selectFrom("users")
      .select([
        "deleted_at",
        "display_name",
        "email_normalized",
        "email_verified_at",
        "is_active",
        "signup_approved_at",
        "signup_role",
      ])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }
    if (!hasApprovedAccountAccess(account)) throw new EmailNotVerifiedException();

    const teacherProfile = await transaction
      .selectFrom("teacher_profiles")
      .select("id")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (teacherProfile !== undefined) throw new MembershipRequestNotAllowedException();

    const currentMembership = await transaction
      .selectFrom("class_members")
      .select("id")
      .where("user_id", "=", userId)
      .where("status", "in", ["pending", "approved"])
      .forUpdate()
      .executeTakeFirst();
    if (currentMembership !== undefined) throw new CurrentMembershipExistsException();

    return { display_name: account.display_name, email_normalized: account.email_normalized };
  }

  cancelCurrentRequest(
    command: OwnMembershipTransitionCommand,
  ): Promise<OwnMembershipTransitionResult> {
    return this.transitionOwnMembership(command, {
      action: "member.request_canceled",
      clearStudentNumber: false,
      expectedStatus: "pending",
      nextStatus: "canceled",
    });
  }

  leaveCurrentMembership(
    command: OwnMembershipTransitionCommand,
  ): Promise<OwnMembershipTransitionResult> {
    return this.transitionOwnMembership(command, {
      action: "member.left",
      clearStudentNumber: true,
      expectedStatus: "approved",
      nextStatus: "left",
    });
  }

  private async transitionOwnMembership(
    command: OwnMembershipTransitionCommand,
    transition:
      | {
          action: "member.request_canceled";
          clearStudentNumber: false;
          expectedStatus: "pending";
          nextStatus: "canceled";
        }
      | {
          action: "member.left";
          clearStudentNumber: true;
          expectedStatus: "approved";
          nextStatus: "left";
        },
  ): Promise<OwnMembershipTransitionResult> {
    const identity = await this.database
      .selectFrom("class_members")
      .select(["class_id", "id"])
      .where("user_id", "=", command.userId)
      .where("role", "=", "student")
      .where("status", "=", transition.expectedStatus)
      .executeTakeFirst();
    if (identity === undefined) throw new MembershipStatusChangedException();

    // 이 경로는 자기 users를 먼저 잡고 classes를 나중에 잡는데, 자리배치·모둠배치
    // 생성은 반대 순서라 겹치면 교착이 난다(P1-02). 어느 쪽이 희생자가 될지는
    // PostgreSQL이 고르므로 양쪽 모두 재시도를 걸어야 500이 새지 않는다.
    return withSerializationRetry(() =>
      this.database.transaction().execute(async (transaction) => {
        const now = new Date();
        const account = await transaction
          .selectFrom("users")
          .select(["deleted_at", "display_name", "is_active"])
          .where("id", "=", command.userId)
          .forUpdate()
          .executeTakeFirst();
        if (account === undefined || !account.is_active || account.deleted_at !== null) {
          throw new UnauthenticatedException();
        }

        const targetClass = await transaction
          .selectFrom("classes")
          .select(["id", "status"])
          .where("id", "=", identity.class_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          targetClass === undefined ||
          (targetClass.status !== "active" && targetClass.status !== "suspended")
        ) {
          throw new MembershipStatusChangedException();
        }

        const member = await transaction
          .selectFrom("class_members")
          .select(["display_name_in_class", "id", "role", "row_version", "status"])
          .where("id", "=", identity.id)
          .where("class_id", "=", targetClass.id)
          .where("user_id", "=", command.userId)
          .forUpdate()
          .executeTakeFirst();
        if (
          member === undefined ||
          member.role !== "student" ||
          member.status !== transition.expectedStatus
        ) {
          throw new MembershipStatusChangedException();
        }

        const changed = await transaction
          .updateTable("class_members")
          .set({
            row_version: sql`row_version + 1`,
            status: transition.nextStatus,
            status_changed_at: now,
            student_number: transition.clearStudentNumber ? null : undefined,
            updated_at: now,
          })
          .where("id", "=", member.id)
          .where("status", "=", transition.expectedStatus)
          .returning(["id", "row_version", "status", "status_changed_at"])
          .executeTakeFirst();
        if (changed === undefined) throw new MembershipStatusChangedException();

        if (transition.nextStatus === "left") {
          const seatAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.seat_draw_assignments') IS NOT NULL AS exists
        `.execute(transaction);
          if (seatAssignmentsTable.rows[0]?.exists) {
            await transaction
              .deleteFrom("seat_draw_assignments")
              .where("member_id", "=", changed.id)
              .execute();
          }
          const teamAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.team_draw_assignments') IS NOT NULL AS exists
        `.execute(transaction);
          if (teamAssignmentsTable.rows[0]?.exists) {
            await transaction
              .deleteFrom("team_draw_assignments")
              .where("member_id", "=", changed.id)
              .execute();
          }
          /*
           * 당번 배정도 뺀다 — 자리·모둠과 **같은 이유**다. 반을 떠난 학생이 이번 주
           * 당번 명단에 남아 있으면 안 된다(2026-08-22 감사 RED/BLUE-03).
           *
           * ⚠️ **선거 기록은 여기서 건드리지 않는다.** 반을 떠나는 것은 계정을 지우는
           * 것이 아니고, 지난 선거의 참여·후보 기록은 **그 선거의 기록**이라 반을
           * 떠난다고 무효가 되지 않는다. 개인정보를 지우는 것은 계정 삭제 경로의 몫이다
           * (`account.service.ts`).
           */
          const dutyAssignmentsTable = await sql<{ exists: boolean }>`
          SELECT to_regclass('public.duty_assignments') IS NOT NULL AS exists
        `.execute(transaction);
          if (dutyAssignmentsTable.rows[0]?.exists) {
            await transaction
              .deleteFrom("duty_assignments")
              .where("member_id", "=", changed.id)
              .execute();
          }
        }

        const actorMemberId = transition.expectedStatus === "approved" ? member.id : null;

        await transaction
          .insertInto("class_member_status_history")
          .values({
            actor_member_id: actorMemberId,
            actor_operator_id: null,
            actor_user_id: command.userId,
            class_id: targetClass.id,
            from_status: transition.expectedStatus,
            member_id: member.id,
            reason: null,
            to_status: transition.nextStatus,
          })
          .execute();

        const displayName = member.display_name_in_class ?? account.display_name;
        const beforeSnapshot = {
          display_name_snapshot: displayName,
          member_id: member.id,
          reason: null,
          role: "student",
          status: transition.expectedStatus,
        };
        const afterSnapshot = {
          display_name_snapshot: displayName,
          member_id: member.id,
          reason: null,
          role: "student",
          status: transition.nextStatus,
        };
        await transaction
          .insertInto("audit_logs")
          .values({
            action: transition.action,
            actor_display_name_snapshot: account.display_name,
            actor_member_id: actorMemberId,
            actor_role_snapshot: "student",
            actor_user_id: command.userId,
            after_json: afterSnapshot,
            before_json: beforeSnapshot,
            class_id: targetClass.id,
            reason: null,
            request_id: command.requestId,
            target_id: member.id,
            target_snapshot: null,
            target_type: "member",
          })
          .execute();

        return {
          class_id: targetClass.id,
          membership_id: changed.id,
          next_action: "BOOTSTRAP" as const,
          row_version: changed.row_version,
          status: changed.status as "canceled" | "left",
          status_changed_at: changed.status_changed_at,
        };
      }),
    );
  }
}
