import { createHash } from "node:crypto";
import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";
import { isMariaDbOperatorDatabase } from "./operator-engine.js";

export const operatorLockNames = Object.freeze([
  "classhub:operator-lifecycle",
  "classhub:meal-import",
  "classhub:school-import",
  "classhub:school-schedule-import",
  "classhub:public-holiday-import",
  "classhub:teacher-provision",
  "classhub:admin-provision",
]);

/** Immutable seeded keys; locks end with the transaction, including dry-runs. */
export async function lockOperatorTransaction(
  transaction: Transaction<DB>,
  identity: string,
  { shared = false, tryOnly = false }: { shared?: boolean; tryOnly?: boolean } = {},
): Promise<boolean> {
  if (!operatorLockNames.includes(identity) || !transaction.isTransaction) {
    throw new Error("운영 명령의 트랜잭션 잠금 설정이 올바르지 않습니다.");
  }
  if (!isMariaDbOperatorDatabase(transaction)) {
    if (tryOnly) {
      const result = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${identity},0)) AS acquired`.execute(
        transaction,
      );
      return result.rows[0]?.acquired === true;
    }
    const name = shared ? sql`pg_advisory_xact_lock_shared` : sql`pg_advisory_xact_lock`;
    await sql`SELECT ${name}(hashtextextended(${identity},0))`.execute(transaction);
    return true;
  }
  const digest = createHash("sha256")
    .update("classhub:mariadb:operator-lock:v1\0" + identity)
    .digest();
  const seed = await sql<{ lock_digest: Buffer; active: number; isolation: string }>`
    SELECT lock_digest,@@in_transaction AS active,@@tx_isolation AS isolation
    FROM operator_transaction_lock_keys WHERE lock_digest=${digest}`.execute(transaction);
  if (
    seed.rows.length !== 1 ||
    !Buffer.isBuffer(seed.rows[0]?.lock_digest) ||
    !seed.rows[0].lock_digest.equals(digest) ||
    Number(seed.rows[0].active) !== 1 ||
    seed.rows[0].isolation !== "READ-COMMITTED"
  ) {
    throw new Error("운영 명령의 잠금 키 또는 DB 격리 설정을 확인할 수 없습니다.");
  }
  const mode = shared ? sql`LOCK IN SHARE MODE` : sql`FOR UPDATE`;
  const skip = tryOnly ? sql`SKIP LOCKED` : sql``;
  const result = await sql<{
    lock_digest: Buffer;
  }>`SELECT lock_digest FROM operator_transaction_lock_keys
    WHERE lock_digest=${digest} ${mode} ${skip}`.execute(transaction);
  if (tryOnly && result.rows.length === 0) return false;
  if (
    result.rows.length !== 1 ||
    !Buffer.isBuffer(result.rows[0]?.lock_digest) ||
    !result.rows[0].lock_digest.equals(digest)
  ) {
    throw new Error("운영 명령의 잠금을 확인할 수 없습니다.");
  }
  return true;
}
