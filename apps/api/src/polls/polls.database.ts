import { types } from "node:util";
import type { JsonValue } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import type { AppEnvironment } from "../config/environment.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";

export type PollDatabaseEngine = "postgres" | "mariadb";

export function pollDatabaseEngine(
  config?: ConfigService<AppEnvironment, true>,
): PollDatabaseEngine {
  const value = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (value !== "postgres" && value !== "mariadb")
    throw new Error("Invalid polls database engine.");
  return value;
}

// Idempotency response JSON, native response_status and unexpired stay with its service.
export const pollMariaDbRowCodec = createMariaDbRowCodec({
  id: mariaDbId,
  class_id: mariaDbId,
  member_id: mariaDbId,
  user_id: mariaDbId,
  poll_id: mariaDbId,
  option_id: mariaDbId,
  row_version: mariaDbId,
  vote_id: mariaDbNullable(mariaDbId),
  selected_option_id: mariaDbNullable(mariaDbId),
  is_active: mariaDbBoolean,
  temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
  closed_at: mariaDbNullable(mariaDbDateTime),
  closes_at: mariaDbDateTime,
  created_at: mariaDbDateTime,
  deleted_at: mariaDbNullable(mariaDbDateTime),
  now: mariaDbDateTime,
  option_count: mariaDbCount,
  position: mariaDbCount,
  vote_count: mariaDbCount,
  student_number: mariaDbNullable(mariaDbCount),
});

export const pollProjection = [
  "ballot_visibility",
  "class_id",
  "closed_at",
  "closes_at",
  "created_at",
  "description",
  "id",
  "option_count",
  "results_policy",
  "row_version",
  "title",
] as const;

/** PG callers already persist Date milliseconds; encode the same UTC value explicitly. */
export function pollDate(value: Date, engine: PollDatabaseEngine) {
  return engine === "mariadb" ? mariaDbDateBinding(value) : value;
}

/** Cursor is a canonical ISO6 string; never send it through a JS Date. */
export function pollCursorTime(value: string, engine: PollDatabaseEngine) {
  return engine === "mariadb"
    ? sql<Date>`CAST(${value.replace("T", " ").slice(0, -1)} AS DATETIME(6))`
    : sql<Date>`${value}::timestamptz`;
}

export function pollId(value: string, engine: PollDatabaseEngine) {
  return engine === "mariadb"
    ? sql<string>`CAST(${mariaDbId(value)} AS SIGNED)`
    : sql<string>`${value}::bigint`;
}

export function pollJson<T extends JsonValue>(value: T, engine: PollDatabaseEngine) {
  return engine === "mariadb" ? sql<T>`${JSON.stringify(value)}` : value;
}

/** Only the caller's isolated options/vote INSERT may interpret this native duplicate. */
export function isMariaDbPollDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return false;
  return (
    Object.getOwnPropertyDescriptor(error, "errno")?.value === 1062 &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "23000"
  );
}
