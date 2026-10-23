import type { DB } from "@classhub/db";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import { ResourceVersionChangedException } from "../../common/http/if-match.js";
import { maskEmail } from "../../common/privacy/mask-email.js";
import { isAllowedPlainText } from "../../common/validation/text-validation.js";
import {
  ClassSuspendedException,
  MemberNotFoundException,
  MemberStatusChangedException,
  RoleInsufficientException,
  StudentNumberAlreadyInUseException,
} from "../members.errors.js";
import type {
  GetMemberProfileResult,
  ListMembersResult,
  ManageableMemberStatus,
  MemberListItem,
  UpdateMemberProfileCommand,
  UpdateMemberProfileResult,
} from "../members.types.js";

type Deny = (error: HttpException) => never;
type Account = { id: string; display_name: string; is_active: number; deleted_at: string | null };
type Member = {
  id: string;
  class_id: string;
  user_id: string;
  role: string;
  status: string;
  row_version: string;
  display_name_in_class: string | null;
  student_number: number | null;
  status_changed_at: string;
  updated_at: string;
};
type MemberRow = Pick<
  Member,
  "id" | "row_version" | "status" | "display_name_in_class" | "student_number" | "status_changed_at"
> & {
  account_display_name: string;
  is_active: number;
  deleted_at: string | null;
  email_normalized?: string;
};
const statusOrder: ManageableMemberStatus[] = ["pending", "approved", "removed", "rejoin_allowed"];
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const ordered = (...ids: string[]) =>
  [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
const active = (account: { is_active: number; deleted_at: string | null }) =>
  account.is_active === 1 && account.deleted_at === null;
const internal = () =>
  new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "구성원 정보를 확인할 수 없습니다. 현재 구성원 상태를 다시 확인해 주세요.",
  });
const invalid = () =>
  new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "구성원 요청 정보를 확인해 주세요.",
  });

async function guarded<T>(operation: (deny: Deny) => Promise<T>): Promise<T> {
  const publicErrors = new WeakSet<object>();
  const deny: Deny = (error) => {
    publicErrors.add(error);
    throw error;
  };
  try {
    return await operation(deny);
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    // Direct column writes have no routine SIGNAL contract. Do not parse native messages or retry.
    throw internal();
  }
}

function timestampIso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw internal();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z",
    date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) throw internal();
  return iso;
}

function item(row: MemberRow): MemberListItem {
  if (
    !validId(row.id) ||
    !validId(row.row_version) ||
    !statusOrder.includes(row.status as ManageableMemberStatus)
  )
    throw internal();
  const time = timestampIso(row.status_changed_at);
  const result: MemberListItem = {
    account_state: active(row) ? "active" : "inactive",
    display_name: row.display_name_in_class ?? row.account_display_name,
    display_name_in_class: row.display_name_in_class,
    id: row.id,
    requested_at: row.status === "pending" ? time : null,
    row_version: row.row_version,
    status: row.status as ManageableMemberStatus,
    status_changed_at: time,
    student_number: row.student_number,
  };
  if (row.status === "pending") {
    if (typeof row.email_normalized !== "string") throw internal();
    result.email_masked = maskEmail(row.email_normalized);
  }
  return result;
}

function compareMembers(left: MemberListItem, right: MemberListItem): number {
  if (left.status !== right.status)
    return statusOrder.indexOf(left.status) - statusOrder.indexOf(right.status);
  const ids = BigInt(left.id) < BigInt(right.id) ? -1 : left.id === right.id ? 0 : 1;
  if (left.status === "pending")
    return left.status_changed_at.localeCompare(right.status_changed_at) || ids;
  if (left.status === "approved") {
    if (left.student_number === null && right.student_number !== null) return 1;
    if (left.student_number !== null && right.student_number === null) return -1;
    if (left.student_number !== right.student_number)
      return (left.student_number ?? 0) - (right.student_number ?? 0);
    return left.display_name.localeCompare(right.display_name, "ko") || ids;
  }
  return right.status_changed_at.localeCompare(left.status_changed_at) || ids;
}

async function teacherContext(database: Kysely<DB>, actorUserId: string, deny: Deny) {
  const rows = await sql<{
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
    WHERE m.user_id=${actorUserId} AND m.status IN ('pending','approved') LIMIT 1`.execute(
    database,
  );
  const context = rows.rows[0];
  if (!context) deny(new MemberNotFoundException());
  if (context.class_status === "suspended") deny(new ClassSuspendedException());
  if (
    context.class_status !== "active" ||
    context.role !== "teacher" ||
    context.profile_status !== "active" ||
    context.temporary_password_must_change !== 0
  )
    deny(new RoleInsufficientException());
  if (!validId(context.class_id) || !validId(context.member_id)) throw internal();
  return context;
}

/** Read candidates preserve PG access/projection. HTTP session authentication remains at the caller. */
export async function listMembersMariaDb(
  database: Kysely<DB>,
  actorUserId: string,
  statusFilter?: string,
): Promise<ListMembersResult> {
  if (
    !validId(actorUserId) ||
    (statusFilter !== undefined &&
      (typeof statusFilter !== "string" ||
        !/^(pending|approved|removed|rejoin_allowed)(,(pending|approved|removed|rejoin_allowed))*$/u.test(
          statusFilter,
        )))
  )
    throw invalid();
  const statuses =
    statusFilter === undefined ? ["pending", "approved"] : [...new Set(statusFilter.split(","))];
  return guarded(async (deny) => {
    const context = await teacherContext(database, actorUserId, deny);
    const result =
      await sql<MemberRow>`SELECT a.deleted_at,a.display_name AS account_display_name,a.email_normalized,a.is_active,
      m.display_name_in_class,m.id,m.row_version,m.status,m.status_changed_at,m.student_number
      FROM class_members m JOIN users a ON a.id=m.user_id
      WHERE m.class_id=${context.class_id} AND m.role='student' AND m.status IN (${sql.join(statuses)})`.execute(
        database,
      );
    return { members: result.rows.map(item).sort(compareMembers) };
  });
}

export async function getMemberProfileMariaDb(
  database: Kysely<DB>,
  actorUserId: string,
  memberId: string,
): Promise<GetMemberProfileResult> {
  if (!validId(memberId)) throw new MemberNotFoundException();
  if (!validId(actorUserId)) throw invalid();
  return guarded(async (deny) => {
    const context = await teacherContext(database, actorUserId, deny);
    const result =
      await sql<MemberRow>`SELECT a.deleted_at,a.display_name AS account_display_name,a.is_active,
      m.display_name_in_class,m.id,m.row_version,m.status,m.status_changed_at,m.student_number
      FROM class_members m JOIN users a ON a.id=m.user_id
      WHERE m.id=${memberId} AND m.class_id=${context.class_id} AND m.role='student' AND m.status='approved'`.execute(
        database,
      );
    const row = result.rows[0];
    if (!row) return deny(new MemberNotFoundException());
    if (row.id !== memberId || row.status !== "approved") throw internal();
    return { member: item(row) };
  });
}

function snapshot(input: UpdateMemberProfileCommand): UpdateMemberProfileCommand {
  const command = {
    actorUserId: input?.actorUserId,
    memberId: input?.memberId,
    requestId: input?.requestId,
    expectedRowVersion: input?.expectedRowVersion,
    displayNameInClass: input?.displayNameInClass,
    studentNumber: input?.studentNumber,
  };
  if (!validId(command.memberId)) throw new MemberNotFoundException();
  // If-Match syntax is parsed by the HTTP controller. Keep arbitrary positive version strings comparable before SQL.
  if (
    !validId(command.actorUserId) ||
    typeof command.expectedRowVersion !== "string" ||
    !/^[1-9][0-9]*$/u.test(command.expectedRowVersion) ||
    typeof command.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(command.requestId)
  )
    throw invalid();
  if (typeof command.displayNameInClass === "string")
    command.displayNameInClass = command.displayNameInClass.trim();
  const name = command.displayNameInClass,
    number = command.studentNumber;
  if (
    name !== undefined &&
    name !== null &&
    (typeof name !== "string" ||
      [...name].length < 2 ||
      [...name].length > 20 ||
      /[\uD800-\uDFFF]/u.test(name) ||
      !isAllowedPlainText(name))
  )
    throw invalid();
  if (
    number !== undefined &&
    number !== null &&
    (!Number.isInteger(number) || number < 1 || number > 99)
  )
    throw invalid();
  return {
    actorUserId: command.actorUserId,
    memberId: command.memberId,
    requestId: command.requestId,
    expectedRowVersion: command.expectedRowVersion,
    ...(name !== undefined ? { displayNameInClass: name } : {}),
    ...(number !== undefined ? { studentNumber: number } : {}),
  };
}

async function lockedProfile(
  tx: Transaction<DB>,
  command: UpdateMemberProfileCommand,
  context: { class_id: string; member_id: string },
  target: { id: string; user_id: string },
  deny: Deny,
) {
  const accounts =
    await sql<Account>`SELECT id,deleted_at,display_name,is_active FROM users FORCE INDEX (PRIMARY)
    WHERE id IN (${sql.join(ordered(command.actorUserId, target.user_id))}) ORDER BY id FOR UPDATE`.execute(
      tx,
    );
  const actorAccount = accounts.rows.find((row) => row.id === command.actorUserId),
    targetAccount = accounts.rows.find((row) => row.id === target.user_id);
  if (!actorAccount || !active(actorAccount)) deny(new UnauthenticatedException());
  if (!targetAccount) deny(new MemberNotFoundException());
  const classes = await sql<{
    id: string;
    status: string;
  }>`SELECT id,status FROM classes WHERE id=${context.class_id} FOR UPDATE`.execute(tx);
  const targetClass = classes.rows[0];
  if (!targetClass || targetClass.status === "archived") deny(new MemberNotFoundException());
  if (targetClass.status === "suspended") deny(new ClassSuspendedException());
  if (targetClass.id !== context.class_id || targetClass.status !== "active") throw internal();
  const members =
    await sql<Member>`SELECT class_id,display_name_in_class,id,role,row_version,status,status_changed_at,student_number,updated_at,user_id
    FROM class_members WHERE id IN (${sql.join(ordered(context.member_id, target.id))}) ORDER BY id FOR UPDATE`.execute(
      tx,
    );
  const actor = members.rows.find((row) => row.id === context.member_id),
    member = members.rows.find((row) => row.id === target.id);
  if (
    !actor ||
    actor.class_id !== context.class_id ||
    actor.user_id !== command.actorUserId ||
    actor.role !== "teacher" ||
    actor.status !== "approved"
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
    !member ||
    member.class_id !== context.class_id ||
    member.user_id !== target.user_id ||
    member.role !== "student"
  )
    deny(new MemberNotFoundException());
  if (!validId(member.row_version)) throw internal();
  if (member.row_version !== command.expectedRowVersion)
    deny(new ResourceVersionChangedException(member.row_version));
  if (member.status !== "approved" || targetAccount.deleted_at !== null)
    deny(new MemberStatusChangedException());
  return { actorAccount, targetAccount, member };
}

/** Column-scoped UPDATE candidate; retains PG's no-op, optimistic version and audit contracts. */
export async function updateMemberProfileMariaDb(
  database: Kysely<DB>,
  input: UpdateMemberProfileCommand,
): Promise<UpdateMemberProfileResult> {
  const command = snapshot(input);
  return guarded(async (deny) => {
    const context = await teacherContext(database, command.actorUserId, deny);
    const targets = await sql<{
      class_id: string;
      id: string;
      user_id: string;
    }>`SELECT class_id,id,user_id FROM class_members WHERE id=${command.memberId}`.execute(
      database,
    );
    const target = targets.rows[0];
    if (!target || target.class_id !== context.class_id) return deny(new MemberNotFoundException());
    if (target.id !== command.memberId || !validId(target.user_id)) throw internal();
    return database.transaction().execute(async (tx) => {
      // MariaDB has no PG transaction_timestamp(). Capture one DB UTC value immediately after BEGIN for this write/audit pair.
      const clock = await sql<{
        occurred_at: string;
      }>`SELECT UTC_TIMESTAMP(6) AS occurred_at`.execute(tx);
      const occurredAt = clock.rows[0]?.occurred_at;
      timestampIso(occurredAt);
      const { actorAccount, targetAccount, member } = await lockedProfile(
        tx,
        command,
        context,
        target,
        deny,
      );
      const name =
        command.displayNameInClass === undefined
          ? member.display_name_in_class
          : command.displayNameInClass;
      const number =
        command.studentNumber === undefined ? member.student_number : command.studentNumber;
      const nameChanged = name !== member.display_name_in_class,
        numberChanged = number !== member.student_number;
      const project = (row: Member) =>
        item({
          ...row,
          account_display_name: targetAccount.display_name,
          is_active: targetAccount.is_active,
          deleted_at: targetAccount.deleted_at,
        });
      if (!nameChanged && !numberChanged)
        return { member: project(member), profile_updated: false };
      if (numberChanged && number !== null) {
        const duplicates = await sql<{
          id: string;
        }>`SELECT id FROM class_members WHERE class_id=${context.class_id} AND id<>${member.id}
          AND status='approved' AND student_number=${number} LIMIT 1`.execute(tx);
        if (duplicates.rows.length) deny(new StudentNumberAlreadyInUseException());
      }
      const result = await sql`UPDATE class_members SET ${sql.join([
        ...(nameChanged ? [sql`display_name_in_class=${name}`] : []),
        ...(numberChanged ? [sql`student_number=${number}`] : []),
        sql`row_version=row_version+1`,
        sql`updated_at=${occurredAt}`,
      ])} WHERE id=${member.id} AND class_id=${context.class_id} AND user_id=${target.user_id}
        AND row_version=${command.expectedRowVersion} AND role='student' AND status='approved'`.execute(
        tx,
      );
      if (result.numAffectedRows !== 1n)
        deny(new ResourceVersionChangedException(member.row_version));
      const updatedRows =
        await sql<Member>`SELECT class_id,display_name_in_class,id,role,row_version,status,status_changed_at,student_number,updated_at,user_id
        FROM class_members WHERE id=${member.id} AND class_id=${context.class_id} AND user_id=${target.user_id}`.execute(
          tx,
        );
      const updated = updatedRows.rows[0];
      if (
        !updated ||
        updated.id !== member.id ||
        updated.class_id !== context.class_id ||
        updated.user_id !== target.user_id ||
        updated.role !== "student" ||
        updated.status !== "approved" ||
        updated.row_version !== (BigInt(member.row_version) + 1n).toString() ||
        updated.display_name_in_class !== name ||
        updated.student_number !== number ||
        updated.status_changed_at !== member.status_changed_at ||
        updated.updated_at !== occurredAt
      )
        throw internal();
      const before = nameChanged
        ? { display_name_snapshot: member.display_name_in_class ?? targetAccount.display_name }
        : {};
      const after = nameChanged
        ? { display_name_snapshot: updated.display_name_in_class ?? targetAccount.display_name }
        : {};
      await sql`INSERT INTO audit_logs (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,
        after_json,before_json,class_id,reason,request_id,target_id,target_snapshot,target_type,created_at)
        VALUES ('member.profile_updated',${actorAccount.display_name},${context.member_id},'teacher',${command.actorUserId},
          ${JSON.stringify(after)},${JSON.stringify(before)},${context.class_id},NULL,${command.requestId},${member.id},NULL,'member',${occurredAt})`.execute(
        tx,
      );
      return { member: project(updated), profile_updated: true };
    });
  });
}
