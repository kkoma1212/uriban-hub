import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type RawBuilder, type Transaction } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { databaseDate } from "../common/date/kst-date.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  attendanceDatabaseEngine,
  type AttendanceDatabaseEngine,
} from "./attendance-notifications.database.js";
import {
  readMariaDbAttendanceHistory,
  readMariaDbAttendanceToday,
} from "./attendance-notifications.mariadb-read.js";
import {
  decodeAttendanceTodayCursor,
  encodeAttendanceTodayCursor,
  type AttendanceTodayCursor,
} from "./attendance-notifications.cursor.js";
import {
  AttendanceClassSuspendedException,
  AttendanceNotFoundException,
  AttendanceRoleInsufficientException,
} from "./attendance-notifications.errors.js";
import { assertAttendanceHistoryRange } from "./attendance-notifications.history-range.js";
import {
  attendanceNotificationItem,
  type AttendanceNotificationReadRow,
  readAttendanceTodayCounts,
  readStudentAttendanceToday,
} from "./attendance-notifications.read.js";
import type {
  AttendanceAccountState,
  AttendanceHistoryCounts,
  AttendanceHistoryItem,
  AttendanceMembershipState,
  AttendanceNotificationStatus,
  AttendanceNotificationType,
  AttendanceStudentHistoryResult,
  AttendanceTeacherItem,
  AttendanceTeacherTodayResult,
  AttendanceTodayResult,
  GetAttendanceHistoryQuery,
  GetAttendanceTodayQuery,
} from "./attendance-notifications.types.js";

const PAGE_SIZE = 20;

interface AttendanceContext {
  classId: string;
  memberId: string;
  role: "student" | "teacher";
}

interface RawAttendanceContext {
  class_id: string;
  class_status: string;
  member_id: string;
  profile_status: string | null;
  role: string;
  temporary_password_must_change: boolean | null;
}

interface TeacherNotificationRow extends AttendanceNotificationReadRow {
  account_deleted_at: Date | null;
  account_is_active: boolean;
  display_name: string;
  member_id: string;
  member_status: string;
  student_number: number | null;
}

function accountState(row: TeacherNotificationRow): AttendanceAccountState {
  if (row.account_deleted_at !== null) return "deleted";
  return row.account_is_active ? "active" : "inactive";
}

function membershipState(row: TeacherNotificationRow): AttendanceMembershipState {
  if (row.account_deleted_at !== null || row.member_status === "account_deleted") {
    return "account_deleted";
  }
  if (row.member_status === "approved" || row.member_status === "left") {
    return row.member_status;
  }
  return "removed";
}

function teacherItem(row: TeacherNotificationRow): AttendanceTeacherItem {
  return {
    ...attendanceNotificationItem(row),
    account_state: accountState(row),
    display_name: row.display_name,
    member_id: row.member_id,
    membership_state: membershipState(row),
    student_number: row.student_number,
  };
}

function cursorPredicate(
  cursor: AttendanceTodayCursor,
  displayName: RawBuilder<string>,
): RawBuilder<boolean> {
  if (cursor.studentNumber === null) {
    return sql<boolean>`(
      member.student_number IS NULL
      AND (
        ${displayName} > ${cursor.displayName}
        OR (${displayName} = ${cursor.displayName} AND member.id > ${cursor.memberId}::bigint)
      )
    )`;
  }
  return sql<boolean>`(
    member.student_number > ${cursor.studentNumber}
    OR member.student_number IS NULL
    OR (
      member.student_number = ${cursor.studentNumber}
      AND (
        ${displayName} > ${cursor.displayName}
        OR (${displayName} = ${cursor.displayName} AND member.id > ${cursor.memberId}::bigint)
      )
    )
  )`;
}

@Injectable()
export class AttendanceNotificationsService {
  private readonly engine: AttendanceDatabaseEngine;
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.engine = attendanceDatabaseEngine(config);
  }

  async history(query: GetAttendanceHistoryQuery): Promise<AttendanceStudentHistoryResult> {
    if (this.engine === "mariadb") return readMariaDbAttendanceHistory(this.database, query);
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const serverToday = await readDatabaseKstToday(transaction);
        const context = await this.getContext(transaction, query.actorUserId);
        if (context.role !== "student") {
          throw new AttendanceRoleInsufficientException(
            "학생 본인만 자신의 출결 연락 이력을 볼 수 있습니다.",
          );
        }
        assertAttendanceHistoryRange(query.from, query.to, serverToday);

        const rows = await transaction
          .selectFrom("attendance_notifications as notification")
          .select([
            "notification.expected_time",
            "notification.notification_date",
            "notification.notification_type",
            "notification.status",
          ])
          .where("notification.class_id", "=", context.classId)
          .where("notification.member_id", "=", context.memberId)
          .where("notification.notification_date", ">=", sql<Date>`${query.from}::date`)
          .where("notification.notification_date", "<=", sql<Date>`${query.to}::date`)
          .where("notification.status", "!=", "canceled")
          .orderBy("notification.notification_date", "asc")
          .orderBy("notification.id", "asc")
          .execute();

        const counts: AttendanceHistoryCounts = { absent: 0, early: 0, late: 0, total: 0 };
        const items: AttendanceHistoryItem[] = rows.map((row) => {
          const type = row.notification_type as AttendanceNotificationType;
          counts[type] += 1;
          counts.total += 1;
          return {
            expected_time: row.expected_time === null ? null : row.expected_time.slice(0, 5),
            notification_date: databaseDate(row.notification_date),
            notification_type: type,
            status: row.status as AttendanceNotificationStatus,
          };
        });

        return {
          counts,
          items,
          range: { from: query.from, to: query.to },
          role: "student",
          server_today: serverToday,
        };
      });
  }

  async today(query: GetAttendanceTodayQuery): Promise<AttendanceTodayResult> {
    if (this.engine === "mariadb") return readMariaDbAttendanceToday(this.database, query);
    return this.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (transaction) => {
        const serverToday = await readDatabaseKstToday(transaction);
        const context = await this.getContext(transaction, query.actorUserId);

        if (context.role === "student") {
          return this.studentToday(transaction, context, serverToday);
        }
        return this.teacherToday(transaction, context, serverToday, query);
      });
  }

  private async getContext(
    transaction: Transaction<DB>,
    actorUserId: string,
  ): Promise<AttendanceContext> {
    const current = await transaction
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

    if (current === undefined || current.class_status === "archived") {
      throw new AttendanceNotFoundException();
    }
    return this.assertContext(current);
  }

  private assertContext(current: RawAttendanceContext): AttendanceContext {
    if (current.class_status === "suspended") throw new AttendanceClassSuspendedException();
    if (current.class_status !== "active") throw new AttendanceNotFoundException();
    if (current.role !== "student" && current.role !== "teacher") {
      throw new AttendanceRoleInsufficientException();
    }
    if (
      current.role === "teacher" &&
      (current.profile_status !== "active" || current.temporary_password_must_change !== false)
    ) {
      throw new AttendanceRoleInsufficientException("이 반의 선생님만 출결 현황을 볼 수 있어요.");
    }
    return { classId: current.class_id, memberId: current.member_id, role: current.role };
  }

  private async studentToday(
    transaction: Transaction<DB>,
    context: AttendanceContext,
    serverToday: string,
  ): Promise<AttendanceTodayResult> {
    const notification = await readStudentAttendanceToday(transaction, {
      classId: context.classId,
      memberId: context.memberId,
      serverToday,
    });

    return {
      notification,
      role: "student",
      server_today: serverToday,
    };
  }

  private async teacherToday(
    transaction: Transaction<DB>,
    context: AttendanceContext,
    serverToday: string,
    query: GetAttendanceTodayQuery,
  ): Promise<AttendanceTeacherTodayResult> {
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeAttendanceTodayCursor(query.cursor, {
            classId: context.classId,
            notificationDate: serverToday,
            status: query.status,
            type: query.type,
          });

    const counts = await readAttendanceTodayCounts(transaction, {
      classId: context.classId,
      serverToday,
    });

    const displayName = sql<string>`COALESCE(member.display_name_in_class, account.display_name)`;
    let itemsBuilder = transaction
      .selectFrom("attendance_notifications as notification")
      .innerJoin("class_members as member", "member.id", "notification.member_id")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select([
        "notification.acknowledged_at",
        "notification.expected_time",
        "notification.id",
        "notification.notification_type",
        "notification.row_version",
        "notification.status",
        "notification.submitted_at",
        "notification.updated_at",
        "account.deleted_at as account_deleted_at",
        "account.is_active as account_is_active",
        displayName.as("display_name"),
        "member.id as member_id",
        "member.status as member_status",
        "member.student_number",
      ])
      .where("notification.class_id", "=", context.classId)
      .where("notification.notification_date", "=", sql<Date>`${serverToday}::date`)
      .where("notification.status", "!=", "canceled")
      .where("member.role", "=", "student");

    if (query.type !== "all") {
      itemsBuilder = itemsBuilder.where("notification.notification_type", "=", query.type);
    }
    if (query.status !== "all") {
      itemsBuilder = itemsBuilder.where("notification.status", "=", query.status);
    }
    if (cursor !== undefined) {
      itemsBuilder = itemsBuilder.where(cursorPredicate(cursor, displayName));
    }

    const rows = await itemsBuilder
      .orderBy(sql`member.student_number ASC NULLS LAST`)
      .orderBy(displayName, "asc")
      .orderBy("member.id", "asc")
      .limit(PAGE_SIZE + 1)
      .execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last !== undefined
        ? encodeAttendanceTodayCursor({
            classId: context.classId,
            displayName: last.display_name,
            memberId: last.member_id,
            notificationDate: serverToday,
            status: query.status,
            studentNumber: last.student_number,
            type: query.type,
          })
        : null;

    return {
      counts,
      items: pageRows.map(teacherItem),
      next_cursor: nextCursor,
      role: "teacher",
      server_today: serverToday,
    };
  }
}
