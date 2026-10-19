import type { DB } from "@classhub/db";
import { sql, type Kysely, type RawBuilder } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";

import type {
  AttendanceCounts,
  AttendanceNotificationItem,
  AttendanceNotificationStatus,
  AttendanceNotificationType,
} from "./attendance-notifications.types.js";

export interface AttendanceNotificationReadRow {
  acknowledged_at: Date | null;
  expected_time: string | null;
  id: string;
  notification_type: string;
  row_version: string;
  status: string;
  submitted_at: Date;
  updated_at: Date;
}

export function attendanceNotificationItem(
  row: AttendanceNotificationReadRow,
): AttendanceNotificationItem {
  return {
    acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
    expected_time: row.expected_time === null ? null : row.expected_time.slice(0, 5),
    id: row.id,
    notification_type: row.notification_type as AttendanceNotificationType,
    row_version: row.row_version,
    status: row.status as AttendanceNotificationStatus,
    submitted_at: row.submitted_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function emptyAttendanceCounts(): AttendanceCounts {
  return { absent: 0, acknowledged: 0, early: 0, late: 0, pending: 0, total: 0 };
}

export async function readStudentAttendanceToday(
  database: Kysely<DB>,
  input: { classId: string; memberId: string; serverToday: string },
  dialect: "postgres" | "mariadb" = "postgres",
): Promise<AttendanceNotificationItem | null> {
  if (dialect === "mariadb")
    database = database.withPlugin(
      createMariaDbRowCodec({
        id: mariaDbId,
        row_version: mariaDbId,
        acknowledged_at: mariaDbNullable(mariaDbDateTime),
        submitted_at: mariaDbDateTime,
        updated_at: mariaDbDateTime,
      }),
    );
  const row = await database
    .selectFrom("attendance_notifications as notification")
    .select([
      "notification.acknowledged_at",
      "notification.expected_time",
      "notification.id",
      "notification.notification_type",
      "notification.row_version",
      "notification.status",
      "notification.submitted_at",
      "notification.updated_at",
    ])
    .where("notification.class_id", "=", input.classId)
    .where("notification.member_id", "=", input.memberId)
    .where("notification.notification_date", "=", dateParameter(input.serverToday, dialect))
    .where("notification.status", "!=", "canceled")
    .executeTakeFirst();

  return row === undefined ? null : attendanceNotificationItem(row);
}

export async function readAttendanceTodayCounts(
  database: Kysely<DB>,
  input: { classId: string; serverToday: string },
  dialect: "postgres" | "mariadb" = "postgres",
): Promise<AttendanceCounts> {
  const count = (condition: RawBuilder<boolean>) =>
    dialect === "mariadb"
      ? sql<string>`COUNT(CASE WHEN ${condition} THEN 1 END)`
      : sql<string>`COUNT(*) FILTER (WHERE ${condition})`;
  const row = await database
    .selectFrom("attendance_notifications as notification")
    .innerJoin("class_members as member", "member.id", "notification.member_id")
    .select([
      sql<string>`COUNT(*)`.as("total"),
      count(sql<boolean>`notification.notification_type = 'late'`).as("late"),
      count(sql<boolean>`notification.notification_type = 'absent'`).as("absent"),
      count(sql<boolean>`notification.notification_type = 'early'`).as("early"),
      count(sql<boolean>`notification.status = 'pending'`).as("pending"),
      count(sql<boolean>`notification.status = 'acknowledged'`).as("acknowledged"),
    ])
    .where("notification.class_id", "=", input.classId)
    .where("notification.notification_date", "=", dateParameter(input.serverToday, dialect))
    .where("notification.status", "!=", "canceled")
    .where("member.role", "=", "student")
    .executeTakeFirstOrThrow();

  const resultCount = dialect === "mariadb" ? mariaDbCount : Number;
  return {
    absent: resultCount(row.absent),
    acknowledged: resultCount(row.acknowledged),
    early: resultCount(row.early),
    late: resultCount(row.late),
    pending: resultCount(row.pending),
    total: resultCount(row.total),
  };
}

function dateParameter(value: string, dialect: "postgres" | "mariadb") {
  return dialect === "mariadb"
    ? sql<Date>`CAST(${mariaDbDateOnly(value)} AS DATE)`
    : sql<Date>`${value}::date`;
}
