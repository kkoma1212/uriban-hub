import { sql, type Transaction } from "kysely";

export type TransactionLockMode = "exclusive" | "shared";

export interface TransactionLockManager<TDatabase extends object> {
  /**
   * `identity` is opaque and may contain user-scoped values. Implementations
   * must bind it as data and must not log or persist the raw value.
   */
  acquire(
    transaction: Transaction<TDatabase>,
    identity: string,
    mode?: TransactionLockMode,
  ): Promise<void>;
  tryAcquire(
    transaction: Transaction<TDatabase>,
    identity: string,
    mode?: TransactionLockMode,
  ): Promise<boolean>;
}

function assertLockIdentity(identity: string): void {
  if (identity.length === 0) throw new RangeError("Transaction lock identity must not be empty.");
}

async function acquirePostgresTransactionLock<TDatabase extends object>(
  transaction: Transaction<TDatabase>,
  identity: string,
  mode: TransactionLockMode,
): Promise<void> {
  if (mode === "shared") {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${identity}, 0))`.execute(
      transaction,
    );
    return;
  }

  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`.execute(transaction);
}

async function tryAcquirePostgresTransactionLock<TDatabase extends object>(
  transaction: Transaction<TDatabase>,
  identity: string,
  mode: TransactionLockMode,
): Promise<boolean> {
  const result =
    mode === "shared"
      ? await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${identity}, 0)) AS acquired
        `.execute(transaction)
      : await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${identity}, 0)) AS acquired
        `.execute(transaction);
  const acquired = result.rows[0]?.acquired;
  if (typeof acquired !== "boolean") {
    throw new Error("Database transaction lock result is invalid.");
  }
  return acquired;
}

/**
 * Current production implementation. The identity is bound as a SQL value and
 * must already include any caller-specific namespace. A future MariaDB adapter
 * can implement the same transaction-scoped contract with digest-only lock
 * rows and `SELECT ... FOR UPDATE`; connection-scoped `GET_LOCK()` is not
 * equivalent.
 */
export function createPostgresTransactionLockManager<
  TDatabase extends object,
>(): TransactionLockManager<TDatabase> {
  return {
    async acquire(transaction, identity, mode = "exclusive"): Promise<void> {
      assertLockIdentity(identity);
      await acquirePostgresTransactionLock(transaction, identity, mode);
    },

    async tryAcquire(transaction, identity, mode = "exclusive"): Promise<boolean> {
      assertLockIdentity(identity);
      return tryAcquirePostgresTransactionLock(transaction, identity, mode);
    },
  };
}
