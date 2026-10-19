import { createHash } from "node:crypto";

import { type DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { lockOperatorTransaction } from "./operator-lock.js";
import { isMariaDbOperatorDatabase } from "./operator-engine.js";

const OPERATOR_LIFECYCLE_LOCK_NAME = "classhub:operator-lifecycle";

export interface AuthenticatedOperator {
  credentialHash: Buffer;
  operatorId: string;
}

export async function authenticateOperator(
  database: Kysely<DB>,
  operatorToken: string,
): Promise<AuthenticatedOperator> {
  if (operatorToken.length === 0) throw new Error("operator token이 필요합니다.");
  const credentialHash = createHash("sha256").update(operatorToken, "utf8").digest();
  const operator = await database
    .selectFrom("operators")
    .select("id")
    .where("credential_hash", "=", credentialHash)
    .where("status", "=", "active")
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (operator === undefined) throw new Error("유효한 active operator token이 아닙니다.");
  return { credentialHash, operatorId: operator.id };
}

export async function lockAndRevalidateOperator(
  transaction: Transaction<DB>,
  authenticatedOperator: AuthenticatedOperator,
): Promise<void> {
  await lockOperatorTransaction(transaction, OPERATOR_LIFECYCLE_LOCK_NAME, { shared: true });
  const query = transaction
    .selectFrom("operators")
    .select("id")
    .where("id", "=", authenticatedOperator.operatorId)
    .where("credential_hash", "=", authenticatedOperator.credentialHash)
    .where("status", "=", "active")
    .where("revoked_at", "is", null);
  const operator = await (
    isMariaDbOperatorDatabase(transaction) ? query.modifyEnd(sql`LOCK IN SHARE MODE`) : query
  ).executeTakeFirst();
  if (operator === undefined) throw new Error("유효한 active operator token이 아닙니다.");
}
