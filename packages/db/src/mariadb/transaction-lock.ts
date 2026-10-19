import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { TransactionLockManager, TransactionLockMode } from "../transaction-lock.js";
import registry from "./transaction-lock.registry.json" with { type: "json" };

export const mariaDbRegisteredTransactionLockIdentities: readonly string[] = Object.freeze([
  ...registry.identities,
]);
const identities = new Set(mariaDbRegisteredTransactionLockIdentities),
  digestDomain = registry.digestDomain;

type Reason =
  | "invalid_identity"
  | "unregistered_identity"
  | "invalid_mode"
  | "transaction_required"
  | "transaction_settings"
  | "seed_missing"
  | "invalid_result";

/** Fixed diagnostics never contain the caller's identity or database parameters. */
export class MariaDbTransactionLockError extends Error {
  readonly code = "MARIADB_TRANSACTION_LOCK_REJECTED";
  constructor(readonly reason: Reason) {
    super(`MariaDB registered transaction lock rejected: ${reason}`);
    this.name = "MariaDbTransactionLockError";
  }
}

function digestFor(identity: string, mode: TransactionLockMode): Buffer {
  if (typeof identity !== "string" || identity.length === 0)
    throw new MariaDbTransactionLockError("invalid_identity");
  if (!identities.has(identity)) throw new MariaDbTransactionLockError("unregistered_identity");
  if (mode !== "shared" && mode !== "exclusive")
    throw new MariaDbTransactionLockError("invalid_mode");
  // Hash before any SQL is built; no raw identity reaches driver/query logging.
  return createHash("sha256")
    .update(digestDomain, "utf8")
    .update("\0")
    .update(identity, "utf8")
    .digest();
}

type DigestRow = { lock_digest: Buffer };
function matches(row: DigestRow | undefined, digest: Buffer): boolean {
  return Buffer.isBuffer(row?.lock_digest) && row.lock_digest.equals(digest);
}

async function lock<TDatabase extends object>(
  transaction: Transaction<TDatabase>,
  identity: string,
  mode: TransactionLockMode,
  tryOnly: boolean,
): Promise<boolean> {
  const digest = digestFor(identity, mode);
  if (transaction?.isTransaction !== true)
    throw new MariaDbTransactionLockError("transaction_required");
  // Every key must have been committed by the installer. Runtime accounts only
  // SELECT these immutable rows: lazy INSERT would turn a new shared lock into X.
  // Recheck on every call; cached existence would conceal a removed/missing seed.
  const seed = await sql<DigestRow & { in_transaction: number | string; isolation_level: string }>`
    SELECT lock_digest,@@in_transaction AS in_transaction,@@tx_isolation AS isolation_level
    FROM transaction_lock_keys WHERE lock_digest=${digest}`.execute(transaction);
  if (seed.rows.length === 0) throw new MariaDbTransactionLockError("seed_missing");
  if (seed.rows.length !== 1 || !matches(seed.rows[0], digest))
    throw new MariaDbTransactionLockError("invalid_result");
  if (![1, "1"].includes(seed.rows[0]!.in_transaction))
    throw new MariaDbTransactionLockError("transaction_required");
  if (seed.rows[0]!.isolation_level !== "READ-COMMITTED")
    throw new MariaDbTransactionLockError("transaction_settings");
  const clause = mode === "shared" ? sql`LOCK IN SHARE MODE` : sql`FOR UPDATE`;
  const skip = tryOnly ? sql`SKIP LOCKED` : sql``;
  const result = await sql<DigestRow>`SELECT lock_digest FROM transaction_lock_keys
    WHERE lock_digest=${digest} ${clause} ${skip}`.execute(transaction);
  if (tryOnly && result.rows.length === 0) return false;
  if (result.rows.length !== 1 || !matches(result.rows[0], digest))
    throw new MariaDbTransactionLockError("invalid_result");
  return true;
}

/**
 * REVIEW CANDIDATE: five pre-registered PostgreSQL hashtextextended(seed=0) keys.
 * Requires 0032's committed immutable seeds and SELECT-only runtime access.
 * This is not a general dynamic-identity adapter: worker/poll/retention and
 * hashtext/direct-bigint namespaces still need a separate migration design.
 * S/X ownership belongs to the transaction and ends on COMMIT/ROLLBACK. SKIP
 * LOCKED returns false without a SQL error, preserving the guarded driver's
 * rollback-only rule. Native failures propagate; there is no retry/cleanup SQL.
 * Blocking acquire uses the caller session's normal InnoDB lock wait timeout.
 */
export function createMariaDbRegisteredTransactionLockManager<
  TDatabase extends object,
>(): TransactionLockManager<TDatabase> {
  return {
    async acquire(transaction, identity, mode = "exclusive") {
      await lock(transaction, identity, mode, false);
    },
    tryAcquire(transaction, identity, mode = "exclusive") {
      return lock(transaction, identity, mode, true);
    },
  };
}
