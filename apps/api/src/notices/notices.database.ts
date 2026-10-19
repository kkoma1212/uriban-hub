import type { ConfigService } from "@nestjs/config";
import type { JsonValue } from "@classhub/db";
import { sql } from "kysely";
import type { AppEnvironment } from "../config/environment.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
  mariaDbTimestamp,
} from "../common/database/mariadb-values.js";

export function noticeDatabaseEngine(
  config?: ConfigService<AppEnvironment, true>,
): "postgres" | "mariadb" {
  const value = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (value !== "postgres" && value !== "mariadb")
    throw new Error("Invalid notices database engine.");
  return value;
}

// Never map idempotency response_body_json/unexpired: the shared reservation service owns those.
export const noticeMariaDbRowCodec = createMariaDbRowCodec({
  id: mariaDbId,
  class_id: mariaDbId,
  member_id: mariaDbNullable(mariaDbId),
  user_id: mariaDbId,
  content_revision: mariaDbId,
  row_version: mariaDbId,
  confirmed_revision: mariaDbNullable(mariaDbId),
  is_important: mariaDbBoolean,
  is_active: mariaDbBoolean,
  temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
  published_at: mariaDbDateTime,
  deleted_at: mariaDbNullable(mariaDbDateTime),
  requested_at: mariaDbNullable(mariaDbDateTime),
  server_today: mariaDbDateOnly,
  notice_clock: mariaDbTimestamp,
  student_number: mariaDbNullable(mariaDbCount),
  confirmed: mariaDbCount,
  modified_unconfirmed: mariaDbCount,
  reconfirmed: mariaDbCount,
  unread: mariaDbCount,
  excluded_member_count: mariaDbCount,
});

export const noticeProjection = [
  "audience_mode",
  "category",
  "content",
  "content_revision",
  "id",
  "is_important",
  "published_at",
  "row_version",
  "title",
] as const;

export function noticeJson(value: JsonValue, engine: "postgres" | "mariadb") {
  return engine === "mariadb" ? sql<JsonValue>`${JSON.stringify(value)}` : value;
}
