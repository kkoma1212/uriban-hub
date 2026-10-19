import { createHash, randomUUID } from "node:crypto";

import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import type { TransferClassTeacherInput, TransferClassTeacherResult } from "../class-transfer.js";
import { normalizeTeacherEmail } from "../teacher-provision.js";
import { lockOperatorTransaction } from "../operator-lock.js";
import { MariaDbTransferError, mapMariaDbTransferError } from "./class-transfer-errors.js";

type Input = Omit<TransferClassTeacherInput, "operatorDatabaseUrl">;
type Context = {
  classId: string;
  outgoingUser: string;
  outgoingMember: string;
  incomingUser: string;
  incomingMember: string;
  operatorId: string;
  occurredAt: string;
  reactivated: boolean;
  reason: string | null;
  runId: string;
};

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}

/** The caller owns the attested pool; the checked routine preserves class invariants. */
export async function transferClassTeacherMariaDb(
  database: Kysely<DB>,
  input: Input,
): Promise<TransferClassTeacherResult> {
  try {
    if (
      !validId(input.classId) ||
      (input.reason !== undefined && Array.from(input.reason).length > 300)
    )
      throw new MariaDbTransferError("OPERATOR_INVALID_INPUT");
    if (!input.operatorToken) throw new MariaDbTransferError("OPERATOR_UNAUTHENTICATED");
    const toEmail = normalizeTeacherEmail(input.toEmail);
    const credentialHash = createHash("sha256").update(input.operatorToken, "utf8").digest();
    const authenticated = await sql<{ id: string }>`
      SELECT CAST(id AS CHAR) AS id FROM operators
      WHERE credential_hash=${credentialHash} AND status='active' AND revoked_at IS NULL
    `.execute(database);
    const operatorId = authenticated.rows[0]?.id;
    if (!validId(operatorId)) throw new MariaDbTransferError("OPERATOR_UNAUTHENTICATED");

    return await database.transaction().execute(async (transaction) => {
      await lockOperatorTransaction(transaction, "classhub:operator-lifecycle", { shared: true });
      // A revocation/rotation UPDATE must acquire this same row lock. Recheck the
      // original credential under the lock; a caller-provided operator id is not proof.
      const lockedOperator = await sql<{ id: string }>`
        SELECT CAST(id AS CHAR) AS id FROM operators
        WHERE id=${operatorId} AND credential_hash=${credentialHash}
          AND status='active' AND revoked_at IS NULL FOR UPDATE
      `.execute(transaction);
      if (lockedOperator.rows.length !== 1)
        throw new MariaDbTransferError("OPERATOR_UNAUTHENTICATED");

      // Capture the optimistic token before waiting for the invariant locks.
      const target = (
        await sql<{ row_version: string; status: string }>`
        SELECT CAST(row_version AS CHAR) AS row_version, status FROM classes WHERE id=${input.classId}
      `.execute(transaction)
      ).rows[0];
      if (!target) throw new MariaDbTransferError("OPERATOR_CLASS_NOT_FOUND");
      if (!["active", "suspended"].includes(target.status))
        throw new MariaDbTransferError("OPERATOR_CLASS_NOT_LIVE");
      const outgoing = (
        await sql<{ id: string; user_id: string }>`
        SELECT CAST(id AS CHAR) AS id, CAST(user_id AS CHAR) AS user_id FROM class_members
        WHERE class_id=${input.classId} AND role='teacher' AND status='approved'
      `.execute(transaction)
      ).rows;
      if (outgoing.length !== 1)
        throw new MariaDbTransferError("OPERATOR_OUTGOING_MEMBERSHIP_CHANGED");
      const previous = outgoing[0]!;
      const incoming = (
        await sql<{ id: string }>`
        SELECT CAST(id AS CHAR) AS id FROM users WHERE email_normalized=${toEmail} AND deleted_at IS NULL
      `.execute(transaction)
      ).rows[0];
      if (!incoming) throw new MariaDbTransferError("OPERATOR_INCOMING_USER_NOT_FOUND");

      // Match the routine's users(PK ascending) -> class -> members -> profile order.
      // Reading class prestate before these locks could omit reactivation audit rows.
      await sql`SELECT id FROM users FORCE INDEX (PRIMARY)
        WHERE id IN (${previous.user_id},${incoming.id}) ORDER BY id FOR UPDATE
      `.execute(transaction);
      const lockedClass = (
        await sql<{ status: string }>`
        SELECT status FROM classes WHERE id=${input.classId} FOR UPDATE
      `.execute(transaction)
      ).rows[0];
      if (!lockedClass) throw new MariaDbTransferError("OPERATOR_CLASS_NOT_FOUND");
      await sql`CALL transfer_class_teacher_checked(
        ${operatorId},${input.classId},${target.row_version},${previous.user_id},${previous.id},
        ${incoming.id},${input.reason ?? null},@transfer_member,@transfer_from,@transfer_at
      )`.execute(transaction);
      const output = (
        await sql<{ member_id: string; from_status: string | null; occurred_at: string }>`
        SELECT CAST(@transfer_member AS CHAR) AS member_id, @transfer_from AS from_status,
          DATE_FORMAT(@transfer_at,'%Y-%m-%d %H:%i:%s.%f') AS occurred_at
      `.execute(transaction)
      ).rows[0];
      if (
        !output ||
        !validId(output.member_id) ||
        output.from_status !== null ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(output.occurred_at)
      )
        throw new MariaDbTransferError("OPERATOR_TRANSFER_FAILED");

      const runId = randomUUID();
      await appendTransferAudit(transaction, {
        classId: input.classId,
        outgoingUser: previous.user_id,
        outgoingMember: previous.id,
        incomingUser: incoming.id,
        incomingMember: output.member_id,
        operatorId,
        occurredAt: output.occurred_at,
        reactivated: lockedClass.status === "suspended",
        reason: input.reason ?? null,
        runId,
      });
      return {
        classId: input.classId,
        fromUserId: previous.user_id,
        runId,
        toEmail,
        toUserId: incoming.id,
      };
    });
  } catch (error) {
    // Transaction.execute has already attempted the complete rollback here.
    // A lost COMMIT acknowledgement remains indeterminate; never retry automatically.
    throw mapMariaDbTransferError(error);
  }
}

async function appendTransferAudit(transaction: Transaction<DB>, context: Context): Promise<void> {
  const c = context;
  const classEvents = [
    ...(c.reactivated
      ? [
          {
            action: "class.reactivated",
            targetType: "class",
            targetId: c.classId,
            before: { class_id: c.classId, status: "suspended" },
            after: { class_id: c.classId, status: "active", suspended_reason: null },
          },
        ]
      : []),
    {
      action: "class.teacher_transferred",
      targetType: "member",
      targetId: c.incomingMember,
      before: { member_id: c.outgoingMember, role: "teacher", status: "transferred" },
      after: { member_id: c.incomingMember, role: "teacher", status: "approved" },
    },
  ];
  for (const event of classEvents)
    await sql`INSERT INTO audit_logs (
      class_id,actor_display_name_snapshot,actor_role_snapshot,action,target_type,target_id,
      before_json,after_json,reason,request_id,created_at
    ) VALUES (${c.classId},'운영자','operator',${event.action},${event.targetType},${event.targetId},
      ${JSON.stringify(event.before)},${JSON.stringify(event.after)},${c.reason},${c.runId},${c.occurredAt})
    `.execute(transaction);

  const operatorEvents = [
    ...(c.reactivated
      ? [
          {
            action: "class.reactivated",
            before: { class_id: c.classId, status: "suspended", teacher_user_id: c.outgoingUser },
            after: { class_id: c.classId, status: "active", teacher_user_id: c.incomingUser },
          },
        ]
      : []),
    {
      action: "teacher.transferred",
      before: { class_id: c.classId, teacher_user_id: c.outgoingUser },
      after: { class_id: c.classId, teacher_user_id: c.incomingUser },
    },
  ];
  for (const event of operatorEvents)
    await sql`INSERT INTO operator_audit_logs (
      actor_type,operator_id,action,target_type,target_id,before_json,after_json,run_id,created_at
    ) VALUES ('operator',${c.operatorId},${event.action},'class',${c.classId},
      ${JSON.stringify(event.before)},${JSON.stringify(event.after)},${c.runId},${c.occurredAt})
    `.execute(transaction);
}
