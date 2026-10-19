import { isAdminRole, type AdminRole, type DB } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import { sql, type InsertObject, type Kysely, type RawBuilder } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbCount,
  mariaDbDateBinding,
  mariaDbDateTime,
  mariaDbId,
  mariaDbInsertId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { AdminUnavailableException } from "./admin-auth.errors.js";

export type AdminAuthDatabaseEngine = "postgres" | "mariadb";

const binary =
  (minimum: number, maximum = minimum) =>
  (value: unknown): Buffer => {
    if (!Buffer.isBuffer(value) || value.length < minimum || value.length > maximum)
      throw new Error("Invalid MariaDB administrator binary value.");
    return value;
  };
const timestep = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error("Invalid MariaDB administrator timestep.");
  return value;
};
const codec = createMariaDbRowCodec({
  id: mariaDbId,
  admin_account_id: mariaDbId,
  failed_login_attempts: mariaDbCount,
  failed_attempts: mariaDbCount,
  last_accepted_timestep: mariaDbNullable(timestep),
  locked_until: mariaDbNullable(mariaDbDateTime),
  created_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
  activated_at: mariaDbNullable(mariaDbDateTime),
  revoked_at: mariaDbNullable(mariaDbDateTime),
  expires_at: mariaDbDateTime,
  consumed_at: mariaDbNullable(mariaDbDateTime),
  issued_at: mariaDbDateTime,
  last_seen_at: mariaDbDateTime,
  absolute_expires_at: mariaDbDateTime,
  mfa_verified_at: mariaDbDateTime,
  reauthenticated_at: mariaDbNullable(mariaDbDateTime),
  secret_ciphertext: binary(1, 256),
  secret_iv: binary(12),
  secret_auth_tag: binary(16),
  challenge_hash: binary(32),
  session_hash: binary(32),
  csrf_token_hash: binary(32),
});

export function adminAuthDatabase(
  database: Kysely<DB>,
  config: ConfigService<AppEnvironment, true>,
) {
  const engine: AdminAuthDatabaseEngine =
    config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
  if (engine !== "postgres" && engine !== "mariadb") throw new Error("Unsupported database engine");
  return { database: engine === "mariadb" ? database.withPlugin(codec) : database, engine };
}

/** Preserve the existing app clock and its millisecond precision; never replace it with DB NOW. */
export function adminAuthDate(
  value: Date,
  engine: AdminAuthDatabaseEngine,
): Date | RawBuilder<Date>;
export function adminAuthDate(
  value: Date | null,
  engine: AdminAuthDatabaseEngine,
): Date | RawBuilder<Date> | null;
export function adminAuthDate(value: Date | null, engine: AdminAuthDatabaseEngine) {
  return engine === "mariadb" && value !== null ? mariaDbDateBinding(value) : value;
}

export const adminAuthJson = <T>(value: T, engine: AdminAuthDatabaseEngine) =>
  engine === "mariadb" && value !== null ? sql<T>`${JSON.stringify(value)}` : value;

export async function insertAdminSession(
  database: Kysely<DB>,
  values: InsertObject<DB, "admin_sessions">,
  engine: AdminAuthDatabaseEngine,
): Promise<{ id: string }> {
  const insert = database.insertInto("admin_sessions").values(values);
  if (engine === "postgres") return insert.returning("id").executeTakeFirstOrThrow();
  return { id: mariaDbInsertId((await insert.executeTakeFirstOrThrow()).insertId) };
}

export async function readAdminRoles(
  database: Kysely<DB>,
  accountId: string,
): Promise<AdminRole[]> {
  const rows = await database
    .selectFrom("admin_account_roles")
    .select("role")
    .where("admin_account_id", "=", accountId)
    .orderBy("role", "asc")
    .execute();
  if (rows.length === 0 || rows.some(({ role }) => !isAdminRole(role)))
    throw new AdminUnavailableException();
  return rows.map(({ role }) => role as AdminRole);
}
