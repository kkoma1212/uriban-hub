import type { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import type { AppEnvironment } from "../../config/environment.js";
import type { ClassHubDatabase } from "../../database/database.module.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbCount,
  mariaDbDateOnly,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../../common/database/mariadb-values.js";

function menuJson(value: unknown): unknown {
  // The existing menu parser owns the shape/content contract. Only decode the wire JSON here.
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error("Invalid MariaDB meal JSON.");
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid MariaDB meal JSON.");
  }
}

export function mealsDatabase(
  database: ClassHubDatabase,
  config?: ConfigService<AppEnvironment, true>,
) {
  const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb")
    throw new Error("Unsupported meals database engine.");
  return {
    engine,
    database:
      engine === "mariadb"
        ? database.withPlugin(
            createMariaDbRowCodec({
              id: mariaDbId,
              is_active: mariaDbBoolean,
              deleted_at: mariaDbNullable(mariaDbDateTime),
              temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
              calorie_kcal_tenths: mariaDbNullable(mariaDbCount),
              meal_date: mariaDbDateOnly,
              source_loaded_on: mariaDbNullable(mariaDbDateOnly),
              source_updated_at: mariaDbDateTime,
              menu_json: menuJson,
              server_today: mariaDbDateOnly,
            }),
          )
        : database,
  };
}

export function mealDateSql(value: string, engine: "postgres" | "mariadb") {
  return engine === "mariadb"
    ? sql<Date>`CAST(${mariaDbDateOnly(value)} AS DATE)`
    : sql<Date>`${value}::date`;
}
