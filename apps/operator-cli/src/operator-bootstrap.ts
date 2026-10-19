import { operatorInsertedId, operatorJson } from "./operator-query.js";
import { lockOperatorTransaction } from "./operator-lock.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { openOperatorDatabase } from "./operator-database.js";

const PLACEHOLDER_SECRET = "replace-before-first-operator-bootstrap";

export interface BootstrapOperatorInput {
  bootstrapSecret: string | undefined;
  email: string;
  operatorDatabaseUrl: string | undefined;
}

export interface BootstrapOperatorResult {
  email: string;
  operatorId: string;
  rawToken: string;
  runId: string;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new Error("운영자 이메일 형식이 올바르지 않습니다.");
  }
  return normalized;
}

export function requireBootstrapSecret(secret: string | undefined): void {
  if (
    secret === undefined ||
    secret.length < 43 ||
    new Set(secret).size < 16 ||
    secret === PLACEHOLDER_SECRET
  ) {
    throw new Error("충분한 난수성을 가진 일회용 OPERATOR_BOOTSTRAP_SECRET이 필요합니다.");
  }
}

export async function bootstrapOperator(
  input: BootstrapOperatorInput,
): Promise<BootstrapOperatorResult> {
  requireBootstrapSecret(input.bootstrapSecret);

  const email = normalizeEmail(input.email);
  const rawToken = randomBytes(32).toString("base64url");
  const credentialHash = createHash("sha256").update(rawToken, "utf8").digest();
  const runId = randomUUID();
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);

  try {
    const operatorId = await database.transaction().execute(async (transaction) => {
      await lockOperatorTransaction(transaction, "classhub:operator-lifecycle");

      const existing = await transaction
        .selectFrom("operators")
        .select("id")
        .limit(1)
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new Error("최초 운영자는 operators table이 비어 있을 때만 생성할 수 있습니다.");
      }

      const insert = transaction
        .insertInto("operators")
        .values({ email_normalized: email, credential_hash: credentialHash });
      const operator = { id: await operatorInsertedId(transaction, insert) };

      await transaction
        .insertInto("operator_audit_logs")
        .values({
          action: "operator.bootstrapped",
          actor_type: "system",
          after_json: operatorJson(transaction, { operator_id: operator.id, status: "active" }),
          operator_id: null,
          run_id: runId,
          target_id: operator.id,
          target_type: "operator",
        })
        .execute();

      return operator.id;
    });

    return { email, operatorId, rawToken, runId };
  } finally {
    await database.destroy();
  }
}
