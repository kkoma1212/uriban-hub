import type { ConfigService } from "@nestjs/config";
import type { DB, JsonValue } from "@classhub/db";
import { sql, type Transaction } from "kysely";
import type { AppEnvironment } from "../config/environment.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";

export type AttendanceDatabaseEngine = "postgres" | "mariadb";
export function attendanceDatabaseEngine(
  config?: ConfigService<AppEnvironment, true>,
): AttendanceDatabaseEngine {
  const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb")
    throw new Error("Invalid attendance database engine.");
  return engine;
}
export const attendanceMariaDbRowCodec = createMariaDbRowCodec({
  id: mariaDbId,
  class_id: mariaDbId,
  member_id: mariaDbId,
  user_id: mariaDbId,
  row_version: mariaDbId,
  acknowledged_by_member_id: mariaDbNullable(mariaDbId),
  is_active: mariaDbBoolean,
  temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
  deleted_at: mariaDbNullable(mariaDbDateTime),
  email_verified_at: mariaDbNullable(mariaDbDateTime),
  signup_approved_at: mariaDbNullable(mariaDbDateTime),
  notification_date: mariaDbDateOnly,
  server_today: mariaDbDateOnly,
  acknowledged_at: mariaDbNullable(mariaDbDateTime),
  submitted_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
  student_number: mariaDbNullable(mariaDbCount),
});
export function attendanceTransaction(
  transaction: Transaction<DB>,
  engine: AttendanceDatabaseEngine,
) {
  return engine === "mariadb" ? transaction.withPlugin(attendanceMariaDbRowCodec) : transaction;
}
export function attendanceDate(value: string, engine: AttendanceDatabaseEngine) {
  return engine === "mariadb"
    ? sql<Date>`CAST(${mariaDbDateOnly(value)} AS DATE)`
    : sql<Date>`${value}::date`;
}
export function attendanceJson<T extends JsonValue>(value: T, engine: AttendanceDatabaseEngine) {
  return engine === "mariadb" && value !== null ? sql<T>`${JSON.stringify(value)}` : value;
}
