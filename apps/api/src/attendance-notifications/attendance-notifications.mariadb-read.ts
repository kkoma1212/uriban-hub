import { sql } from "kysely";
import type { ClassHubDatabase } from "../database/database.module.js";
import {
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
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
  emptyAttendanceCounts,
} from "./attendance-notifications.read.js";
import type {
  AttendanceHistoryItem,
  AttendanceNotificationStatus,
  AttendanceNotificationType,
  AttendanceStudentHistoryResult,
  AttendanceTeacherItem,
  AttendanceTodayResult,
  GetAttendanceHistoryQuery,
  GetAttendanceTodayQuery,
} from "./attendance-notifications.types.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Invalid attendance snapshot value.");
  return value;
};
const nullableDate = mariaDbNullable(mariaDbDateTime);
const contextQuery = (actorUserId: string) => sql`
  SELECT c.id AS actor_class_id,c.status AS actor_class_status,m.id AS actor_member_id,m.role AS actor_role,
    p.status AS actor_profile_status,p.temporary_password_must_change AS actor_password_change,
    DATE_FORMAT(UTC_TIMESTAMP(6)+INTERVAL 9 HOUR,'%Y-%m-%d') AS snapshot_today
  FROM class_members m JOIN classes c ON c.id=m.class_id LEFT JOIN teacher_profiles p ON p.user_id=m.user_id
  WHERE m.user_id=${actorUserId} AND m.status='approved' LIMIT 1`;

function context(row: Row | undefined) {
  if (!row || row.actor_class_status === "archived") throw new AttendanceNotFoundException();
  if (row.actor_class_status === "suspended") throw new AttendanceClassSuspendedException();
  if (row.actor_class_status !== "active") throw new AttendanceNotFoundException();
  if (row.actor_role !== "teacher" && row.actor_role !== "student")
    throw new AttendanceRoleInsufficientException();
  if (
    row.actor_role === "teacher" &&
    (row.actor_profile_status !== "active" || row.actor_password_change !== 0)
  )
    throw new AttendanceRoleInsufficientException("이 반의 선생님만 출결 현황을 볼 수 있어요.");
  return {
    classId: mariaDbId(row.actor_class_id),
    memberId: mariaDbId(row.actor_member_id),
    role: row.actor_role,
    serverToday: mariaDbDateOnly(row.snapshot_today),
  };
}

async function preliminary(database: ClassHubDatabase, actorUserId: string) {
  const result = await contextQuery(actorUserId).execute(database);
  return context(result.rows[0] as Row | undefined);
}
function recheck(first: Row | undefined, expected: ReturnType<typeof context>) {
  const current = context(first);
  if (
    current.classId !== expected.classId ||
    current.memberId !== expected.memberId ||
    current.role !== expected.role
  )
    throw new AttendanceNotFoundException();
  return current;
}

const notificationFields = sql`
  n.id AS snapshot_id,n.acknowledged_at AS snapshot_acknowledged_at,n.expected_time AS snapshot_expected_time,
  n.notification_type AS snapshot_type,n.status AS snapshot_status,n.row_version AS snapshot_version,
  n.submitted_at AS snapshot_submitted_at,n.updated_at AS snapshot_updated_at`;

function notificationItem(row: Row) {
  return attendanceNotificationItem({
    acknowledged_at: nullableDate(row.snapshot_acknowledged_at),
    expected_time: row.snapshot_expected_time === null ? null : text(row.snapshot_expected_time),
    id: mariaDbId(row.snapshot_id),
    notification_type: text(row.snapshot_type),
    row_version: mariaDbId(row.snapshot_version),
    status: text(row.snapshot_status),
    submitted_at: mariaDbDateTime(row.snapshot_submitted_at),
    updated_at: mariaDbDateTime(row.snapshot_updated_at),
  });
}

function afterCursor(cursor: AttendanceTodayCursor | undefined) {
  if (!cursor) return sql`TRUE`;
  const name = sql`(snapshot_display_name > ${cursor.displayName}
    OR (snapshot_display_name = ${cursor.displayName} AND snapshot_member_id > CAST(${cursor.memberId} AS SIGNED)))`;
  return cursor.studentNumber === null
    ? sql`snapshot_student_number IS NULL AND ${name}`
    : sql`(snapshot_student_number > ${cursor.studentNumber} OR snapshot_student_number IS NULL
      OR (snapshot_student_number = ${cursor.studentNumber} AND ${name}))`;
}

/** RC stays guarded. Final context, database day, totals and page share one statement snapshot.
 * Preliminary context preserves authorization-before-cursor/range validation. The final
 * snapshot rechecks the same actor identity so a concurrent class switch cannot cross scopes. */
export async function readMariaDbAttendanceToday(
  database: ClassHubDatabase,
  query: GetAttendanceTodayQuery,
): Promise<AttendanceTodayResult> {
  const before = await preliminary(database, query.actorUserId);
  const teacher = before.role === "teacher";
  const cursorContext = (day: string) => ({
    classId: before.classId,
    notificationDate: day,
    status: query.status,
    type: query.type,
  });
  const cursor =
    teacher && query.cursor !== undefined
      ? decodeAttendanceTodayCursor(query.cursor, cursorContext(before.serverToday))
      : undefined;
  const type = teacher && query.type !== "all" ? sql`snapshot_type=${query.type}` : sql`TRUE`;
  const status =
    teacher && query.status !== "all" ? sql`snapshot_status=${query.status}` : sql`TRUE`;
  const result =
    await sql<Row>`WITH actor_context AS (${contextQuery(query.actorUserId)}), notifications AS (
    SELECT ${notificationFields},m.id AS snapshot_member_id,m.student_number AS snapshot_student_number,
      m.status AS snapshot_member_status,COALESCE(m.display_name_in_class,a.display_name) AS snapshot_display_name,
      a.deleted_at AS snapshot_account_deleted_at,a.is_active AS snapshot_account_is_active
    FROM attendance_notifications n JOIN class_members m ON m.id=n.member_id JOIN users a ON a.id=m.user_id
    JOIN actor_context actor ON actor.actor_class_id=n.class_id
    WHERE n.notification_date=CAST(actor.snapshot_today AS DATE) AND n.status<>'canceled' AND m.role='student'
      AND (actor.actor_role='teacher' OR n.member_id=actor.actor_member_id)
  ), counts AS (
    SELECT COUNT(*) AS total,COUNT(CASE WHEN snapshot_type='absent' THEN 1 END) AS absent,
      COUNT(CASE WHEN snapshot_type='early' THEN 1 END) AS early,COUNT(CASE WHEN snapshot_type='late' THEN 1 END) AS late,
      COUNT(CASE WHEN snapshot_status='pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN snapshot_status='acknowledged' THEN 1 END) AS acknowledged FROM notifications
  ), page AS (
    SELECT * FROM notifications WHERE ${type} AND ${status} AND ${afterCursor(cursor)}
    ORDER BY snapshot_student_number IS NULL,snapshot_student_number,snapshot_display_name,snapshot_member_id LIMIT 21
  ) SELECT actor.*,counts.*,page.* FROM actor_context actor CROSS JOIN counts LEFT JOIN page ON TRUE
    ORDER BY page.snapshot_student_number IS NULL,page.snapshot_student_number,page.snapshot_display_name,page.snapshot_member_id`.execute(
      database,
    );
  const current = recheck(result.rows[0], before);
  if (teacher && query.cursor !== undefined)
    decodeAttendanceTodayCursor(query.cursor, cursorContext(current.serverToday));
  const rows = result.rows.filter((row) => row.snapshot_id !== null);
  if (!teacher)
    return {
      role: "student",
      server_today: current.serverToday,
      notification: rows[0] ? notificationItem(rows[0]) : null,
    };
  const first = result.rows[0]!;
  const counts = emptyAttendanceCounts();
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    counts[key] = mariaDbCount(first[key]);
  const page = rows.slice(0, 20);
  const items = page.map((row): AttendanceTeacherItem => {
    const deleted = nullableDate(row.snapshot_account_deleted_at) !== null;
    const memberStatus = row.snapshot_member_status;
    return {
      ...notificationItem(row),
      account_state: deleted
        ? "deleted"
        : mariaDbBoolean(row.snapshot_account_is_active)
          ? "active"
          : "inactive",
      display_name: text(row.snapshot_display_name),
      member_id: mariaDbId(row.snapshot_member_id),
      membership_state:
        deleted || memberStatus === "account_deleted"
          ? "account_deleted"
          : memberStatus === "approved" || memberStatus === "left"
            ? memberStatus
            : "removed",
      student_number: mariaDbNullable(mariaDbCount)(row.snapshot_student_number),
    };
  });
  const last = items.at(-1);
  return {
    counts,
    items,
    role: "teacher",
    server_today: current.serverToday,
    next_cursor:
      rows.length > 20 && last
        ? encodeAttendanceTodayCursor({
            ...cursorContext(current.serverToday),
            displayName: last.display_name,
            memberId: last.member_id,
            studentNumber: last.student_number,
          })
        : null,
  };
}

export async function readMariaDbAttendanceHistory(
  database: ClassHubDatabase,
  query: GetAttendanceHistoryQuery,
): Promise<AttendanceStudentHistoryResult> {
  const before = await preliminary(database, query.actorUserId);
  if (before.role !== "student")
    throw new AttendanceRoleInsufficientException(
      "학생 본인만 자신의 출결 연락 이력을 볼 수 있습니다.",
    );
  assertAttendanceHistoryRange(query.from, query.to, before.serverToday);
  const result =
    await sql<Row>`WITH actor_context AS (${contextQuery(query.actorUserId)}), history AS (
    SELECT n.id AS snapshot_id,n.expected_time AS snapshot_expected_time,
      DATE_FORMAT(n.notification_date,'%Y-%m-%d') AS snapshot_date,n.notification_type AS snapshot_type,n.status AS snapshot_status
    FROM attendance_notifications n JOIN actor_context actor ON actor.actor_class_id=n.class_id AND actor.actor_member_id=n.member_id
    WHERE n.notification_date>=CAST(${query.from} AS DATE) AND n.notification_date<=CAST(${query.to} AS DATE) AND n.status<>'canceled'
  ) SELECT actor.*,history.* FROM actor_context actor LEFT JOIN history ON TRUE ORDER BY history.snapshot_date,history.snapshot_id`.execute(
      database,
    );
  const current = recheck(result.rows[0], before);
  assertAttendanceHistoryRange(query.from, query.to, current.serverToday);
  const counts = { absent: 0, early: 0, late: 0, total: 0 };
  const items = result.rows
    .filter((row) => row.snapshot_id !== null)
    .map((row): AttendanceHistoryItem => {
      const type = text(row.snapshot_type) as AttendanceNotificationType;
      counts[type] += 1;
      counts.total += 1;
      return {
        expected_time:
          row.snapshot_expected_time === null ? null : text(row.snapshot_expected_time).slice(0, 5),
        notification_date: mariaDbDateOnly(row.snapshot_date),
        notification_type: type,
        status: text(row.snapshot_status) as AttendanceNotificationStatus,
      };
    });
  return {
    counts,
    items,
    range: { from: query.from, to: query.to },
    role: "student",
    server_today: current.serverToday,
  };
}
