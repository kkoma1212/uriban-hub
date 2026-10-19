import { types } from "node:util";

import { createPostgresTransactionLockManager, type DB } from "@classhub/db";
import type { ConfigService } from "@nestjs/config";
import type { InsertObject, Kysely, Transaction } from "kysely";

import {
  adminAuthDatabase,
  type AdminAuthDatabaseEngine,
} from "../admin-auth/admin-auth.database.js";
import {
  createMariaDbRowCodec,
  mariaDbDateTime,
  mariaDbInsertId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";

const listCodec = createMariaDbRowCodec({ last_login_at: mariaDbNullable(mariaDbDateTime) });
const postgresLocks = createPostgresTransactionLockManager<DB>();

export function adminAccountsDatabase(
  database: Kysely<DB>,
  config: ConfigService<AppEnvironment, true>,
) {
  const selected = adminAuthDatabase(database, config);
  return {
    engine: selected.engine,
    database:
      selected.engine === "mariadb" ? selected.database.withPlugin(listCodec) : selected.database,
  };
}

export class AdminAccountInsertCollision extends Error {
  constructor(readonly insertError: unknown) {
    super("Administrator account insert requires post-rollback identity verification.");
  }
}

function isNativeDuplicate(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, "errno")?.value === 1062 &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "23000" &&
    Object.getOwnPropertyDescriptor(error, "code")?.value === "ER_DUP_ENTRY"
  );
}

export async function insertAdminAccount(
  transaction: Transaction<DB>,
  values: InsertObject<DB, "admin_accounts">,
  engine: AdminAuthDatabaseEngine,
) {
  const insert = transaction.insertInto("admin_accounts").values(values);
  if (engine === "postgres") return insert.returning(["id", "status"]).executeTakeFirstOrThrow();

  let result;
  try {
    result = await insert.executeTakeFirstOrThrow();
  } catch (error) {
    // Only this INSERT can recover by email lookup. Roles/audit/COMMIT errors must propagate.
    if (isNativeDuplicate(error)) throw new AdminAccountInsertCollision(error);
    throw error;
  }
  if (result.numInsertedOrUpdatedRows !== 1n)
    throw new Error("Unexpected administrator account insert result.");
  const id = mariaDbInsertId(result.insertId);
  return transaction
    .selectFrom("admin_accounts")
    .select(["id", "status"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

export async function lockAdminAccountEmail(
  transaction: Transaction<DB>,
  email: string,
  engine: AdminAuthDatabaseEngine,
): Promise<void> {
  // MariaDB's email UNIQUE index arbitrates absent rows. The losing INSERT must
  // fully roll back before a new transaction verifies the winner and its roles.
  if (engine === "postgres") await postgresLocks.acquire(transaction, `admin-account:${email}`);
}

export async function lockAdminAccountLiveness(
  transaction: Transaction<DB>,
  engine: AdminAuthDatabaseEngine,
): Promise<void> {
  if (engine === "postgres") {
    await postgresLocks.acquire(transaction, "admin-super-admin-liveness");
    return;
  }
  // App/operator ACLs forbid deleting accounts, changing IDs or supplying IDs
  // on INSERT. The first account is a stable anchor even after revocation.
  // Always lock it before a target account; no registered lock key/extra ACL is needed.
  await transaction
    .selectFrom("admin_accounts")
    .select("id")
    .orderBy("id", "asc")
    .limit(1)
    .forUpdate()
    .executeTakeFirstOrThrow();
}
