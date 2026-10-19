import type { DB } from "@classhub/db";
import { sql, type Transaction } from "kysely";
import type { DeleteAccountCommand } from "../account.types.js";
import { minimizeDeletedAccountGuardianConsent } from "../guardian-consent-minimization.js";
import { accountInternalError } from "./account-errors.js";
import { accountDate, accountId } from "./account-row-codec.js";

const deletedName = "탈퇴한 사용자";
const consentRetentionMs = 365 * 24 * 60 * 60 * 1000;

/** Called only after the shared user/session locks and current-password verification. */
export async function finishMariaDbAccountDeletion(
  tx: Transaction<DB>,
  command: DeleteAccountCommand,
  unusablePasswordHash: string,
): Promise<{ actorClassId: string | null; occurredAt: Date }> {
  accountId(command.userId);
  // Discovery takes no class/member locks. The routine checks this exact set under current locks.
  const before = await tx
    .selectFrom("class_members")
    .select(["id", "class_id", "role", "status", "row_version"])
    .where("user_id", "=", command.userId)
    .orderBy("class_id")
    .orderBy("id")
    .execute();
  const classIds = [...new Set(before.map((member) => accountId(member.class_id)))];
  if (
    classIds.length > 4096 ||
    classIds.some((id, i) => i > 0 && BigInt(id) <= BigInt(classIds[i - 1]!))
  )
    throw accountInternalError();
  // JSON numeric tokens, never Number conversion or quoted JSON strings: signed BIGINT stays exact.
  const classIdsJson = `[${classIds.join(",")}]`;
  if (Buffer.byteLength(classIdsJson, "utf8") > 131072) throw accountInternalError();
  const current = before.filter(
    (member) => member.status === "approved" || member.status === "pending",
  );
  if (current.length > 1) throw accountInternalError();
  await sql`CALL delete_user_account(${command.userId},${classIdsJson},${unusablePasswordHash},
    @account_deletion_class_id,@account_deletion_occurred_at)`.execute(tx);
  const outputs = await sql<{ actor_class_id: string | null; occurred_raw: string }>`
    SELECT CAST(@account_deletion_class_id AS CHAR) AS actor_class_id,
      DATE_FORMAT(@account_deletion_occurred_at,'%Y-%m-%d %H:%i:%s.%f') AS occurred_raw`.execute(
    tx,
  );
  const output = outputs.rows[0];
  if (!output) throw accountInternalError();
  const occurredAt = accountDate(output.occurred_raw);
  const actorClassId = output.actor_class_id === null ? null : accountId(output.actor_class_id);
  if (actorClassId !== (current[0]?.class_id ?? null)) throw accountInternalError();

  // Bind session-local OUT values to the persisted account, memberships and history, before trusting them.
  const deleted = await sql<{ id: string }>`SELECT id FROM users WHERE id=${command.userId}
    AND is_active=FALSE AND deleted_at=${output.occurred_raw} AND anonymized_at=${output.occurred_raw}
    AND updated_at=${output.occurred_raw} AND password_last_changed_at=${output.occurred_raw}
    AND display_name=${deletedName} AND email_normalized=${`deleted+${command.userId}@invalid.local`}
    AND password_hash=${unusablePasswordHash} AND failed_login_attempts=0 AND locked_until IS NULL`.execute(
    tx,
  );
  if (deleted.rows.length !== 1 || deleted.rows[0]?.id !== command.userId)
    throw accountInternalError();
  const after = await sql<{
    id: string;
    class_id: string;
    role: string;
    status: string;
    row_version: string;
    display_name_in_class: string | null;
    student_number: number | null;
    changed_raw: string;
    updated_raw: string;
  }>`SELECT id,class_id,role,status,row_version,display_name_in_class,student_number,
    DATE_FORMAT(status_changed_at,'%Y-%m-%d %H:%i:%s.%f') AS changed_raw,
    DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') AS updated_raw
    FROM class_members WHERE user_id=${command.userId} ORDER BY class_id,id`.execute(tx);
  if (after.rows.length !== before.length) throw accountInternalError();
  for (const [index, member] of before.entries()) {
    const changed = after.rows[index];
    const transitioned =
      member.role === "student" && ["pending", "approved"].includes(member.status);
    if (
      !changed ||
      changed.id !== member.id ||
      changed.class_id !== member.class_id ||
      changed.role !== member.role ||
      changed.status !== (transitioned ? "account_deleted" : member.status) ||
      changed.row_version !== (BigInt(member.row_version) + (transitioned ? 1n : 0n)).toString() ||
      changed.display_name_in_class !== null ||
      changed.student_number !== null ||
      changed.updated_raw !== output.occurred_raw ||
      (transitioned && changed.changed_raw !== output.occurred_raw)
    )
      throw accountInternalError();
    if (transitioned) {
      const actorMemberId = member.status === "approved" ? member.id : null;
      const history = await sql<{ id: string }>`SELECT id FROM class_member_status_history
        WHERE member_id=${member.id} AND class_id=${member.class_id}
          AND from_status=${member.status} AND to_status='account_deleted' AND actor_user_id=${command.userId}
          AND actor_member_id <=> ${actorMemberId} AND actor_operator_id IS NULL AND actor_admin_account_id IS NULL
          AND reason IS NULL AND created_at=${output.occurred_raw}`.execute(tx);
      if (history.rows.length !== 1) throw accountInternalError();
    }
  }

  // Preserve acquisition order: user/session → ascending classes/members (CALL) → tokens.
  for (const table of ["email_verification_tokens", "password_reset_tokens"] as const) {
    await tx
      .selectFrom(table)
      .select("id")
      .where("user_id", "=", command.userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .orderBy("id")
      .forUpdate()
      .execute();
  }
  const student = current[0]?.role === "student" ? current[0] : undefined;
  if (student) {
    const actorMemberId = student.status === "approved" ? student.id : null;
    const snapshot = {
      display_name_snapshot: deletedName,
      member_id: student.id,
      reason: null,
      role: "student",
      status: student.status,
    };
    await sql`INSERT INTO audit_logs
      (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,
       after_json,before_json,class_id,reason,request_id,target_id,target_snapshot,target_type,created_at)
      VALUES ('member.account_deleted',${deletedName},${actorMemberId},'student',${command.userId},
        ${JSON.stringify({ ...snapshot, status: "account_deleted" })},${JSON.stringify(snapshot)},
        ${student.class_id},NULL,${command.requestId},${student.id},NULL,'member',${output.occurred_raw})`.execute(
      tx,
    );
  }
  for (const table of ["email_verification_tokens", "password_reset_tokens"] as const) {
    await tx
      .updateTable(table)
      .set({ invalidated_at: occurredAt })
      .where("user_id", "=", command.userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .execute();
  }
  await tx
    .updateTable("sessions")
    .set({ revoked_at: occurredAt })
    .where("user_id", "=", command.userId)
    .where("revoked_at", "is", null)
    .execute();

  // Retained MariaDB tables are required; P-016 excludes seating, grouping and duty data.
  await tx
    .deleteFrom("student_assessment_records")
    .where("owner_user_id", "=", command.userId)
    .execute();
  const membershipIds = before.map(({ id }) => id);
  if (membershipIds.length > 0) {
    for (const table of ["poll_votes", "election_participants"] as const) {
      await tx.deleteFrom(table).where("member_id", "in", membershipIds).execute();
    }
    // Tallies reference candidates: retain the candidate row and counts, scrub only its PII snapshots.
    await tx
      .updateTable("election_candidates")
      .set({ display_name_snapshot: deletedName, student_number_snapshot: null })
      .where("member_id", "in", membershipIds)
      .execute();
  }
  await tx
    .updateTable("user_consents")
    .set({
      ip_address: null,
      withdrawn_at: occurredAt,
      retention_expires_at: new Date(occurredAt.getTime() + consentRetentionMs),
    })
    .where("user_id", "=", command.userId)
    .where("withdrawn_at", "is", null)
    .where("retention_expires_at", "is", null)
    .execute();
  await minimizeDeletedAccountGuardianConsent(tx, command.userId);
  return { actorClassId, occurredAt };
}
