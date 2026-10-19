import type { DB } from "@classhub/db";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnvironment } from "../config/environment.js";
import {
  attendanceDatabaseEngine,
  attendanceDate,
  attendanceMariaDbRowCodec,
  attendanceTransaction,
  type AttendanceDatabaseEngine,
} from "./attendance-notifications.database.js";
import { sql, type Transaction } from "kysely";

import { hasApprovedAccountAccess } from "../auth/account-access-policy.js";
import { EmailNotVerifiedException, UnauthenticatedException } from "../auth/auth.errors.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import {
  assertFreshAttendanceDate,
  type AttendanceDatabaseClock,
} from "./attendance-notifications-clock.js";
import { AttendanceNotificationDateChangedException } from "./attendance-notifications-command.errors.js";
import type {
  AttendanceMutationStatus,
  AttendanceMutationType,
} from "./attendance-notifications-command.types.js";
import {
  AttendanceClassSuspendedException,
  AttendanceNotFoundException,
  AttendanceRoleInsufficientException,
} from "./attendance-notifications.errors.js";

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

export interface AttendancePreliminaryContext {
  classId: string;
  memberId: string;
  role: "student" | "teacher";
}

export interface AttendancePreliminaryResource {
  context: AttendancePreliminaryContext;
  notificationId: string;
  targetMemberId: string;
}

export interface LockedAttendanceActor extends AttendancePreliminaryContext {
  displayName: string;
}

export interface LockedAttendanceRow {
  acknowledged_at: Date | null;
  acknowledged_by_member_id: string | null;
  class_id: string;
  expected_time: string | null;
  id: string;
  member_id: string;
  notification_date: string;
  notification_type: AttendanceMutationType;
  row_version: string;
  status: AttendanceMutationStatus;
  submitted_at: Date;
  updated_at: Date;
}

export interface LockedAttendanceCreateContext {
  actor: LockedAttendanceActor;
  clock: AttendanceDatabaseClock;
  existing: LockedAttendanceRow | undefined;
}

export interface LockedAttendanceResourceContext {
  actor: LockedAttendanceActor;
  clock: AttendanceDatabaseClock;
  notification: LockedAttendanceRow;
}

interface RawCurrentContext {
  class_id: string;
  class_status: string;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

function isPositiveId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

function sortIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

@Injectable()
export class AttendanceNotificationsAccessService {
  private readonly engine: AttendanceDatabaseEngine;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = attendanceDatabaseEngine(config);
    if (this.engine === "mariadb") this.database = database.withPlugin(attendanceMariaDbRowCodec);
  }

  async getCollectionContext(actorUserId: string): Promise<AttendancePreliminaryContext> {
    const current = await this.getRawCurrentContext(actorUserId);
    if (current === undefined || current.class_status === "archived") {
      throw new AttendanceNotFoundException();
    }
    return this.assertActiveContext(current);
  }

  async getResourceContext(
    actorUserId: string,
    notificationId: string,
  ): Promise<AttendancePreliminaryResource> {
    if (!isPositiveId(notificationId)) throw new AttendanceNotFoundException();
    const [current, notification] = await Promise.all([
      this.getRawCurrentContext(actorUserId),
      this.database
        .selectFrom("attendance_notifications")
        .select(["class_id", "id", "member_id"])
        .where("id", "=", notificationId)
        .executeTakeFirst(),
    ]);
    if (
      current === undefined ||
      current.class_status === "archived" ||
      notification === undefined ||
      notification.class_id !== current.class_id ||
      (current.role === "student" && notification.member_id !== current.member_id)
    ) {
      throw new AttendanceNotFoundException();
    }
    return {
      context: this.assertActiveContext(current),
      notificationId: notification.id,
      targetMemberId: notification.member_id,
    };
  }

  async lockCreateContext(
    transaction: Transaction<DB>,
    preliminary: AttendancePreliminaryContext,
    actorUserId: string,
    expectedServerToday: string,
  ): Promise<LockedAttendanceCreateContext> {
    transaction = attendanceTransaction(transaction, this.engine);
    const actor = await this.lockActorAndMembers(transaction, preliminary, actorUserId, [
      preliminary.memberId,
    ]);
    const existing = await this.lockNotificationForDate(
      transaction,
      actor.classId,
      actor.memberId,
      expectedServerToday,
    );
    const clock = await assertFreshAttendanceDate(transaction, expectedServerToday, this.engine);
    return { actor, clock, existing };
  }

  async lockResourceContext(
    transaction: Transaction<DB>,
    preliminary: AttendancePreliminaryResource,
    actorUserId: string,
    expectedServerToday: string,
  ): Promise<LockedAttendanceResourceContext> {
    transaction = attendanceTransaction(transaction, this.engine);
    const actor = await this.lockActorAndMembers(
      transaction,
      preliminary.context,
      actorUserId,
      [preliminary.context.memberId, preliminary.targetMemberId],
      preliminary.targetMemberId,
    );
    const notification = await this.lockNotification(
      transaction,
      actor.classId,
      preliminary.notificationId,
      preliminary.targetMemberId,
    );
    const clock = await assertFreshAttendanceDate(transaction, expectedServerToday, this.engine);
    if (notification.notification_date !== expectedServerToday) {
      throw new AttendanceNotificationDateChangedException();
    }
    return { actor, clock, notification };
  }

  private async getRawCurrentContext(actorUserId: string): Promise<RawCurrentContext | undefined> {
    return this.database
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
      .where("member.status", "=", "approved")
      .executeTakeFirst();
  }

  private assertActiveContext(current: RawCurrentContext): AttendancePreliminaryContext {
    if (current.class_status === "suspended") throw new AttendanceClassSuspendedException();
    if (current.class_status !== "active") throw new AttendanceNotFoundException();
    if (current.role !== "student" && current.role !== "teacher") {
      throw new AttendanceRoleInsufficientException();
    }
    if (
      current.role === "teacher" &&
      (current.profile_status !== "active" || current.temporary_password_must_change !== false)
    ) {
      throw new AttendanceRoleInsufficientException(
        "이 반의 선생님만 출결 연락을 관리할 수 있어요.",
      );
    }
    return { classId: current.class_id, memberId: current.member_id, role: current.role };
  }

  private async lockActorAndMembers(
    transaction: Transaction<DB>,
    preliminary: AttendancePreliminaryContext,
    actorUserId: string,
    memberIds: readonly string[],
    targetMemberId?: string,
  ): Promise<LockedAttendanceActor> {
    const account = await transaction
      .selectFrom("users")
      .select([
        "deleted_at",
        "display_name",
        "email_verified_at",
        "is_active",
        "signup_approved_at",
        "signup_role",
      ])
      .where("id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }
    if (!hasApprovedAccountAccess(account)) throw new EmailNotVerifiedException();

    const targetClass = await transaction
      .selectFrom("classes")
      .select(["id", "status"])
      .where("id", "=", preliminary.classId)
      .forUpdate()
      .executeTakeFirst();
    if (targetClass === undefined || targetClass.status === "archived") {
      throw new AttendanceNotFoundException();
    }
    if (targetClass.status === "suspended") throw new AttendanceClassSuspendedException();
    if (targetClass.status !== "active") throw new AttendanceNotFoundException();

    const lockedMembers = await transaction
      .selectFrom("class_members as member")
      .select(["member.class_id", "member.id", "member.role", "member.status", "member.user_id"])
      .where("member.id", "in", sortIds(memberIds))
      .orderBy("member.id", "asc")
      .forUpdate()
      .execute();
    const actorMember = lockedMembers.find((member) => member.id === preliminary.memberId);
    if (
      actorMember === undefined ||
      actorMember.class_id !== targetClass.id ||
      actorMember.user_id !== actorUserId ||
      actorMember.status !== "approved" ||
      actorMember.role !== preliminary.role
    ) {
      throw new AttendanceNotFoundException();
    }
    if (targetMemberId !== undefined) {
      const targetMember = lockedMembers.find((member) => member.id === targetMemberId);
      if (
        targetMember === undefined ||
        targetMember.class_id !== targetClass.id ||
        targetMember.role !== "student"
      ) {
        throw new AttendanceNotFoundException();
      }
    }

    if (preliminary.role === "teacher") {
      const profile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", actorUserId)
        .forUpdate()
        .executeTakeFirst();
      if (
        profile === undefined ||
        profile.status !== "active" ||
        profile.temporary_password_must_change
      ) {
        throw new AttendanceRoleInsufficientException(
          "이 반의 선생님만 출결 연락을 관리할 수 있어요.",
        );
      }
    }

    return {
      classId: targetClass.id,
      displayName: account.display_name,
      memberId: actorMember.id,
      role: preliminary.role,
    };
  }

  private async lockNotificationForDate(
    transaction: Transaction<DB>,
    classId: string,
    memberId: string,
    notificationDate: string,
  ): Promise<LockedAttendanceRow | undefined> {
    return transaction
      .selectFrom("attendance_notifications as notification")
      .select([
        "notification.acknowledged_at",
        "notification.acknowledged_by_member_id",
        "notification.class_id",
        "notification.expected_time",
        "notification.id",
        "notification.member_id",
        (this.engine === "mariadb"
          ? sql<string>`DATE_FORMAT(notification.notification_date, '%Y-%m-%d')`
          : sql<string>`to_char(notification.notification_date, 'YYYY-MM-DD')`
        ).as("notification_date"),
        "notification.notification_type",
        "notification.row_version",
        "notification.status",
        "notification.submitted_at",
        "notification.updated_at",
      ])
      .where("notification.class_id", "=", classId)
      .where("notification.member_id", "=", memberId)
      .where("notification.notification_date", "=", attendanceDate(notificationDate, this.engine))
      .forUpdate()
      .executeTakeFirst() as Promise<LockedAttendanceRow | undefined>;
  }

  private async lockNotification(
    transaction: Transaction<DB>,
    classId: string,
    notificationId: string,
    targetMemberId: string,
  ): Promise<LockedAttendanceRow> {
    const row = await transaction
      .selectFrom("attendance_notifications as notification")
      .select([
        "notification.acknowledged_at",
        "notification.acknowledged_by_member_id",
        "notification.class_id",
        "notification.expected_time",
        "notification.id",
        "notification.member_id",
        (this.engine === "mariadb"
          ? sql<string>`DATE_FORMAT(notification.notification_date, '%Y-%m-%d')`
          : sql<string>`to_char(notification.notification_date, 'YYYY-MM-DD')`
        ).as("notification_date"),
        "notification.notification_type",
        "notification.row_version",
        "notification.status",
        "notification.submitted_at",
        "notification.updated_at",
      ])
      .where("notification.id", "=", notificationId)
      .where("notification.class_id", "=", classId)
      .where("notification.member_id", "=", targetMemberId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new AttendanceNotFoundException();
    return row as LockedAttendanceRow;
  }
}
