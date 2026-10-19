import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";
import { RetentionMariaDbError } from "./errors.js";

export const retentionLockTables = [
  "attendance_notifications",
  "guardian_consent_requests",
  "student_assessment_records",
] as const;
export type RetentionLockTable = (typeof retentionLockTables)[number];
export const retentionLockDigestDomain = "classhub:mariadb:transaction-lock:v1:pg-hashtext";

export function retentionLockDigest(table: RetentionLockTable): Buffer {
  if (!retentionLockTables.includes(table)) throw new RetentionMariaDbError("unregistered_lock");
  // Only retained PG hashtext identities are allowed; 0032 uses a distinct algorithm/domain.
  return createHash("sha256")
    .update(retentionLockDigestDomain)
    .update("\0")
    .update(`classhub.${table}.retention.v1`)
    .digest();
}

export async function acquireRetentionLock(
  transaction: Transaction<DB>,
  table: RetentionLockTable,
): Promise<void> {
  if (transaction.isTransaction !== true) throw new RetentionMariaDbError("transaction_required");
  const digest = retentionLockDigest(table);
  const result = await sql<{
    lock_digest: Buffer;
    in_transaction: number | string;
    isolation_level: string;
  }>`
    SELECT lock_digest, @@in_transaction AS in_transaction, @@tx_isolation AS isolation_level
    FROM retention_lock_keys WHERE lock_digest=${digest} FOR UPDATE
  `.execute(transaction);
  if (result.rows.length === 0) throw new RetentionMariaDbError("seed_missing");
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !Buffer.isBuffer(row?.lock_digest) ||
    !row.lock_digest.equals(digest)
  ) {
    throw new RetentionMariaDbError("invalid_result");
  }
  if (![1, "1"].includes(row.in_transaction) || row.isolation_level !== "READ-COMMITTED") {
    throw new RetentionMariaDbError("transaction_settings");
  }
}
