import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { sql, type Kysely, type Transaction } from "kysely";

declare const preparedWorkerAuditLock: unique symbol;
/** Opaque, reusable by the manager which prepared it; contains no public identity/digest. */
export interface PreparedWorkerAuditLock {
  readonly [preparedWorkerAuditLock]: true;
}
export interface MariaDbWorkerAuditLockManager<TDatabase extends object> {
  prepare(database: Kysely<TDatabase>, identity: string): Promise<PreparedWorkerAuditLock>;
  acquire(transaction: Transaction<TDatabase>, handle: PreparedWorkerAuditLock): Promise<void>;
}
type Reason =
  | "invalid_identity"
  | "database_required"
  | "prepare_inside_transaction"
  | "transaction_required"
  | "transaction_settings"
  | "invalid_handle"
  | "registration_missing"
  | "invalid_result";

export class MariaDbWorkerAuditLockError extends Error {
  readonly code = "MARIADB_WORKER_AUDIT_LOCK_REJECTED";
  constructor(readonly reason: Reason) {
    super(`MariaDB worker audit lock rejected: ${reason}`);
    this.name = "MariaDbWorkerAuditLockError";
  }
}

function digestFor(identity: string): Buffer {
  if (
    typeof identity !== "string" ||
    identity.length === 0 ||
    identity.length > 4096 ||
    identity.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(identity) ||
    Buffer.byteLength(identity, "utf8") > 4096
  )
    throw new MariaDbWorkerAuditLockError("invalid_identity");
  // Worker scope JSON comes from securityAuditDeduplicationScope. This domain
  // marks its source algorithm; it is not a new PostgreSQL advisory key space.
  return createHash("sha256")
    .update("classhub:mariadb:worker-audit-lock:v1:pg-hashtextextended:0\0", "utf8")
    .update(identity, "utf8")
    .digest();
}
function duplicateRegistration(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, "errno")?.value === 1062 &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === "23000"
  );
}
type Row = { lock_digest: Buffer };
function validateRow(rows: Row[], digest: Buffer, required: boolean): boolean {
  if (rows.length === 0) {
    if (required) throw new MariaDbWorkerAuditLockError("registration_missing");
    return false;
  }
  if (
    rows.length !== 1 ||
    !Buffer.isBuffer(rows[0]?.lock_digest) ||
    !rows[0].lock_digest.equals(digest)
  )
    throw new MariaDbWorkerAuditLockError("invalid_result");
  return true;
}
async function find<TDatabase extends object>(
  database: Kysely<TDatabase>,
  digest: Buffer,
  required = false,
): Promise<boolean> {
  const result = await sql<Row>`SELECT lock_digest FROM worker_security_audit_lock_keys
    WHERE lock_digest=${Buffer.from(digest)}`.execute(database);
  return validateRow(result.rows, digest, required);
}

/**
 * Review-only worker scope candidate; 0032's five immutable keys are untouched.
 * Requires SELECT/INSERT on operational worker_security_audit_lock_keys.
 * prepare must finish (including release) before opening the business tx, so
 * a one-connection pool never needs a second simultaneous lease.
 * Registrations remain after business failure/success and grow with distinct
 * scopes. No production TTL/DELETE is implemented. QA cleanup belongs to the
 * isolated installer after every worker/pool has stopped.
 */
export function createMariaDbWorkerAuditLockManager<
  TDatabase extends object,
>(): MariaDbWorkerAuditLockManager<TDatabase> {
  const handles = new WeakMap<object, Buffer>();
  return {
    async prepare(database, identity) {
      const digest = digestFor(identity);
      if (database?.isTransaction === true)
        throw new MariaDbWorkerAuditLockError("prepare_inside_transaction");
      if (database?.isTransaction !== false)
        throw new MariaDbWorkerAuditLockError("database_required");
      const collision = new Error("Worker audit lock registration collision");
      try {
        await database.transaction().execute(async (transaction) => {
          if (await find(transaction, digest)) return;
          try {
            // This INSERT has only the supplied digest primary key, no other
            // uniqueness constraint. Only its native duplicate is recoverable.
            const result = await sql`INSERT INTO worker_security_audit_lock_keys (lock_digest)
              VALUES (${Buffer.from(digest)})`.execute(transaction);
            if (result.numAffectedRows !== 1n)
              throw new MariaDbWorkerAuditLockError("invalid_result");
          } catch (error) {
            if (duplicateRegistration(error)) throw collision;
            throw error;
          }
        });
      } catch (error) {
        if (error !== collision) throw error;
        // Kysely has rolled back and released the poisoned registration lease.
        // Recheck the winner using a fresh lease; never catch 1062 and continue
        // the same transaction or report success after an uncertain COMMIT.
        await find(database, digest, true);
      }
      const handle = Object.freeze({}) as PreparedWorkerAuditLock;
      handles.set(handle, digest);
      return handle;
    },
    async acquire(transaction, handle) {
      const digest =
        typeof handle === "object" && handle !== null ? handles.get(handle) : undefined;
      if (!digest) throw new MariaDbWorkerAuditLockError("invalid_handle");
      if (transaction?.isTransaction !== true)
        throw new MariaDbWorkerAuditLockError("transaction_required");
      const result = await sql<Row & { in_transaction: number | string; isolation_level: string }>`
        SELECT lock_digest,@@in_transaction AS in_transaction,@@tx_isolation AS isolation_level
        FROM worker_security_audit_lock_keys WHERE lock_digest=${Buffer.from(digest)} FOR UPDATE`.execute(
        transaction,
      );
      validateRow(result.rows, digest, true);
      if (![1, "1"].includes(result.rows[0]!.in_transaction))
        throw new MariaDbWorkerAuditLockError("transaction_required");
      if (result.rows[0]!.isolation_level !== "READ-COMMITTED")
        throw new MariaDbWorkerAuditLockError("transaction_settings");
    },
  };
}
