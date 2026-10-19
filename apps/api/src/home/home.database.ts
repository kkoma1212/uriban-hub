import type { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";
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

export type HomeDatabaseEngine = "postgres" | "mariadb";
export function homeDatabaseEngine(
  config?: ConfigService<AppEnvironment, true>,
): HomeDatabaseEngine {
  const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb")
    throw new Error("Invalid home database engine.");
  return engine;
}
export function homeDate(value: string, engine: HomeDatabaseEngine) {
  return engine === "mariadb" ? sql<Date>`${mariaDbDateOnly(value)}` : sql<Date>`${value}::date`;
}
export function homeBigint(value: string, engine: HomeDatabaseEngine) {
  return engine === "mariadb" ? sql`${mariaDbId(value)}` : sql`${value}::bigint`;
}
export function homeCurrentTimestamp(engine: HomeDatabaseEngine) {
  return engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`CURRENT_TIMESTAMP`;
}
/**
 * 홈(우리반 소식·칠판)에 공지를 올려 두는 기간의 시작 — 올린 뒤 7일(2026-10-01 사용자 결정).
 * 지난 공지는 소식 탭에만 남는다. 공지 목록과 공지 재알림이 같은 기준을 쓴다.
 */
export function homeNoticeVisibleSince(engine: HomeDatabaseEngine) {
  return engine === "mariadb"
    ? sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`
    : sql<Date>`CURRENT_TIMESTAMP - INTERVAL '7 days'`;
}
export function homeFilteredCount(predicate: RawBuilder<boolean>, engine: HomeDatabaseEngine) {
  return engine === "mariadb"
    ? sql<string>`COUNT(CASE WHEN ${predicate} THEN 1 END)`
    : sql<string>`COUNT(*) FILTER (WHERE ${predicate})`;
}

// Selected "id" fields here are BIGINT. Reminder batch UUIDs stay inside SQL and
// are deliberately never routed through an identity decoder or numeric ordering.
export const homeMariaDbRowCodec = createMariaDbRowCodec({
  id: mariaDbId,
  class_id: mariaDbId,
  member_id: mariaDbId,
  resource_id: mariaDbId,
  content_revision: mariaDbId,
  confirmed_revision: mariaDbNullable(mariaDbId),
  is_active: mariaDbBoolean,
  temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
  has_voted: mariaDbBoolean,
  is_important: mariaDbBoolean,
  is_checked: mariaDbNullable(mariaDbBoolean),
  deleted_at: mariaDbNullable(mariaDbDateTime),
  published_at: mariaDbDateTime,
  created_at: mariaDbDateTime,
  source_updated_at: mariaDbDateTime,
  closes_at: mariaDbDateTime,
  requested_at: mariaDbDateTime,
  last_reminder_requested_at: mariaDbNullable(mariaDbDateTime),
  meal_date: mariaDbDateOnly,
  needed_on: mariaDbDateOnly,
  due_date: mariaDbDateOnly,
  source_loaded_on: mariaDbNullable(mariaDbDateOnly),
  server_today: mariaDbDateOnly,
  count: mariaDbCount,
  confirmed: mariaDbCount,
  unread: mariaDbCount,
  checked: mariaDbCount,
  unchecked: mariaDbCount,
  modified_unconfirmed: mariaDbCount,
  excluded_member_count: mariaDbCount,
  calorie_kcal_tenths: mariaDbNullable(mariaDbCount),
  menu_json: (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error("Invalid home meal JSON.");
    }
  },
});
