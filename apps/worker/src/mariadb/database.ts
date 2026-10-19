import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMariaDbDatabase,
  type DB,
  type MariaDbConnectionOptions,
  type MariaDbPoolFactory,
} from "@classhub/db";
import { sql, type Kysely } from "kysely";
import { boundedWorkerPoolFactory, WorkerMariaDbDatabaseError } from "./bounded-pool.js";

export type WorkerMariaDbDatabase = Kysely<DB>;
export type WorkerMariaDbOptions = Omit<MariaDbConnectionOptions, "runtimeRole" | "accountHost"> & {
  accountHost: string;
};
const readiness = new AsyncLocalStorage<boolean>();
const owned = new WeakSet<WorkerMariaDbDatabase>();

export async function assertWorkerMariaDbDatabaseRole(
  database: WorkerMariaDbDatabase,
): Promise<void> {
  try {
    if (!owned.has(database)) throw new WorkerMariaDbDatabaseError("configuration");
    // Acquiring this lease performs the shared exact worker ACL/TLS/identity attestation first.
    await sql`SELECT 1 AS worker_role_ready`.execute(database);
  } catch {
    throw new WorkerMariaDbDatabaseError("role");
  }
}

/** Opt-in candidate. Existing worker PostgreSQL environment/main selection stays unchanged. */
export async function openWorkerMariaDbDatabase(
  createPool: MariaDbPoolFactory,
  options: WorkerMariaDbOptions,
  onUnexpectedPoolError?: () => void,
): Promise<WorkerMariaDbDatabase> {
  let database: WorkerMariaDbDatabase | undefined;
  try {
    database = createMariaDbDatabase<DB>(
      boundedWorkerPoolFactory(
        createPool,
        () => readiness.getStore() === true,
        onUnexpectedPoolError,
      ),
      { ...options, runtimeRole: "worker" },
    );
    owned.add(database);
    await assertWorkerMariaDbDatabaseRole(database);
    return database;
  } catch {
    if (database) {
      owned.delete(database);
      try {
        await database.destroy();
      } catch {
        throw new WorkerMariaDbDatabaseError("cleanup");
      }
    }
    throw new WorkerMariaDbDatabaseError(database ? "role" : "configuration");
  }
}

/** One-second server statement cap on this lease, with awaited COMMIT or guarded rollback/discard.
 * The five-second client connection/query cap matches PG. PG's 1.5-second idle-in-transaction
 * server setting has no proven exact MariaDB counterpart here; it is an activation gap.
 * No arbitrary 1/2-second idle policy is installed, and no SQL text is rewritten.
 * https://mariadb.com/docs/server/reference/sql-statements/transactions/transaction-timeouts
 */
export async function probeWorkerMariaDbReadiness(database: WorkerMariaDbDatabase): Promise<void> {
  try {
    if (!owned.has(database)) throw new WorkerMariaDbDatabaseError("configuration");
    await readiness.run(true, () =>
      database.transaction().execute(async (transaction) => {
        const result = await sql<{ ready: number }>`SELECT 1 AS ready`.execute(transaction);
        if (result.rows.length !== 1 || result.rows[0]?.ready !== 1)
          throw new WorkerMariaDbDatabaseError("readiness");
      }),
    );
  } catch {
    throw new WorkerMariaDbDatabaseError("readiness");
  }
}
