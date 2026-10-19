import { withSerializationRetry, type DB } from "@classhub/db";
import type { HttpException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { MembershipStatusChangedException } from "../membership.errors.js";
import type {
  OwnMembershipTransitionCommand,
  OwnMembershipTransitionResult,
} from "../membership.types.js";
import {
  invalidOwnMembershipInput,
  mapMariaDbOwnMembershipError,
  ownMembershipInternalError,
  ownMembershipRetryClassifier,
  type OwnMembershipOperation,
} from "./own-membership.errors.js";

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
type Identity = { class_id: string; id: string };
type Member = {
  id: string;
  role: string;
  status: string;
  row_version: string;
  display_name_in_class: string | null;
  student_number: number | null;
};
type Deny = (error: HttpException) => never;

function snapshot(input: OwnMembershipTransitionCommand): OwnMembershipTransitionCommand {
  const userId = input?.userId,
    requestId = input?.requestId;
  if (
    !validId(userId) ||
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId)
  )
    throw invalidOwnMembershipInput();
  return { userId, requestId };
}

/** Match the PG service's Date result; retain the original microseconds in DB evidence. */
function timestampDate(value: unknown): Date {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw ownMembershipInternalError();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw ownMembershipInternalError();
  return date;
}

async function transitionInTransaction(
  tx: Transaction<DB>,
  command: OwnMembershipTransitionCommand,
  identity: Identity,
  operation: OwnMembershipOperation,
  deny: Deny,
): Promise<OwnMembershipTransitionResult> {
  const leaving = operation === "leave";
  const expectedStatus = leaving ? "approved" : "pending";
  const nextStatus = leaving ? "left" : "canceled";
  const accounts = await sql<{
    deleted_at: string | null;
    display_name: string;
    is_active: number;
  }>`
    SELECT deleted_at,display_name,is_active FROM users WHERE id=${command.userId} FOR UPDATE`.execute(
    tx,
  );
  const account = accounts.rows[0];
  // Cancelling/leaving does not require email verification, signup approval or a teacher profile.
  if (!account || account.is_active !== 1 || account.deleted_at !== null)
    deny(new UnauthenticatedException());
  const classes = await sql<{ id: string; status: string }>`
    SELECT id,status FROM classes WHERE id=${identity.class_id} FOR UPDATE`.execute(tx);
  const targetClass = classes.rows[0];
  if (!targetClass || (targetClass.status !== "active" && targetClass.status !== "suspended"))
    deny(new MembershipStatusChangedException());
  if (targetClass.id !== identity.class_id) throw ownMembershipInternalError();
  const members = await sql<Member>`
    SELECT id,role,status,row_version,display_name_in_class,student_number FROM class_members
    WHERE id=${identity.id} AND class_id=${identity.class_id} AND user_id=${command.userId} FOR UPDATE`.execute(
    tx,
  );
  const member = members.rows[0];
  if (!member || member.role !== "student" || member.status !== expectedStatus)
    deny(new MembershipStatusChangedException());
  if (member.id !== identity.id || !validId(member.row_version)) throw ownMembershipInternalError();

  if (leaving) {
    await sql`CALL leave_class(${identity.class_id},${command.userId},${member.id},@own_membership_occurred_at)`.execute(
      tx,
    );
  } else {
    await sql`CALL cancel_class_membership_request(${identity.class_id},${command.userId},${member.id},@own_membership_occurred_at)`.execute(
      tx,
    );
  }
  const outputs = await sql<{
    occurred_at: string;
  }>`SELECT @own_membership_occurred_at AS occurred_at`.execute(tx);
  const occurredAt = outputs.rows[0]?.occurred_at;
  const statusChangedAt = timestampDate(occurredAt);
  const actorMemberId = leaving ? member.id : null;
  // OUT is connection-local mutable state. Bind it back to the exact member and history written by CALL.
  const changes = await sql<Member>`
    SELECT m.id,m.role,m.status,m.row_version,m.display_name_in_class,m.student_number
    FROM class_members m JOIN class_member_status_history h ON h.member_id=m.id AND h.class_id=m.class_id
    WHERE m.id=${member.id} AND m.class_id=${identity.class_id} AND m.user_id=${command.userId}
      AND m.role='student' AND m.status=${nextStatus} AND m.status_changed_at=${occurredAt} AND m.updated_at=${occurredAt}
      AND h.from_status=${expectedStatus} AND h.to_status=${nextStatus} AND h.actor_user_id=${command.userId}
      AND h.actor_member_id <=> ${actorMemberId} AND h.actor_operator_id IS NULL AND h.actor_admin_account_id IS NULL
      AND h.reason IS NULL AND h.created_at=${occurredAt}
    ORDER BY h.id DESC LIMIT 1`.execute(tx);
  const changed = changes.rows[0];
  if (
    !changed ||
    changed.id !== member.id ||
    changed.role !== "student" ||
    changed.status !== nextStatus ||
    changed.row_version !== (BigInt(member.row_version) + 1n).toString() ||
    changed.display_name_in_class !== member.display_name_in_class ||
    changed.student_number !== (leaving ? null : member.student_number)
  )
    throw ownMembershipInternalError();

  // P-016: seating, grouping and duty data are excluded from the MariaDB target.
  // Election records belong to their elections and survive leaving a class.
  const before = {
    display_name_snapshot: member.display_name_in_class ?? account.display_name,
    member_id: member.id,
    reason: null,
    role: "student",
    status: expectedStatus,
  };
  const after = { ...before, status: nextStatus };
  await sql`INSERT INTO audit_logs
    (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,after_json,before_json,
     class_id,reason,request_id,target_id,target_snapshot,target_type,created_at)
    VALUES (${leaving ? "member.left" : "member.request_canceled"},${account.display_name},${actorMemberId},'student',
      ${command.userId},${JSON.stringify(after)},${JSON.stringify(before)},${identity.class_id},NULL,
      ${command.requestId},${member.id},NULL,'member',${occurredAt})`.execute(tx);
  return {
    class_id: identity.class_id,
    membership_id: member.id,
    next_action: "BOOTSTRAP",
    row_version: changed.row_version,
    status: nextStatus,
    status_changed_at: statusChangedAt,
  };
}

async function transition(
  database: Kysely<DB>,
  input: OwnMembershipTransitionCommand,
  operation: OwnMembershipOperation,
): Promise<OwnMembershipTransitionResult> {
  const command = snapshot(input);
  const publicErrors = new WeakSet<object>();
  const deny: Deny = (error) => {
    publicErrors.add(error);
    throw error;
  };
  try {
    // Preserve PG's status-error precedence and identity across all retry attempts.
    const identities = await sql<Identity>`SELECT class_id,id FROM class_members
      WHERE user_id=${command.userId} AND role='student' AND status=${operation === "leave" ? "approved" : "pending"}
      LIMIT 1`.execute(database);
    const identity = identities.rows[0];
    if (!identity) deny(new MembershipStatusChangedException());
    if (!validId(identity.id) || !validId(identity.class_id)) throw ownMembershipInternalError();
    return await withSerializationRetry(
      () =>
        database
          .transaction()
          .execute((tx) => transitionInTransaction(tx, command, identity, operation, deny)),
      { errorClassifier: ownMembershipRetryClassifier },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    throw mapMariaDbOwnMembershipError(error, operation);
  }
}

/** MariaDB caller candidates. HTTP authentication/CSRF and live DB selection belong to the caller. */
export function cancelOwnMembershipMariaDb(
  database: Kysely<DB>,
  command: OwnMembershipTransitionCommand,
): Promise<OwnMembershipTransitionResult> {
  return transition(database, command, "cancel");
}

export function leaveOwnMembershipMariaDb(
  database: Kysely<DB>,
  command: OwnMembershipTransitionCommand,
): Promise<OwnMembershipTransitionResult> {
  return transition(database, command, "leave");
}
