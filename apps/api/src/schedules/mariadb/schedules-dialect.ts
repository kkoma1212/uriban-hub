import type { DB } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import { sql, type Kysely, type Transaction } from "kysely";
import type { AppEnvironment } from "../../config/environment.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../../common/database/mariadb-values.js";

type Engine = "postgres" | "mariadb";
const codec = () =>
  createMariaDbRowCodec({
    id: mariaDbId,
    class_id: mariaDbId,
    member_id: mariaDbId,
    user_id: mariaDbId,
    row_version: mariaDbId,
    is_active: mariaDbBoolean,
    temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
    academic_year: mariaDbCount,
    grade: mariaDbCount,
    grade_mask: mariaDbCount,
    due_date: mariaDbDateOnly,
    event_date: mariaDbDateOnly,
    source_loaded_on: mariaDbDateOnly,
    date: mariaDbDateOnly,
    server_today: mariaDbDateOnly,
    deleted_at: mariaDbNullable(mariaDbDateTime),
  });

export function schedulesDatabase(
  database: Kysely<DB>,
  environment?: ConfigService<AppEnvironment, true>,
) {
  const engine = environment?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") throw new Error("Unsupported database engine");
  return { engine, database: engine === "mariadb" ? database.withPlugin(codec()) : database };
}

/** Access helpers also accept a transaction owned by another caller. Decoders are idempotent. */
export function schedulesTransaction(
  transaction: Transaction<DB>,
  engine: Engine,
): Transaction<DB> {
  return engine === "mariadb" ? transaction.withPlugin(codec()) : transaction;
}

export function scheduleDateSql(value: string, engine: Engine) {
  return engine === "mariadb"
    ? sql<Date>`CAST(${mariaDbDateOnly(value)} AS DATE)`
    : sql<Date>`${value}::date`;
}

export function scheduleIdSql(value: string, engine: Engine) {
  return engine === "mariadb"
    ? sql<string>`CAST(${mariaDbId(value)} AS SIGNED)`
    : sql<string>`${value}::bigint`;
}

export function scheduleJson<T>(value: T, engine: Engine) {
  return engine === "mariadb" ? sql<T>`${JSON.stringify(value)}` : value;
}

export function schedulesPersistenceFailure(): Error {
  return new Error("MariaDB schedule write could not be verified.");
}
