import type { DB } from "@classhub/db";
import type { HttpException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ResourceVersionChangedException } from "../../common/http/if-match.js";
import { isAllowedPlainText } from "../../common/validation/text-validation.js";
import {
  ClassArchiveConflictException,
  ClassNameConfirmationMismatchException,
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
} from "../classes.errors.js";
import type { ArchiveCurrentClassCommand, ArchiveCurrentClassResult } from "../classes.types.js";
import {
  archiveClassInternalError,
  invalidArchiveClassInput,
  mapMariaDbArchiveClassError,
} from "./archive-class.errors.js";

const archiveReason = "반 운영 종료";
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
type Deny = (error: HttpException) => never;
type Identity = { classId: string; memberId: string };
type Member = { id: string; user_id: string; role: string; status: string; row_version: string };
type OpenInvite = {
  id: string;
  class_id: string;
  revoke_reason: string | null;
  revoked_at: string | null;
};
type LockedClass = {
  id: string;
  name: string;
  status: string;
  row_version: string;
  archived_at: string | null;
};

function snapshot(input: ArchiveCurrentClassCommand): ArchiveCurrentClassCommand {
  const actorUserId = input?.actorUserId,
    requestId = input?.requestId,
    classNameConfirmation = input?.classNameConfirmation,
    expectedClassId = input?.expectedClassId,
    expectedRowVersion = input?.expectedRowVersion;
  if (
    !validId(actorUserId) ||
    !validId(expectedClassId) ||
    !validId(expectedRowVersion) ||
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId) ||
    typeof classNameConfirmation !== "string" ||
    [...classNameConfirmation].length < 1 ||
    [...classNameConfirmation].length > 40 ||
    /[\uD800-\uDFFF]/u.test(classNameConfirmation) ||
    !isAllowedPlainText(classNameConfirmation)
  )
    throw invalidArchiveClassInput();
  // Confirmation intentionally retains every space and the original letter case.
  return { actorUserId, requestId, classNameConfirmation, expectedClassId, expectedRowVersion };
}
function timestampIso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw archiveClassInternalError();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z",
    date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw archiveClassInternalError();
  return iso;
}

async function teacherIdentity(
  database: Kysely<DB>,
  actorUserId: string,
  deny: Deny,
): Promise<Identity> {
  const result = await sql<{
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
    WHERE m.user_id=${actorUserId} AND m.status='approved' LIMIT 1`.execute(database);
  const current = result.rows[0];
  if (!current) deny(new CurrentClassNotFoundException());
  if (current.class_status === "suspended") deny(new CurrentClassSuspendedException());
  if (current.class_status !== "active") deny(new CurrentClassNotFoundException());
  if (
    current.role !== "teacher" ||
    current.profile_status !== "active" ||
    current.temporary_password_must_change !== 0
  )
    deny(new ClassRoleInsufficientException());
  if (!validId(current.class_id) || !validId(current.member_id)) throw archiveClassInternalError();
  return { classId: current.class_id, memberId: current.member_id };
}

async function lockArchive(
  tx: Transaction<DB>,
  command: ArchiveCurrentClassCommand,
  identity: Identity,
  deny: Deny,
) {
  if (identity.classId !== command.expectedClassId) deny(new ClassArchiveConflictException());
  const accounts = await sql<{
    deleted_at: string | null;
    display_name: string;
    is_active: number;
  }>`
    SELECT deleted_at,display_name,is_active FROM users WHERE id=${command.actorUserId} FOR UPDATE`.execute(
    tx,
  );
  const account = accounts.rows[0];
  if (!account || account.is_active !== 1 || account.deleted_at !== null)
    deny(new UnauthenticatedException());
  const classes =
    await sql<LockedClass>`SELECT id,name,status,row_version,archived_at FROM classes WHERE id=${identity.classId} FOR UPDATE`.execute(
      tx,
    );
  const targetClass = classes.rows[0];
  if (!targetClass) deny(new CurrentClassNotFoundException());
  if (targetClass.status === "suspended") deny(new CurrentClassSuspendedException());
  if (targetClass.status !== "active") deny(new ClassArchiveConflictException());
  if (
    targetClass.id !== identity.classId ||
    !validId(targetClass.row_version) ||
    typeof targetClass.name !== "string" ||
    typeof account.display_name !== "string"
  )
    throw archiveClassInternalError();
  if (targetClass.row_version !== command.expectedRowVersion)
    deny(new ResourceVersionChangedException(targetClass.row_version));
  const current = await sql<Member>`SELECT id,user_id,role,status,row_version FROM class_members
    WHERE class_id=${identity.classId} AND status IN ('pending','approved') ORDER BY id FOR UPDATE`.execute(
    tx,
  );
  const actor = current.rows.find((member) => member.id === identity.memberId);
  if (
    !actor ||
    actor.user_id !== command.actorUserId ||
    actor.role !== "teacher" ||
    actor.status !== "approved"
  )
    deny(new ClassRoleInsufficientException());
  for (const member of current.rows) {
    if (
      !validId(member.id) ||
      !validId(member.user_id) ||
      !validId(member.row_version) ||
      !["student", "teacher"].includes(member.role) ||
      !["pending", "approved"].includes(member.status)
    )
      throw archiveClassInternalError();
  }
  const invites =
    await sql<OpenInvite>`SELECT id,class_id,revoke_reason,revoked_at FROM class_invite_codes
    WHERE class_id=${identity.classId} AND revoked_at IS NULL ORDER BY id FOR UPDATE`.execute(tx);
  const profiles = await sql<{ status: string; temporary_password_must_change: number }>`
    SELECT status,temporary_password_must_change FROM teacher_profiles WHERE user_id=${command.actorUserId} FOR UPDATE`.execute(
    tx,
  );
  if (
    profiles.rows[0]?.status !== "active" ||
    profiles.rows[0]?.temporary_password_must_change !== 0
  )
    deny(new ClassRoleInsufficientException());
  if (command.classNameConfirmation !== targetClass.name)
    deny(new ClassNameConfirmationMismatchException());
  for (const invite of invites.rows) {
    if (
      !validId(invite.id) ||
      invite.class_id !== identity.classId ||
      invite.revoked_at !== null ||
      (invite.revoke_reason !== null && typeof invite.revoke_reason !== "string")
    )
      throw archiveClassInternalError();
  }
  return { account, targetClass, members: current.rows, invites: invites.rows };
}
type LockedArchive = Awaited<ReturnType<typeof lockArchive>>;

async function verifyArchive(
  tx: Transaction<DB>,
  command: ArchiveCurrentClassCommand,
  identity: Identity,
  before: LockedArchive,
  occurredAt: string,
) {
  const classes = await sql<{
    id: string;
    name: string;
    row_version: string;
    current_count: string;
    open_invite_count: string;
  }>`
    SELECT c.id,c.name,c.row_version,
      (SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id AND m.status IN ('pending','approved')) AS current_count,
      (SELECT COUNT(*) FROM class_invite_codes i WHERE i.class_id=c.id AND i.revoked_at IS NULL) AS open_invite_count
    FROM classes c WHERE c.id=${identity.classId} AND c.status='archived' AND c.archived_at=${occurredAt}
      AND c.updated_at=${occurredAt} AND c.archived_by_user_id=${command.actorUserId} AND c.archived_by_operator_id IS NULL`.execute(
    tx,
  );
  const archived = classes.rows[0];
  if (
    !archived ||
    archived.id !== identity.classId ||
    archived.name !== before.targetClass.name ||
    archived.row_version !== (BigInt(before.targetClass.row_version) + 1n).toString() ||
    archived.current_count !== "0" ||
    archived.open_invite_count !== "0"
  )
    throw archiveClassInternalError();
  const members = await sql<Member & { student_number: number | null; history_count: string }>`
    SELECT m.id,m.user_id,m.role,m.status,m.row_version,m.student_number,
      (SELECT COUNT(*) FROM class_member_status_history h WHERE h.member_id=m.id AND h.class_id=m.class_id
        AND h.from_status=IF(m.status='canceled','pending','approved') AND h.to_status=m.status
        AND h.actor_user_id=${command.actorUserId} AND h.actor_member_id=${identity.memberId}
        AND h.actor_operator_id IS NULL AND h.actor_admin_account_id IS NULL
        AND h.reason=${archiveReason} AND h.created_at=${occurredAt}) AS history_count
    FROM class_members m WHERE m.class_id=${identity.classId} AND m.id IN (${sql.join(before.members.map((member) => member.id))})
      AND m.status_changed_at=${occurredAt} AND m.updated_at=${occurredAt} ORDER BY m.id`.execute(
    tx,
  );
  if (members.rows.length !== before.members.length) throw archiveClassInternalError();
  for (const old of before.members) {
    const matches = members.rows.filter((member) => member.id === old.id),
      member = matches[0];
    if (
      matches.length !== 1 ||
      !member ||
      member.user_id !== old.user_id ||
      member.role !== old.role ||
      member.status !== (old.status === "pending" ? "canceled" : "archived") ||
      member.row_version !== (BigInt(old.row_version) + 1n).toString() ||
      member.student_number !== null ||
      member.history_count !== "1"
    )
      throw archiveClassInternalError();
  }
  if (before.invites.length) {
    const invites = await sql<{
      id: string;
    }>`SELECT id FROM class_invite_codes WHERE class_id=${identity.classId}
      AND id IN (${sql.join(before.invites.map((invite) => invite.id))}) AND revoked_at=${occurredAt}
      AND revoked_by_member_id=${identity.memberId} AND revoked_by_operator_id IS NULL AND revoke_reason=${archiveReason}`.execute(
      tx,
    );
    if (
      invites.rows.length !== before.invites.length ||
      before.invites.some(
        (old) => invites.rows.filter((invite) => invite.id === old.id).length !== 1,
      )
    )
      throw archiveClassInternalError();
  }
  return archived;
}

/** Candidate requires the archive routine to preserve the PG reason '반 운영 종료'. */
export async function archiveCurrentClassMariaDb(
  database: Kysely<DB>,
  input: ArchiveCurrentClassCommand,
): Promise<ArchiveCurrentClassResult> {
  const command = snapshot(input),
    publicErrors = new WeakSet<object>();
  const deny: Deny = (error) => {
    publicErrors.add(error);
    throw error;
  };
  try {
    const identity = await teacherIdentity(database, command.actorUserId, deny);
    // The existing PG caller has no retry/idempotency wrapper, including an uncertain COMMIT.
    return await database.transaction().execute(async (tx) => {
      const before = await lockArchive(tx, command, identity, deny);
      await sql`CALL archive_class(${identity.classId},${command.actorUserId},${identity.memberId},${command.classNameConfirmation},@archive_class_occurred_at)`.execute(
        tx,
      );
      const out = await sql<{
        occurred_at: string;
      }>`SELECT @archive_class_occurred_at AS occurred_at`.execute(tx);
      const occurredAt = out.rows[0]?.occurred_at,
        archivedAt = timestampIso(occurredAt);
      const archived = await verifyArchive(tx, command, identity, before, occurredAt!);
      const classBefore = {
        archived_at:
          before.targetClass.archived_at === null
            ? null
            : timestampIso(before.targetClass.archived_at),
        status: before.targetClass.status,
      };
      await sql`INSERT INTO audit_logs
        (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,after_json,before_json,
         class_id,created_at,reason,request_id,target_id,target_snapshot,target_type)
        VALUES ('class.archived',${before.account.display_name},${identity.memberId},'teacher',${command.actorUserId},
          ${JSON.stringify({ archived_at: archivedAt, status: "archived" })},${JSON.stringify(classBefore)},
          ${identity.classId},${occurredAt},NULL,${command.requestId},${identity.classId},NULL,'class')`.execute(
        tx,
      );
      for (const invite of before.invites) {
        await sql`INSERT INTO audit_logs
          (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,after_json,before_json,
           class_id,created_at,reason,request_id,target_id,target_snapshot,target_type)
          VALUES ('invite_code.revoked',${before.account.display_name},${identity.memberId},'teacher',${command.actorUserId},
            ${JSON.stringify({ revoke_reason: archiveReason, revoked_at: archivedAt })},${JSON.stringify({ revoke_reason: invite.revoke_reason, revoked_at: null })},
            ${identity.classId},${occurredAt},${archiveReason},${command.requestId},${invite.id},NULL,'invite_code')`.execute(
          tx,
        );
      }
      return {
        archived_at: archivedAt,
        class_id: archived.id,
        next_action: "CREATE_CLASS",
        row_version: archived.row_version,
      };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    throw mapMariaDbArchiveClassError(error);
  }
}
