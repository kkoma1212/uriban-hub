import type { DB } from "@classhub/db";
import { sql, type RawBuilder, type Transaction } from "kysely";
import { mariaDbDateOnly, mariaDbTimestamp } from "../common/database/mariadb-values.js";
import type { AttendanceDatabaseEngine } from "./attendance-notifications.database.js";

import { AttendanceNotificationDateChangedException } from "./attendance-notifications-command.errors.js";

export interface AttendanceDatabaseClock {
  databaseNow: Date | RawBuilder<Date>;
  serverToday: string;
}

export async function readAttendanceDatabaseClock(
  transaction: Transaction<DB>,
  engine: AttendanceDatabaseEngine = "postgres",
): Promise<AttendanceDatabaseClock> {
  if (engine === "mariadb") {
    const result = await sql<{ attendance_clock: string; server_today: string }>`
      SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS attendance_clock,
        DATE_FORMAT(UTC_TIMESTAMP(6)+INTERVAL 9 HOUR,'%Y-%m-%d') AS server_today
    `.execute(transaction);
    const row = result.rows[0];
    if (!row) throw new Error("Invalid attendance database clock.");
    return {
      databaseNow: sql<Date>`${mariaDbTimestamp(row.attendance_clock)}`,
      serverToday: mariaDbDateOnly(row.server_today),
    };
  }
  const result = await sql<{ database_now: Date; server_today: string }>`
    SELECT
      clock_value AS database_now,
      to_char(
        (clock_value AT TIME ZONE 'Asia/Seoul')::date,
        'YYYY-MM-DD'
      ) AS server_today
    FROM (SELECT clock_timestamp() AS clock_value) AS attendance_clock
  `.execute(transaction);
  const row = result.rows[0];
  if (row === undefined) throw new Error("DB 출결 시계를 읽지 못했습니다.");
  return { databaseNow: row.database_now, serverToday: row.server_today };
}

export async function assertFreshAttendanceDate(
  transaction: Transaction<DB>,
  expectedServerToday: string,
  engine: AttendanceDatabaseEngine = "postgres",
): Promise<AttendanceDatabaseClock> {
  const clock = await readAttendanceDatabaseClock(transaction, engine);
  if (clock.serverToday !== expectedServerToday) {
    throw new AttendanceNotificationDateChangedException();
  }
  return clock;
}
