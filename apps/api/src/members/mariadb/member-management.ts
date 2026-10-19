import type { DB } from "@classhub/db";
import type { HttpException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { isAllowedPlainText } from "../../common/validation/text-validation.js";
import {
  ClassSuspendedException,
  MemberAccountInactiveException,
  MemberNotFoundException,
  MemberStatusChangedException,
  RoleInsufficientException,
  StudentNumberAlreadyInUseException,
} from "../members.errors.js";
import type {
  ApproveMemberCommand,
  ApproveMemberResult,
  MemberTransitionCommand,
  MemberTransitionResult,
} from "../members.types.js";
import { includeMemberInClassWideContent } from "../../content-audiences/class-wide-recipients.js";
import {
  invalidMemberManagementInput,
  mapMariaDbMemberManagementError,
  memberManagementInternalError,
  type MemberManagementOperation,
} from "./member-management.errors.js";

type Command = ApproveMemberCommand & { reason: string | null };
type Identity = {
  actorMemberId: string;
  classId: string;
  targetMemberId: string;
  targetUserId: string;
};
type Account = { id: string; deleted_at: string | null; is_active: number; display_name: string };
type Member = {
  id: string;
  class_id: string;
  user_id: string;
  role: string;
  status: string;
  row_version: string;
  display_name_in_class: string | null;
  student_number: number | null;
};
type Deny = (error: HttpException) => never;
const statuses = {
  approve: { before: "pending", after: "approved", action: "member.approved" },
  reject: { before: "pending", after: "rejected", action: "member.rejected" },
  remove: { before: "approved", after: "removed", action: "member.removed" },
  rejoin: { before: "removed", after: "rejoin_allowed", action: "member.rejoin_allowed" },
} as const;
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const active = (account: Account | undefined) =>
  account?.is_active === 1 && account.deleted_at === null;
const ordered = (...ids: string[]) =>
  [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

function snapshot(
  input: ApproveMemberCommand | MemberTransitionCommand,
  operation: MemberManagementOperation,
): Command {
  const actorUserId = input?.actorUserId,
    requestId = input?.requestId;
  // Path IDs retain PG's MEMBER_NOT_FOUND boundary, including numeric IDs with leading zeroes.
  const memberId =
    typeof input?.memberId === "string" && /^[0-9]+$/u.test(input.memberId)
      ? input.memberId.replace(/^0+/u, "")
      : "";
  if (!validId(memberId)) throw new MemberNotFoundException();
  if (
    !validId(actorUserId) ||
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId)
  )
    throw invalidMemberManagementInput();
  let displayNameInClass: string | null = null,
    studentNumber: number | null = null,
    reason: string | null = null;
  if (operation === "approve") {
    const approval = input as ApproveMemberCommand;
    const name = approval.displayNameInClass;
    displayNameInClass = typeof name === "string" ? name.trim() : name;
    studentNumber = approval.studentNumber;
    if (
      (displayNameInClass !== null &&
        (typeof displayNameInClass !== "string" ||
          [...displayNameInClass].length < 2 ||
          [...displayNameInClass].length > 20 ||
          /[\uD800-\uDFFF]/u.test(displayNameInClass) ||
          !isAllowedPlainText(displayNameInClass))) ||
      (studentNumber !== null &&
        (!Number.isInteger(studentNumber) || studentNumber < 1 || studentNumber > 99))
    )
      throw invalidMemberManagementInput();
  } else {
    const value = (input as MemberTransitionCommand).reason;
    if (
      value !== null &&
      (typeof value !== "string" ||
        [...value.trim()].length > 300 ||
        /[\uD800-\uDFFF]/u.test(value) ||
        !isAllowedPlainText(value.trim()))
    )
      throw invalidMemberManagementInput();
    reason = value?.trim() || null;
  }
  return { actorUserId, requestId, memberId, displayNameInClass, studentNumber, reason };
}

async function preliminaryIdentity(
  database: Kysely<DB>,
  command: Command,
  deny: Deny,
): Promise<Identity> {
  const contexts = await sql<{
    class_id: string;
    class_status: string;
    member_id: string;
    role: string;
    profile_status: string | null;
    temporary_password_must_change: number | null;
  }>`
    SELECT c.id AS class_id,c.status AS class_status,m.id AS member_id,m.role,
      p.status AS profile_status,p.temporary_password_must_change
    FROM class_members m JOIN classes c ON c.id=m.class_id LEFT JOIN teacher_profiles p ON p.user_id=m.user_id
    WHERE m.user_id=${command.actorUserId} AND m.status IN ('pending','approved') LIMIT 1`.execute(
    database,
  );
  const context = contexts.rows[0];
  if (!context) deny(new MemberNotFoundException());
  const targets = await sql<{ class_id: string; id: string; user_id: string }>`
    SELECT class_id,id,user_id FROM class_members WHERE id=${command.memberId}`.execute(database);
  const target = targets.rows[0];
  if (!target || target.class_id !== context.class_id) deny(new MemberNotFoundException());
  if (context.class_status === "suspended") deny(new ClassSuspendedException());
  if (
    context.class_status !== "active" ||
    context.role !== "teacher" ||
    context.profile_status !== "active" ||
    context.temporary_password_must_change !== 0
  )
    deny(new RoleInsufficientException());
  if (
    !validId(context.class_id) ||
    !validId(context.member_id) ||
    !validId(target.user_id) ||
    target.id !== command.memberId
  )
    throw memberManagementInternalError();
  return {
    actorMemberId: context.member_id,
    classId: context.class_id,
    targetMemberId: target.id,
    targetUserId: target.user_id,
  };
}

async function lockedContext(
  tx: Transaction<DB>,
  command: Command,
  identity: Identity,
  operation: MemberManagementOperation,
  deny: Deny,
) {
  const accounts =
    await sql<Account>`SELECT id,deleted_at,display_name,is_active FROM users FORCE INDEX (PRIMARY)
    WHERE id IN (${sql.join(ordered(command.actorUserId, identity.targetUserId))}) ORDER BY id FOR UPDATE`.execute(
      tx,
    );
  const actorAccount = accounts.rows.find((row) => row.id === command.actorUserId);
  const targetAccount = accounts.rows.find((row) => row.id === identity.targetUserId);
  // Approval checks target eligibility first; other transitions allow inactive/deleted targets.
  if (operation === "approve" && (!targetAccount || !active(targetAccount)))
    deny(new MemberAccountInactiveException());
  if (!actorAccount || !active(actorAccount)) deny(new RoleInsufficientException());
  if (!targetAccount) deny(new MemberNotFoundException());
  const classes = await sql<{ id: string; status: string; expected_student_count: number }>`
    SELECT id,status,expected_student_count FROM classes WHERE id=${identity.classId} FOR UPDATE`.execute(
    tx,
  );
  const targetClass = classes.rows[0];
  if (!targetClass || targetClass.status === "archived") deny(new MemberNotFoundException());
  if (targetClass.status === "suspended") deny(new ClassSuspendedException());
  if (targetClass.id !== identity.classId || targetClass.status !== "active")
    throw memberManagementInternalError();
  const members =
    await sql<Member>`SELECT class_id,display_name_in_class,id,role,row_version,status,user_id,student_number
    FROM class_members WHERE id IN (${sql.join(ordered(identity.actorMemberId, identity.targetMemberId))})
    ORDER BY id FOR UPDATE`.execute(tx);
  const actorMember = members.rows.find((row) => row.id === identity.actorMemberId);
  const targetMember = members.rows.find((row) => row.id === identity.targetMemberId);
  if (
    !actorMember ||
    actorMember.class_id !== targetClass.id ||
    actorMember.user_id !== command.actorUserId ||
    actorMember.role !== "teacher" ||
    actorMember.status !== "approved"
  )
    deny(new RoleInsufficientException());
  const profiles = await sql<{ status: string; temporary_password_must_change: number }>`
    SELECT status,temporary_password_must_change FROM teacher_profiles WHERE user_id=${command.actorUserId} FOR UPDATE`.execute(
    tx,
  );
  if (
    profiles.rows[0]?.status !== "active" ||
    profiles.rows[0]?.temporary_password_must_change !== 0
  )
    deny(new RoleInsufficientException());
  if (
    !targetMember ||
    targetMember.class_id !== targetClass.id ||
    targetMember.user_id !== identity.targetUserId ||
    targetMember.role !== "student"
  )
    deny(new MemberNotFoundException());
  if (targetMember.status !== statuses[operation].before) deny(new MemberStatusChangedException());
  if (!validId(targetMember.row_version)) throw memberManagementInternalError();
  return { actorAccount, targetAccount, targetClass, actorMember, targetMember };
}
type LockedContext = Awaited<ReturnType<typeof lockedContext>>;

function timestampIso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw memberManagementInternalError();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z",
    date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw memberManagementInternalError();
  return iso;
}

async function callManagement(
  tx: Transaction<DB>,
  command: Command,
  identity: Identity,
  operation: MemberManagementOperation,
) {
  // Fixed procedure names and bound values; routines own history and state transitions.
  switch (operation) {
    case "approve":
      await sql`CALL approve_class_member(${identity.classId},${command.actorUserId},${identity.actorMemberId},
        ${identity.targetUserId},${identity.targetMemberId},${command.displayNameInClass},${command.studentNumber},@member_management_occurred_at)`.execute(
        tx,
      );
      break;
    case "reject":
      await sql`CALL reject_class_member(${identity.classId},${command.actorUserId},${identity.actorMemberId},
        ${identity.targetUserId},${identity.targetMemberId},${command.reason},@member_management_occurred_at)`.execute(
        tx,
      );
      break;
    case "remove":
      await sql`CALL remove_class_member(${identity.classId},${command.actorUserId},${identity.actorMemberId},
        ${identity.targetUserId},${identity.targetMemberId},${command.reason},@member_management_occurred_at)`.execute(
        tx,
      );
      break;
    case "rejoin":
      await sql`CALL allow_class_member_rejoin(${identity.classId},${command.actorUserId},${identity.actorMemberId},
        ${identity.targetUserId},${identity.targetMemberId},${command.reason},@member_management_occurred_at)`.execute(
        tx,
      );
      break;
  }
  const result = await sql<{
    occurred_at: string;
  }>`SELECT @member_management_occurred_at AS occurred_at`.execute(tx);
  const occurredAt = result.rows[0]?.occurred_at;
  const statusChangedAt = timestampIso(occurredAt);
  return { occurredAt, statusChangedAt };
}

async function writeInTransaction(
  tx: Transaction<DB>,
  command: Command,
  identity: Identity,
  operation: MemberManagementOperation,
  context: LockedContext,
  deny: Deny,
): Promise<ApproveMemberResult | MemberTransitionResult> {
  const transition = statuses[operation],
    { targetMember, targetAccount, actorAccount } = context;
  let previousReason: string | null = null;
  if (operation === "approve") {
    if (command.studentNumber !== null) {
      const duplicates = await sql<{
        id: string;
      }>`SELECT id FROM class_members WHERE class_id=${identity.classId}
        AND status='approved' AND student_number=${command.studentNumber} LIMIT 1`.execute(tx);
      if (duplicates.rows.length > 0) deny(new StudentNumberAlreadyInUseException());
    }
  } else {
    const history = await sql<{
      reason: string | null;
    }>`SELECT reason FROM class_member_status_history
      WHERE member_id=${targetMember.id} AND to_status=${transition.before} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(
      tx,
    );
    previousReason = history.rows[0]?.reason ?? null;
  }
  const { occurredAt, statusChangedAt } = await callManagement(tx, command, identity, operation);
  const results =
    await sql<Member>`SELECT m.id,m.class_id,m.user_id,m.role,m.status,m.row_version,m.display_name_in_class,m.student_number
    FROM class_members m JOIN class_member_status_history h ON h.member_id=m.id AND h.class_id=m.class_id
    WHERE m.id=${targetMember.id} AND m.class_id=${identity.classId} AND m.user_id=${identity.targetUserId}
      AND m.role='student' AND m.status=${transition.after} AND m.status_changed_at=${occurredAt} AND m.updated_at=${occurredAt}
      AND h.from_status=${transition.before} AND h.to_status=${transition.after} AND h.actor_user_id=${command.actorUserId}
      AND h.actor_member_id=${identity.actorMemberId} AND h.actor_operator_id IS NULL AND h.actor_admin_account_id IS NULL
      AND h.reason <=> ${command.reason} AND h.created_at=${occurredAt} ORDER BY h.id DESC LIMIT 1`.execute(
      tx,
    );
  const changed = results.rows[0];
  if (
    !changed ||
    changed.id !== targetMember.id ||
    changed.class_id !== identity.classId ||
    changed.user_id !== identity.targetUserId ||
    changed.role !== "student" ||
    changed.status !== transition.after ||
    changed.row_version !== (BigInt(targetMember.row_version) + 1n).toString() ||
    changed.display_name_in_class !==
      (operation === "approve" ? command.displayNameInClass : targetMember.display_name_in_class) ||
    changed.student_number !==
      (operation === "approve"
        ? command.studentNumber
        : operation === "remove"
          ? null
          : targetMember.student_number)
  )
    throw memberManagementInternalError();
  if (operation === "approve") {
    await sql`DELETE FROM notice_reads WHERE member_id=${changed.id}`.execute(tx);
    await sql`DELETE FROM supply_checks WHERE member_id=${changed.id}`.execute(tx);
    await includeMemberInClassWideContent(tx, identity.classId, changed.id);
  }
  // P-016 excludes seating, grouping and duty tables from MariaDB. Election records
  // survive removal from a class, as they do on the PostgreSQL path.
  const before = {
    display_name_snapshot: targetMember.display_name_in_class ?? targetAccount.display_name,
    member_id: changed.id,
    reason: previousReason,
    role: "student",
    status: transition.before,
  };
  const after = {
    display_name_snapshot: changed.display_name_in_class ?? targetAccount.display_name,
    member_id: changed.id,
    reason: command.reason,
    role: "student",
    status: transition.after,
  };
  await sql`INSERT INTO audit_logs
    (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,after_json,before_json,
     class_id,reason,request_id,target_id,target_snapshot,target_type,created_at)
    VALUES (${transition.action},${actorAccount.display_name},${identity.actorMemberId},'teacher',${command.actorUserId},
      ${JSON.stringify(after)},${JSON.stringify(before)},${identity.classId},${command.reason},${command.requestId},${changed.id},NULL,'member',${occurredAt})`.execute(
    tx,
  );
  if (operation !== "approve")
    return {
      member: {
        id: changed.id,
        reason: command.reason,
        row_version: changed.row_version,
        status: statuses[operation].after,
        status_changed_at: statusChangedAt,
      },
    };
  const counts = await sql<{
    count: string;
  }>`SELECT COUNT(*) AS count FROM class_members m JOIN users a ON a.id=m.user_id
    WHERE m.class_id=${identity.classId} AND m.role='student' AND m.status='approved' AND a.is_active=TRUE AND a.deleted_at IS NULL`.execute(
    tx,
  );
  const count = counts.rows[0]?.count,
    expected = context.targetClass.expected_student_count;
  if (
    typeof count !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(count) ||
    !Number.isInteger(expected) ||
    expected < 1 ||
    expected > 60
  )
    throw memberManagementInternalError();
  return {
    member: {
      account_state: "active",
      display_name: after.display_name_snapshot,
      display_name_in_class: changed.display_name_in_class,
      id: changed.id,
      requested_at: null,
      row_version: changed.row_version,
      status: "approved",
      status_changed_at: statusChangedAt,
      student_number: changed.student_number,
    },
    warnings: BigInt(count) > BigInt(expected) ? ["EXPECTED_STUDENT_COUNT_EXCEEDED"] : [],
  };
}

async function manage(
  database: Kysely<DB>,
  input: ApproveMemberCommand | MemberTransitionCommand,
  operation: MemberManagementOperation,
) {
  const command = snapshot(input, operation),
    publicErrors = new WeakSet<object>();
  const deny: Deny = (error) => {
    publicErrors.add(error);
    throw error;
  };
  try {
    const identity = await preliminaryIdentity(database, command, deny);
    // Existing teacher management has no retry or idempotency boundary. An uncertain COMMIT must stay uncertain.
    return await database.transaction().execute(async (tx) => {
      const context = await lockedContext(tx, command, identity, operation, deny);
      return writeInTransaction(tx, command, identity, operation, context, deny);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    throw mapMariaDbMemberManagementError(error, operation);
  }
}

/** MariaDB caller candidates; HTTP authentication/CSRF and live DB selection are caller responsibilities. */
export function approveMemberMariaDb(
  database: Kysely<DB>,
  command: ApproveMemberCommand,
): Promise<ApproveMemberResult> {
  return manage(database, command, "approve") as Promise<ApproveMemberResult>;
}
export function rejectMemberMariaDb(
  database: Kysely<DB>,
  command: MemberTransitionCommand,
): Promise<MemberTransitionResult> {
  return manage(database, command, "reject") as Promise<MemberTransitionResult>;
}
export function removeMemberMariaDb(
  database: Kysely<DB>,
  command: MemberTransitionCommand,
): Promise<MemberTransitionResult> {
  return manage(database, command, "remove") as Promise<MemberTransitionResult>;
}
export function allowMemberRejoinMariaDb(
  database: Kysely<DB>,
  command: MemberTransitionCommand,
): Promise<MemberTransitionResult> {
  return manage(database, command, "rejoin") as Promise<MemberTransitionResult>;
}
