import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  MariaDbIdempotencyService,
  normalizeIdempotencyKey,
  type DB,
  type JsonValue,
} from "@classhub/db";
import type { HttpException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import {
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
  CurrentInviteCodeNotFoundException,
} from "../classes.errors.js";
import type {
  CurrentInviteCodeResult,
  RotateInviteCodeCommand,
  RotateInviteCodeResult,
} from "../classes.types.js";
import { generateInviteCode, INVITE_LIFETIME_MS, inviteView } from "../invite-code.js";
import {
  invalidInviteCodeInput,
  inviteCodeInternalError,
  mapInviteCodeBoundaryError,
  mapInviteRotationSignal,
} from "./invite-code.errors.js";

type Deny = (error: HttpException) => never;
type Context = { class_id: string; member_id: string };
type Invite = {
  id: string;
  class_id: string;
  code: string;
  created_at: string;
  expires_at: string;
  created_by_member_id: string;
  revoked_at: string | null;
  revoked_by_member_id: string | null;
  revoked_by_operator_id: string | null;
  revoke_reason: string | null;
};
type RotationOutput = {
  previous_invite_id: string;
  invite_id: string;
  invite_code: string;
  invite_created_at: string;
  invite_expires_at: string;
  occurred_at: string;
};
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const validCode = (value: unknown): value is string =>
  typeof value === "string" && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u.test(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function timestampIso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)
  )
    throw inviteCodeInternalError();
  const iso = value.slice(0, 10) + "T" + value.slice(11, 23) + "Z",
    date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso)
    throw inviteCodeInternalError();
  return iso;
}
function projected(invite: Pick<Invite, "id" | "code" | "created_at" | "expires_at">, now: Date) {
  if (!validId(invite.id) || !validCode(invite.code) || !Number.isFinite(now.getTime()))
    throw inviteCodeInternalError();
  const created = timestampIso(invite.created_at),
    expires = timestampIso(invite.expires_at);
  if (invite.expires_at <= invite.created_at) throw inviteCodeInternalError();
  return inviteView(
    {
      id: invite.id,
      code: invite.code,
      created_at: new Date(created),
      expires_at: new Date(expires),
    },
    now,
  );
}
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
    throw mapInviteCodeBoundaryError(error);
  }
}
async function teacherContext(
  database: Kysely<DB>,
  actorUserId: string,
  deny: Deny,
): Promise<Context> {
  const result = await sql<
    Context & {
      class_status: string;
      role: string;
      profile_status: string | null;
      temporary_password_must_change: number | null;
    }
  >`
    SELECT c.id AS class_id,c.status AS class_status,m.id AS member_id,m.role,p.status AS profile_status,p.temporary_password_must_change
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
  if (!validId(current.class_id) || !validId(current.member_id)) throw inviteCodeInternalError();
  return { class_id: current.class_id, member_id: current.member_id };
}

/** Preserves PG's teacher context and expiration view; HTTP authentication remains at the caller. */
export async function getCurrentInviteCodeMariaDb(
  database: Kysely<DB>,
  actorUserId: string,
  now = new Date(),
): Promise<CurrentInviteCodeResult> {
  if (!validId(actorUserId)) throw invalidInviteCodeInput();
  return guarded(async (deny: Deny) => {
    const context = await teacherContext(database, actorUserId, deny);
    const result =
      await sql<Invite>`SELECT id,class_id,code,created_at,expires_at FROM class_invite_codes
      WHERE class_id=${context.class_id} AND revoked_at IS NULL LIMIT 1`.execute(database);
    const invite = result.rows[0];
    if (!invite) deny(new CurrentInviteCodeNotFoundException());
    if (invite.class_id !== context.class_id) throw inviteCodeInternalError();
    return { class_id: context.class_id, invite_code: projected(invite, now) };
  });
}

async function lockedContext(
  tx: Transaction<DB>,
  context: Context,
  actorUserId: string,
  deny: Deny,
): Promise<string> {
  const accounts = await sql<{
    id: string;
    display_name: string;
    is_active: number;
    deleted_at: string | null;
  }>`
    SELECT id,display_name,is_active,deleted_at FROM users WHERE id=${actorUserId} FOR UPDATE`.execute(
    tx,
  );
  const account = accounts.rows[0];
  if (!account || account.is_active !== 1 || account.deleted_at !== null)
    deny(new UnauthenticatedException());
  if (account.id !== actorUserId || typeof account.display_name !== "string")
    throw inviteCodeInternalError();
  const classes = await sql<{
    id: string;
    status: string;
  }>`SELECT id,status FROM classes WHERE id=${context.class_id} FOR UPDATE`.execute(tx);
  const target = classes.rows[0];
  if (!target) deny(new CurrentClassNotFoundException());
  if (target.status === "suspended") deny(new CurrentClassSuspendedException());
  if (target.status !== "active") deny(new CurrentClassNotFoundException());
  if (target.id !== context.class_id) throw inviteCodeInternalError();
  const members = await sql<{
    id: string;
    role: string;
    status: string;
  }>`SELECT id,role,status FROM class_members
    WHERE id=${context.member_id} AND class_id=${context.class_id} AND user_id=${actorUserId} FOR UPDATE`.execute(
    tx,
  );
  const actor = members.rows[0];
  if (
    !actor ||
    actor.id !== context.member_id ||
    actor.role !== "teacher" ||
    actor.status !== "approved"
  )
    deny(new ClassRoleInsufficientException());
  const profiles = await sql<{
    status: string;
    temporary_password_must_change: number;
  }>`SELECT status,temporary_password_must_change
    FROM teacher_profiles WHERE user_id=${actorUserId} FOR UPDATE`.execute(tx);
  if (
    profiles.rows[0]?.status !== "active" ||
    profiles.rows[0]?.temporary_password_must_change !== 0
  )
    deny(new ClassRoleInsufficientException());
  return account.display_name;
}

async function callRotation(
  tx: Transaction<DB>,
  context: Context,
  actorUserId: string,
  candidates: string[],
  deny: Deny,
): Promise<RotationOutput> {
  try {
    await sql`CALL rotate_class_invite(${context.class_id},${actorUserId},${context.member_id},
      ${candidates[0]},${candidates[1]},${candidates[2]},${candidates[3]},${candidates[4]},
      @rotate_previous_invite_id,@rotate_invite_id,@rotate_invite_code,@rotate_created_at,@rotate_expires_at,@rotate_occurred_at)`.execute(
      tx,
    );
  } catch (error) {
    const mapped = mapInviteRotationSignal(error);
    if (mapped) deny(mapped);
    throw error;
  }
  const result =
    await sql<RotationOutput>`SELECT CAST(@rotate_previous_invite_id AS CHAR) AS previous_invite_id,
    CAST(@rotate_invite_id AS CHAR) AS invite_id,@rotate_invite_code AS invite_code,
    @rotate_created_at AS invite_created_at,@rotate_expires_at AS invite_expires_at,@rotate_occurred_at AS occurred_at`.execute(
      tx,
    );
  const out = result.rows[0];
  if (
    !out ||
    !validId(out.previous_invite_id) ||
    !validId(out.invite_id) ||
    out.previous_invite_id === out.invite_id ||
    !validCode(out.invite_code) ||
    !candidates.includes(out.invite_code)
  )
    throw inviteCodeInternalError();
  const created = timestampIso(out.invite_created_at),
    expires = timestampIso(out.invite_expires_at);
  timestampIso(out.occurred_at);
  if (
    out.invite_created_at !== out.occurred_at ||
    out.invite_expires_at.slice(-6) !== out.invite_created_at.slice(-6) ||
    Date.parse(expires) - Date.parse(created) !== INVITE_LIFETIME_MS
  )
    throw inviteCodeInternalError();
  return out;
}
async function verifyStoredRotation(
  tx: Transaction<DB>,
  context: Context,
  previous: Invite,
  out: RotationOutput,
) {
  if (out.previous_invite_id !== previous.id) throw inviteCodeInternalError();
  const result =
    await sql<Invite>`SELECT id,class_id,code,created_at,expires_at,created_by_member_id,
    revoked_at,revoked_by_member_id,revoked_by_operator_id,revoke_reason FROM class_invite_codes
    WHERE class_id=${context.class_id} AND id IN (${previous.id},${out.invite_id}) ORDER BY id`.execute(
      tx,
    );
  const old = result.rows.find((row) => row.id === previous.id),
    created = result.rows.find((row) => row.id === out.invite_id);
  if (
    result.rows.length !== 2 ||
    !old ||
    !created ||
    old.class_id !== context.class_id ||
    old.code !== previous.code ||
    old.created_at !== previous.created_at ||
    old.expires_at !== previous.expires_at ||
    old.created_by_member_id !== previous.created_by_member_id ||
    old.revoked_at !== out.occurred_at ||
    old.revoked_by_member_id !== context.member_id ||
    old.revoked_by_operator_id !== null ||
    old.revoke_reason !== "재발급" ||
    created.class_id !== context.class_id ||
    created.code !== out.invite_code ||
    created.created_at !== out.invite_created_at ||
    created.expires_at !== out.invite_expires_at ||
    created.created_by_member_id !== context.member_id ||
    created.revoked_at !== null ||
    created.revoked_by_member_id !== null ||
    created.revoked_by_operator_id !== null ||
    created.revoke_reason !== null
  )
    throw inviteCodeInternalError();
}

/** Routine-only invite writes and caller-owned audit/idempotency share one guarded transaction. */
export async function rotateInviteCodeMariaDb(
  database: Kysely<DB>,
  input: RotateInviteCodeCommand,
  codeFactory = generateInviteCode,
): Promise<RotateInviteCodeResult> {
  const command = {
    actorUserId: input?.actorUserId,
    requestId: input?.requestId,
    idempotencyKey: Array.isArray(input?.idempotencyKey)
      ? [...input.idempotencyKey]
      : input?.idempotencyKey,
  };
  if (
    !validId(command.actorUserId) ||
    typeof command.requestId !== "string" ||
    !uuid.test(command.requestId)
  )
    throw invalidInviteCodeInput();
  return guarded(async (deny: Deny) => {
    // Source checks the current teacher context even before a stored success can replay.
    const context = await teacherContext(database, command.actorUserId, deny);
    const result = await new MariaDbIdempotencyService(database).execute(
      {
        actorUserId: command.actorUserId,
        idempotencyKey: normalizeIdempotencyKey(command.idempotencyKey),
        requestHash: createIdempotencyRequestHash({ body: {}, effectiveClassId: context.class_id }),
        routeKey: createIdempotencyRouteKey(
          "/classes/current/invite-code/rotate",
          context.class_id,
        ),
      },
      async (tx) => {
        const displayName = await lockedContext(tx, context, command.actorUserId, deny);
        const previousRows =
          await sql<Invite>`SELECT id,class_id,code,created_at,expires_at,created_by_member_id,
        revoked_at,revoked_by_member_id,revoked_by_operator_id,revoke_reason FROM class_invite_codes
        WHERE class_id=${context.class_id} AND revoked_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`.execute(
            tx,
          );
        const previous = previousRows.rows[0];
        if (!previous) deny(new CurrentInviteCodeNotFoundException());
        if (
          previous.class_id !== context.class_id ||
          previous.revoked_at !== null ||
          !validId(previous.created_by_member_id)
        )
          throw inviteCodeInternalError();
        projected(previous, new Date());
        const candidates = Array.from({ length: 5 }, () => codeFactory());
        if (!candidates.every(validCode)) throw inviteCodeInternalError();
        const out = await callRotation(tx, context, command.actorUserId, candidates, deny);
        await verifyStoredRotation(tx, context, previous, out);
        const records = [
          {
            action: "invite_code.revoked",
            targetId: previous.id,
            reason: "재발급",
            before: { revoke_reason: previous.revoke_reason, revoked_at: null },
            after: { revoke_reason: "재발급", revoked_at: timestampIso(out.occurred_at) },
          },
          {
            action: "invite_code.created",
            targetId: out.invite_id,
            reason: null,
            before: null,
            after: {
              class_id: context.class_id,
              expires_at: timestampIso(out.invite_expires_at),
              invite_code_id: out.invite_id,
              revoke_reason: null,
              revoked_at: null,
            },
          },
        ];
        for (const record of records)
          await sql`INSERT INTO audit_logs (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,
        after_json,before_json,class_id,reason,request_id,target_id,target_snapshot,target_type)
        VALUES (${record.action},${displayName},${context.member_id},'teacher',${command.actorUserId},${JSON.stringify(record.after)},
          ${record.before === null ? null : JSON.stringify(record.before)},${context.class_id},${record.reason},${command.requestId},${record.targetId},NULL,'invite_code')`.execute(
            tx,
          );
        const body: RotateInviteCodeResult = {
          class_id: context.class_id,
          invite_code: projected(
            {
              id: out.invite_id,
              code: out.invite_code,
              created_at: out.invite_created_at,
              expires_at: out.invite_expires_at,
            },
            new Date(timestampIso(out.occurred_at)),
          ),
        };
        return { body: body as unknown as JsonValue, statusCode: 200 };
      },
    );
    return result.body as unknown as RotateInviteCodeResult;
  });
}
