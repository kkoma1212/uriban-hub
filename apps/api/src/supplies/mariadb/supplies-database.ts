import type { DB } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import { sql, type Transaction } from "kysely";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../../common/database/mariadb-values.js";
import type { AppEnvironment } from "../../config/environment.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import type { SupplyDatabaseEngine } from "./supplies-sql.js";

const codec = () =>
  createMariaDbRowCodec({
    id: mariaDbId,
    class_id: mariaDbId,
    member_id: mariaDbId,
    user_id: mariaDbId,
    content_revision: mariaDbId,
    row_version: mariaDbId,
    confirmed_revision: mariaDbNullable(mariaDbId),
    page_member_id: mariaDbNullable(mariaDbId),
    needed_on: mariaDbDateOnly,
    requested_at: mariaDbNullable(mariaDbDateTime),
    deleted_at: mariaDbNullable(mariaDbDateTime),
    is_active: mariaDbBoolean,
    is_checked: mariaDbNullable(mariaDbBoolean),
    temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
  });

export function supplyDatabase(
  database: ClassHubDatabase,
  config?: ConfigService<AppEnvironment, true>,
) {
  const engine: SupplyDatabaseEngine =
    config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") throw new Error("Unsupported database engine");
  return { database: engine === "mariadb" ? database.withPlugin(codec()) : database, engine };
}

/** Shared reminder callbacks can supply a transaction with another service's result codec. */
export const supplyTransaction = (transaction: Transaction<DB>, engine: SupplyDatabaseEngine) =>
  engine === "mariadb" ? transaction.withPlugin(codec()) : transaction;

export const supplyJson = <T>(value: T, engine: SupplyDatabaseEngine) =>
  engine === "mariadb" && value !== null ? sql<T>`${JSON.stringify(value)}` : value;
