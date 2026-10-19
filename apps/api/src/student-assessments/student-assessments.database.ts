import type { ConfigService } from "@nestjs/config";
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
} from "../common/database/mariadb-values.js";

export function assessmentDatabaseEngine(config?: ConfigService<AppEnvironment, true>) {
  const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") throw new Error("Unsupported database engine");
  return engine;
}

export const assessmentMariaDbRowCodec = createMariaDbRowCodec({
  id: mariaDbId,
  row_version: mariaDbId,
  academic_year: mariaDbNullable(mariaDbCount),
  semester: mariaDbNullable(mariaDbCount),
  score_hundredths: mariaDbNullable(mariaDbCount),
  max_score_hundredths: mariaDbNullable(mariaDbCount),
  weight_basis_points: mariaDbNullable(mariaDbCount),
  assessment_date: mariaDbNullable(mariaDbDateOnly),
  created_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
  expires_at: mariaDbDateTime,
  recorded_at: mariaDbNullable(mariaDbDateTime),
  is_active: mariaDbBoolean,
  deleted_at: mariaDbNullable(mariaDbDateTime),
  email_verified_at: mariaDbNullable(mariaDbDateTime),
  signup_approved_at: mariaDbNullable(mariaDbDateTime),
});

export function assessmentNow(engine: "postgres" | "mariadb") {
  return engine === "mariadb" ? sql<Date>`UTC_TIMESTAMP(6)` : sql<Date>`clock_timestamp()`;
}
