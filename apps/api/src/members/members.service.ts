import { Inject, Injectable, Optional } from "@nestjs/common";
import { matchesDatabaseConstraint } from "@classhub/db";
import { sql } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { ResourceVersionChangedException } from "../common/http/if-match.js";
import { maskEmail } from "../common/privacy/mask-email.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  NOTIFICATION_MAILER,
  notificationDelivery,
  type MailDeliveryStatus,
  type MembershipMailStatus,
  type NotificationMailer,
} from "../mail/notification-mailer.js";
import {
  ClassSuspendedException,
  MemberAccountInactiveException,
  MemberNotFoundException,
  MemberStatusChangedException,
  RoleInsufficientException,
  StudentNumberAlreadyInUseException,
} from "./members.errors.js";
import { includeMemberInClassWideContent } from "../content-audiences/class-wide-recipients.js";
import type {
  ApproveMemberCommand,
  ApproveMemberResult,
  GetMemberProfileResult,
  ListMembersResult,
  ManageableMemberStatus,
  MemberListItem,
  MemberTransitionCommand,
  MemberTransitionResult,
  MemberTransitionStatus,
  UpdateMemberProfileCommand,
  UpdateMemberProfileResult,
} from "./members.types.js";

const DEFAULT_STATUSES: ManageableMemberStatus[] = ["pending", "approved"];
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

interface MemberStatusNotification {
  className: string;
  email: string | null;
}

function isActiveAccount(account: { deleted_at: Date | null; is_active: boolean }): boolean {
  return account.is_active && account.deleted_at === null;
}

function isStudentNumberConflict(error: unknown): boolean {
  return matchesDatabaseConstraint(error, {
    kind: "unique_violation",
    objectName: "class_members_student_number_unique",
  });
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional()
    @Inject(NOTIFICATION_MAILER)
    protected readonly notifications?: NotificationMailer,
  ) {}

  async list(actorUserId: string, statusFilter?: string): Promise<ListMembersResult> {
    const context = await this.getCurrentContext(actorUserId);
    this.assertTeacherAccess(context);
    const statuses =
      statusFilter === undefined
        ? DEFAULT_STATUSES
        : ([...new Set(statusFilter.split(","))] as ManageableMemberStatus[]);

    const rows = await this.database
      .selectFrom("class_members as member")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select([
        "account.deleted_at",
        "account.display_name as account_display_name",
        "account.email_normalized",
        "account.is_active",
        "member.display_name_in_class",
        "member.id",
        "member.row_version",
        "member.status",
        "member.status_changed_at",
        "member.student_number",
      ])
      .where("member.class_id", "=", context.classId)
      .where("member.role", "=", "student")
      .where("member.status", "in", statuses)
      .execute();

    const members = rows.map((row): MemberListItem => {
      const status = row.status as ManageableMemberStatus;
      return {
        account_state: isActiveAccount(row) ? "active" : "inactive",
        display_name: row.display_name_in_class ?? row.account_display_name,
        display_name_in_class: row.display_name_in_class,
        ...(status === "pending" ? { email_masked: maskEmail(row.email_normalized) } : {}),
        id: row.id,
        requested_at: status === "pending" ? row.status_changed_at.toISOString() : null,
        row_version: row.row_version,
        status,
        status_changed_at: row.status_changed_at.toISOString(),
        student_number: row.student_number,
      };
    });

    members.sort((left, right) => this.compareMembers(left, right));
    return { members };
  }

  async getProfile(actorUserId: string, memberId: string): Promise<GetMemberProfileResult> {
    if (!this.isDatabaseId(memberId)) throw new MemberNotFoundException();
    const context = await this.getCurrentContext(actorUserId);
    this.assertTeacherAccess(context);

    const row = await this.database
      .selectFrom("class_members as member")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select([
        "account.deleted_at",
        "account.display_name as account_display_name",
        "account.is_active",
        "member.display_name_in_class",
        "member.id",
        "member.row_version",
        "member.status",
        "member.status_changed_at",
        "member.student_number",
      ])
      .where("member.id", "=", memberId)
      .where("member.class_id", "=", context.classId)
      .where("member.role", "=", "student")
      .where("member.status", "=", "approved")
      .executeTakeFirst();
    if (row === undefined) throw new MemberNotFoundException();

    return {
      member: {
        account_state: isActiveAccount(row) ? "active" : "inactive",
        display_name: row.display_name_in_class ?? row.account_display_name,
        display_name_in_class: row.display_name_in_class,
        id: row.id,
        requested_at: null,
        row_version: row.row_version,
        status: "approved",
        status_changed_at: row.status_changed_at.toISOString(),
        student_number: row.student_number,
      },
    };
  }

  async approve(command: ApproveMemberCommand): Promise<ApproveMemberResult> {
    if (!/^\d+$/u.test(command.memberId)) throw new MemberNotFoundException();
    const context = await this.getCurrentContext(command.actorUserId);
    const target = await this.database
      .selectFrom("class_members")
      .select(["class_id", "id", "user_id"])
      .where("id", "=", command.memberId)
      .executeTakeFirst();
    if (target === undefined || target.class_id !== context.classId) {
      throw new MemberNotFoundException();
    }
    this.assertTeacherAccess(context);

    try {
      let notification: MemberStatusNotification | undefined;
      const result = await this.database
        .transaction()
        .execute<ApproveMemberResult>(async (transaction) => {
          const userIds = [...new Set([command.actorUserId, target.user_id])].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : 1,
          );
          const accounts = await transaction
            .selectFrom("users")
            .select(["deleted_at", "display_name", "email_normalized", "id", "is_active"])
            .where("id", "in", userIds)
            .orderBy("id")
            .forUpdate()
            .execute();
          const actorAccount = accounts.find((account) => account.id === command.actorUserId);
          const targetAccount = accounts.find((account) => account.id === target.user_id);
          if (targetAccount === undefined || !isActiveAccount(targetAccount)) {
            throw new MemberAccountInactiveException();
          }
          if (actorAccount === undefined || !isActiveAccount(actorAccount)) {
            throw new RoleInsufficientException();
          }

          const targetClass = await transaction
            .selectFrom("classes")
            .select(["expected_student_count", "id", "name", "status"])
            .where("id", "=", context.classId)
            .forUpdate()
            .executeTakeFirst();
          if (targetClass === undefined || targetClass.status === "archived") {
            throw new MemberNotFoundException();
          }
          if (targetClass.status === "suspended") throw new ClassSuspendedException();

          const lockedMembers = await transaction
            .selectFrom("class_members")
            .select([
              "class_id",
              "display_name_in_class",
              "id",
              "role",
              "row_version",
              "status",
              "user_id",
            ])
            .where("id", "in", [context.actorMemberId, target.id])
            .orderBy("id")
            .forUpdate()
            .execute();
          const actorMember = lockedMembers.find((member) => member.id === context.actorMemberId);
          const targetMember = lockedMembers.find((member) => member.id === target.id);
          if (
            actorMember === undefined ||
            actorMember.class_id !== targetClass.id ||
            actorMember.user_id !== command.actorUserId ||
            actorMember.role !== "teacher" ||
            actorMember.status !== "approved"
          ) {
            throw new RoleInsufficientException();
          }
          const teacherProfile = await transaction
            .selectFrom("teacher_profiles")
            .select(["status", "temporary_password_must_change"])
            .where("user_id", "=", command.actorUserId)
            .executeTakeFirst();
          if (
            teacherProfile?.status !== "active" ||
            teacherProfile.temporary_password_must_change
          ) {
            throw new RoleInsufficientException();
          }
          if (
            targetMember === undefined ||
            targetMember.class_id !== targetClass.id ||
            targetMember.role !== "student"
          ) {
            throw new MemberNotFoundException();
          }
          if (targetMember.status !== "pending") throw new MemberStatusChangedException();

          if (command.studentNumber !== null) {
            const duplicateNumber = await transaction
              .selectFrom("class_members")
              .select("id")
              .where("class_id", "=", targetClass.id)
              .where("status", "=", "approved")
              .where("student_number", "=", command.studentNumber)
              .executeTakeFirst();
            if (duplicateNumber !== undefined) throw new StudentNumberAlreadyInUseException();
          }

          const now = new Date();
          const approved = await transaction
            .updateTable("class_members")
            .set({
              display_name_in_class: command.displayNameInClass,
              row_version: sql`row_version + 1`,
              status: "approved",
              status_changed_at: now,
              student_number: command.studentNumber,
              updated_at: now,
            })
            .where("id", "=", targetMember.id)
            .where("status", "=", "pending")
            .returning([
              "display_name_in_class",
              "id",
              "row_version",
              "status",
              "status_changed_at",
              "student_number",
            ])
            .executeTakeFirst();
          if (approved === undefined) throw new MemberStatusChangedException();

          await transaction
            .deleteFrom("notice_reads")
            .where("member_id", "=", targetMember.id)
            .execute();
          await transaction
            .deleteFrom("supply_checks")
            .where("member_id", "=", targetMember.id)
            .execute();
          await includeMemberInClassWideContent(transaction, targetClass.id, approved.id);
          await transaction
            .insertInto("class_member_status_history")
            .values({
              actor_member_id: actorMember.id,
              actor_operator_id: null,
              actor_user_id: command.actorUserId,
              class_id: targetClass.id,
              from_status: "pending",
              member_id: approved.id,
              reason: null,
              to_status: "approved",
            })
            .execute();

          const beforeDisplayName =
            targetMember.display_name_in_class ?? targetAccount.display_name;
          const afterDisplayName = approved.display_name_in_class ?? targetAccount.display_name;
          const beforeSnapshot = {
            display_name_snapshot: beforeDisplayName,
            member_id: approved.id,
            reason: null,
            role: "student",
            status: "pending",
          };
          const afterSnapshot = {
            display_name_snapshot: afterDisplayName,
            member_id: approved.id,
            reason: null,
            role: "student",
            status: "approved",
          };
          await transaction
            .insertInto("audit_logs")
            .values({
              action: "member.approved",
              actor_display_name_snapshot: actorAccount.display_name,
              actor_member_id: actorMember.id,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: afterSnapshot,
              before_json: beforeSnapshot,
              class_id: targetClass.id,
              reason: null,
              request_id: command.requestId,
              target_id: approved.id,
              target_snapshot: null,
              target_type: "member",
            })
            .execute();

          const activeApproved = await transaction
            .selectFrom("class_members as member")
            .innerJoin("users as account", "account.id", "member.user_id")
            .select((expression) => expression.fn.countAll<string>().as("count"))
            .where("member.class_id", "=", targetClass.id)
            .where("member.role", "=", "student")
            .where("member.status", "=", "approved")
            .where("account.is_active", "=", true)
            .where("account.deleted_at", "is", null)
            .executeTakeFirstOrThrow();
          const warnings: ApproveMemberResult["warnings"] =
            Number(activeApproved.count) > targetClass.expected_student_count
              ? ["EXPECTED_STUDENT_COUNT_EXCEEDED"]
              : [];

          notification = { className: targetClass.name, email: targetAccount.email_normalized };
          return {
            member: {
              account_state: "active",
              display_name: afterDisplayName,
              display_name_in_class: approved.display_name_in_class,
              id: approved.id,
              requested_at: null,
              row_version: approved.row_version,
              status: "approved",
              status_changed_at: approved.status_changed_at.toISOString(),
              student_number: approved.student_number,
            },
            warnings,
          };
        });
      if (this.notifications === undefined) return result;
      return {
        ...result,
        email_delivery_status: await this.sendStatusEmail(notification, "approved"),
      };
    } catch (error) {
      if (isStudentNumberConflict(error)) throw new StudentNumberAlreadyInUseException();
      throw error;
    }
  }

  async updateProfile(command: UpdateMemberProfileCommand): Promise<UpdateMemberProfileResult> {
    if (!this.isDatabaseId(command.memberId)) throw new MemberNotFoundException();
    const context = await this.getCurrentContext(command.actorUserId);
    this.assertTeacherAccess(context);
    const target = await this.database
      .selectFrom("class_members")
      .select(["class_id", "id", "user_id"])
      .where("id", "=", command.memberId)
      .executeTakeFirst();
    if (target === undefined || target.class_id !== context.classId) {
      throw new MemberNotFoundException();
    }

    try {
      return await this.database.transaction().execute(async (transaction) => {
        const userIds = [...new Set([command.actorUserId, target.user_id])].sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : 1,
        );
        const accounts = await transaction
          .selectFrom("users")
          .select(["deleted_at", "display_name", "id", "is_active"])
          .where("id", "in", userIds)
          .orderBy("id")
          .forUpdate()
          .execute();
        const actorAccount = accounts.find((account) => account.id === command.actorUserId);
        const targetAccount = accounts.find((account) => account.id === target.user_id);
        if (actorAccount === undefined || !isActiveAccount(actorAccount)) {
          throw new UnauthenticatedException();
        }
        if (targetAccount === undefined) throw new MemberNotFoundException();

        const targetClass = await transaction
          .selectFrom("classes")
          .select(["id", "status"])
          .where("id", "=", context.classId)
          .forUpdate()
          .executeTakeFirst();
        if (targetClass === undefined || targetClass.status === "archived") {
          throw new MemberNotFoundException();
        }
        if (targetClass.status === "suspended") throw new ClassSuspendedException();

        const lockedMembers = await transaction
          .selectFrom("class_members")
          .select([
            "class_id",
            "display_name_in_class",
            "id",
            "role",
            "row_version",
            "status",
            "status_changed_at",
            "student_number",
            "updated_at",
            "user_id",
          ])
          .where("id", "in", [context.actorMemberId, target.id])
          .orderBy("id")
          .forUpdate()
          .execute();
        const actorMember = lockedMembers.find((member) => member.id === context.actorMemberId);
        const targetMember = lockedMembers.find((member) => member.id === target.id);
        if (
          actorMember === undefined ||
          actorMember.class_id !== targetClass.id ||
          actorMember.user_id !== command.actorUserId ||
          actorMember.role !== "teacher" ||
          actorMember.status !== "approved"
        ) {
          throw new RoleInsufficientException();
        }
        const teacherProfile = await transaction
          .selectFrom("teacher_profiles")
          .select(["status", "temporary_password_must_change"])
          .where("user_id", "=", command.actorUserId)
          .executeTakeFirst();
        if (teacherProfile?.status !== "active" || teacherProfile.temporary_password_must_change) {
          throw new RoleInsufficientException();
        }
        if (
          targetMember === undefined ||
          targetMember.class_id !== targetClass.id ||
          targetMember.role !== "student"
        ) {
          throw new MemberNotFoundException();
        }
        if (targetMember.row_version !== command.expectedRowVersion) {
          throw new ResourceVersionChangedException(targetMember.row_version);
        }
        if (targetMember.status !== "approved" || targetAccount.deleted_at !== null) {
          throw new MemberStatusChangedException();
        }

        const nextDisplayName =
          command.displayNameInClass === undefined
            ? targetMember.display_name_in_class
            : command.displayNameInClass;
        const nextStudentNumber =
          command.studentNumber === undefined ? targetMember.student_number : command.studentNumber;
        const displayNameChanged = nextDisplayName !== targetMember.display_name_in_class;
        const studentNumberChanged = nextStudentNumber !== targetMember.student_number;

        if (!displayNameChanged && !studentNumberChanged) {
          return {
            member: {
              account_state: isActiveAccount(targetAccount) ? "active" : "inactive",
              display_name: targetMember.display_name_in_class ?? targetAccount.display_name,
              display_name_in_class: targetMember.display_name_in_class,
              id: targetMember.id,
              requested_at: null,
              row_version: targetMember.row_version,
              status: "approved",
              status_changed_at: targetMember.status_changed_at.toISOString(),
              student_number: targetMember.student_number,
            },
            profile_updated: false,
          };
        }

        if (studentNumberChanged && nextStudentNumber !== null) {
          const duplicateNumber = await transaction
            .selectFrom("class_members")
            .select("id")
            .where("class_id", "=", targetClass.id)
            .where("id", "!=", targetMember.id)
            .where("status", "=", "approved")
            .where("student_number", "=", nextStudentNumber)
            .executeTakeFirst();
          if (duplicateNumber !== undefined) throw new StudentNumberAlreadyInUseException();
        }

        const clock = await sql<{ occurred_at: Date }>`
          SELECT transaction_timestamp() AS occurred_at
        `.execute(transaction);
        const occurredAt = clock.rows[0]?.occurred_at;
        if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
          throw new Error("PostgreSQL transaction timestamp is unavailable.");
        }

        const updated = await transaction
          .updateTable("class_members")
          .set({
            ...(displayNameChanged ? { display_name_in_class: nextDisplayName } : {}),
            row_version: sql`row_version + 1`,
            ...(studentNumberChanged ? { student_number: nextStudentNumber } : {}),
            updated_at: occurredAt,
          })
          .where("id", "=", targetMember.id)
          .where("row_version", "=", command.expectedRowVersion)
          .where("status", "=", "approved")
          .returning([
            "display_name_in_class",
            "id",
            "row_version",
            "status_changed_at",
            "student_number",
          ])
          .executeTakeFirst();
        if (updated === undefined) {
          throw new ResourceVersionChangedException(targetMember.row_version);
        }

        const beforeJson = displayNameChanged
          ? {
              display_name_snapshot:
                targetMember.display_name_in_class ?? targetAccount.display_name,
            }
          : {};
        const afterJson = displayNameChanged
          ? { display_name_snapshot: updated.display_name_in_class ?? targetAccount.display_name }
          : {};
        await transaction
          .insertInto("audit_logs")
          .values({
            action: "member.profile_updated",
            actor_display_name_snapshot: actorAccount.display_name,
            actor_member_id: actorMember.id,
            actor_role_snapshot: "teacher",
            actor_user_id: command.actorUserId,
            after_json: afterJson,
            before_json: beforeJson,
            class_id: targetClass.id,
            created_at: occurredAt,
            reason: null,
            request_id: command.requestId,
            target_id: updated.id,
            target_snapshot: null,
            target_type: "member",
          })
          .execute();

        return {
          member: {
            account_state: isActiveAccount(targetAccount) ? "active" : "inactive",
            display_name: updated.display_name_in_class ?? targetAccount.display_name,
            display_name_in_class: updated.display_name_in_class,
            id: updated.id,
            requested_at: null,
            row_version: updated.row_version,
            status: "approved",
            status_changed_at: updated.status_changed_at.toISOString(),
            student_number: updated.student_number,
          },
          profile_updated: true,
        };
      });
    } catch (error) {
      if (isStudentNumberConflict(error)) throw new StudentNumberAlreadyInUseException();
      throw error;
    }
  }

  reject(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    return this.transition(command, {
      action: "member.rejected",
      expectedStatus: "pending",
      nextStatus: "rejected",
    });
  }

  remove(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    return this.transition(command, {
      action: "member.removed",
      clearStudentNumber: true,
      expectedStatus: "approved",
      nextStatus: "removed",
    });
  }

  allowRejoin(command: MemberTransitionCommand): Promise<MemberTransitionResult> {
    return this.transition(command, {
      action: "member.rejoin_allowed",
      expectedStatus: "removed",
      nextStatus: "rejoin_allowed",
    });
  }

  private async transition(
    command: MemberTransitionCommand,
    transition: {
      action: "member.rejected" | "member.removed" | "member.rejoin_allowed";
      clearStudentNumber?: boolean;
      expectedStatus: "approved" | "pending" | "removed";
      nextStatus: MemberTransitionStatus;
    },
  ): Promise<MemberTransitionResult> {
    if (!/^\d+$/u.test(command.memberId)) throw new MemberNotFoundException();
    const context = await this.getCurrentContext(command.actorUserId);
    const target = await this.database
      .selectFrom("class_members")
      .select(["class_id", "id", "user_id"])
      .where("id", "=", command.memberId)
      .executeTakeFirst();
    if (target === undefined || target.class_id !== context.classId) {
      throw new MemberNotFoundException();
    }
    this.assertTeacherAccess(context);

    let notification: MemberStatusNotification | undefined;
    const result = await this.database
      .transaction()
      .execute<MemberTransitionResult>(async (transaction) => {
        const userIds = [...new Set([command.actorUserId, target.user_id])].sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : 1,
        );
        const accounts = await transaction
          .selectFrom("users")
          .select(["deleted_at", "display_name", "email_normalized", "id", "is_active"])
          .where("id", "in", userIds)
          .orderBy("id")
          .forUpdate()
          .execute();
        const actorAccount = accounts.find((account) => account.id === command.actorUserId);
        const targetAccount = accounts.find((account) => account.id === target.user_id);
        if (actorAccount === undefined || !isActiveAccount(actorAccount)) {
          throw new RoleInsufficientException();
        }
        if (targetAccount === undefined) throw new MemberNotFoundException();

        const targetClass = await transaction
          .selectFrom("classes")
          .select(["id", "name", "status"])
          .where("id", "=", context.classId)
          .forUpdate()
          .executeTakeFirst();
        if (targetClass === undefined || targetClass.status === "archived") {
          throw new MemberNotFoundException();
        }
        if (targetClass.status === "suspended") throw new ClassSuspendedException();

        const lockedMembers = await transaction
          .selectFrom("class_members")
          .select([
            "class_id",
            "display_name_in_class",
            "id",
            "role",
            "row_version",
            "status",
            "user_id",
          ])
          .where("id", "in", [context.actorMemberId, target.id])
          .orderBy("id")
          .forUpdate()
          .execute();
        const actorMember = lockedMembers.find((member) => member.id === context.actorMemberId);
        const targetMember = lockedMembers.find((member) => member.id === target.id);
        if (
          actorMember === undefined ||
          actorMember.class_id !== targetClass.id ||
          actorMember.user_id !== command.actorUserId ||
          actorMember.role !== "teacher" ||
          actorMember.status !== "approved"
        ) {
          throw new RoleInsufficientException();
        }
        const teacherProfile = await transaction
          .selectFrom("teacher_profiles")
          .select(["status", "temporary_password_must_change"])
          .where("user_id", "=", command.actorUserId)
          .executeTakeFirst();
        if (teacherProfile?.status !== "active" || teacherProfile.temporary_password_must_change) {
          throw new RoleInsufficientException();
        }
        if (
          targetMember === undefined ||
          targetMember.class_id !== targetClass.id ||
          targetMember.role !== "student"
        ) {
          throw new MemberNotFoundException();
        }
        if (targetMember.status !== transition.expectedStatus) {
          throw new MemberStatusChangedException();
        }

        const previousReason =
          (
            await transaction
              .selectFrom("class_member_status_history")
              .select("reason")
              .where("member_id", "=", targetMember.id)
              .where("to_status", "=", transition.expectedStatus)
              .orderBy("created_at", "desc")
              .orderBy("id", "desc")
              .executeTakeFirst()
          )?.reason ?? null;
        const reason = command.reason?.trim() || null;
        const now = new Date();
        const changed = await transaction
          .updateTable("class_members")
          .set({
            ...(transition.clearStudentNumber ? { student_number: null } : {}),
            row_version: sql`row_version + 1`,
            status: transition.nextStatus,
            status_changed_at: now,
            updated_at: now,
          })
          .where("id", "=", targetMember.id)
          .where("status", "=", transition.expectedStatus)
          .returning(["id", "row_version", "status", "status_changed_at"])
          .executeTakeFirst();
        if (changed === undefined) throw new MemberStatusChangedException();

        if (transition.nextStatus === "removed") {
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
           * 당번 배정도 뺀다 — 자리·모둠과 같은 이유다. 내보낸 학생이 당번 명단에 남아
           * 있으면 안 된다(2026-08-22 감사 RED/BLUE-03).
           *
           * ⚠️ 선거 기록은 건드리지 않는다 — 내보내기는 계정 삭제가 아니고, 지난 선거의
           * 기록은 그 선거의 것이다. 개인정보 삭제는 계정 삭제 경로의 몫이다.
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

        await transaction
          .insertInto("class_member_status_history")
          .values({
            actor_member_id: actorMember.id,
            actor_operator_id: null,
            actor_user_id: command.actorUserId,
            class_id: targetClass.id,
            from_status: transition.expectedStatus,
            member_id: changed.id,
            reason,
            to_status: transition.nextStatus,
          })
          .execute();

        const displayName = targetMember.display_name_in_class ?? targetAccount.display_name;
        const beforeSnapshot = {
          display_name_snapshot: displayName,
          member_id: changed.id,
          reason: previousReason,
          role: "student",
          status: transition.expectedStatus,
        };
        const afterSnapshot = {
          display_name_snapshot: displayName,
          member_id: changed.id,
          reason,
          role: "student",
          status: transition.nextStatus,
        };
        await transaction
          .insertInto("audit_logs")
          .values({
            action: transition.action,
            actor_display_name_snapshot: actorAccount.display_name,
            actor_member_id: actorMember.id,
            actor_role_snapshot: "teacher",
            actor_user_id: command.actorUserId,
            after_json: afterSnapshot,
            before_json: beforeSnapshot,
            class_id: targetClass.id,
            reason,
            request_id: command.requestId,
            target_id: changed.id,
            target_snapshot: null,
            target_type: "member",
          })
          .execute();

        notification = {
          className: targetClass.name,
          email: isActiveAccount(targetAccount) ? targetAccount.email_normalized : null,
        };
        return {
          member: {
            id: changed.id,
            reason,
            row_version: changed.row_version,
            status: transition.nextStatus,
            status_changed_at: changed.status_changed_at.toISOString(),
          },
        };
      });
    if (this.notifications === undefined || transition.nextStatus === "rejoin_allowed")
      return result;
    return {
      ...result,
      email_delivery_status: await this.sendStatusEmail(notification, transition.nextStatus),
    };
  }

  protected sendStatusEmail(
    details: MemberStatusNotification | undefined,
    status: MembershipMailStatus,
  ): Promise<MailDeliveryStatus> {
    const notifications = this.notifications;
    if (notifications === undefined || details === undefined || details.email === null) {
      return Promise.resolve("failed");
    }
    const email = details.email;
    // The domain transaction has committed; SMTP failure must not repeat its mutation.
    return notificationDelivery(() =>
      notifications.sendMembershipStatusEmail(email, details.className, status),
    );
  }

  private async getCurrentContext(actorUserId: string): Promise<{
    actorMemberId: string;
    classId: string;
    classStatus: string;
    role: string;
    teacherProfileStatus: string | null;
    temporaryPasswordMustChange: boolean | null;
  }> {
    const context = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.id as class_id",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "in", ["pending", "approved"])
      .executeTakeFirst();
    if (context === undefined) throw new MemberNotFoundException();
    return {
      actorMemberId: context.member_id,
      classId: context.class_id,
      classStatus: context.class_status,
      role: context.role,
      teacherProfileStatus: context.profile_status,
      temporaryPasswordMustChange: context.temporary_password_must_change,
    };
  }

  private assertTeacherAccess(
    context: Awaited<ReturnType<MembersService["getCurrentContext"]>>,
  ): void {
    if (context.classStatus === "suspended") throw new ClassSuspendedException();
    if (
      context.classStatus !== "active" ||
      context.role !== "teacher" ||
      context.teacherProfileStatus !== "active" ||
      context.temporaryPasswordMustChange !== false
    ) {
      throw new RoleInsufficientException();
    }
  }

  private isDatabaseId(value: string): boolean {
    if (!/^[1-9][0-9]*$/u.test(value)) return false;
    try {
      const parsed = BigInt(value);
      return parsed > 0n && parsed <= MAX_DATABASE_ID;
    } catch {
      return false;
    }
  }

  private compareMembers(left: MemberListItem, right: MemberListItem): number {
    const statusOrder: ManageableMemberStatus[] = [
      "pending",
      "approved",
      "removed",
      "rejoin_allowed",
    ];
    if (left.status !== right.status) {
      return statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status);
    }
    if (left.status === "pending") {
      return (
        left.status_changed_at.localeCompare(right.status_changed_at) ||
        Number(BigInt(left.id) - BigInt(right.id))
      );
    }
    if (left.status === "approved") {
      if (left.student_number === null && right.student_number !== null) return 1;
      if (left.student_number !== null && right.student_number === null) return -1;
      if (left.student_number !== right.student_number) {
        return (left.student_number ?? 0) - (right.student_number ?? 0);
      }
      return (
        left.display_name.localeCompare(right.display_name, "ko") ||
        Number(BigInt(left.id) - BigInt(right.id))
      );
    }
    return (
      right.status_changed_at.localeCompare(left.status_changed_at) ||
      Number(BigInt(left.id) - BigInt(right.id))
    );
  }
}
