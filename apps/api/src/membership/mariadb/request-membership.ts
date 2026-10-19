import { isIP } from "node:net";
import type { DB } from "@classhub/db";
import type { HttpException } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { createPrivacySafeSubject } from "../../auth/auth-crypto.js";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import type { AuthConfig } from "../../auth/auth.types.js";
import {
  RateLimitedException,
  RateLimitServiceUnavailableException,
} from "../../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RateLimitResult,
  RedisRateLimiter,
} from "../../common/rate-limit/redis-rate-limiter.js";
import {
  CurrentMembershipExistsException,
  EmailNotVerifiedException,
  InvalidInviteCodeException,
  MembershipRequestNotAllowedException,
} from "../membership.errors.js";
import type {
  CreateMembershipRequestCommand,
  CreateMembershipRequestResult,
} from "../membership.types.js";
import {
  invalidMembershipRequestInput,
  mapMariaDbMembershipRequestError,
  membershipRequestInternalError,
} from "./request-membership.errors.js";

export interface MembershipRequestDependencies {
  rateLimiter: Pick<RedisRateLimiter, "consume">;
  authConfig: Pick<AuthConfig, "emailHmacKey" | "emailHmacKeyVersion">;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const dateTime6 = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u;
type Deny = (error: HttpException) => never;
type Member = {
  id: string;
  role: string;
  status: string;
  row_version: string;
  display_name_in_class: string | null;
  created_at: string;
};

function commandSnapshot(input: CreateMembershipRequestCommand): CreateMembershipRequestCommand {
  const inviteCode =
    typeof input.inviteCode === "string" ? input.inviteCode.trim().toUpperCase() : "";
  if (
    !validId(input.userId) ||
    !/^[A-HJ-KM-NP-Z2-9]{8}$/u.test(inviteCode) ||
    typeof input.clientIp !== "string" ||
    isIP(input.clientIp) === 0 ||
    typeof input.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.requestId)
  )
    throw invalidMembershipRequestInput();
  return { ...input, inviteCode };
}

async function consume(
  dependencies: MembershipRequestDependencies,
  request: RateLimitRequest,
  deny: Deny,
): Promise<RateLimitResult> {
  let result: RateLimitResult;
  try {
    result = await dependencies.rateLimiter.consume(request);
    const { allowed, retryAfterSeconds } = result;
    if (
      typeof allowed !== "boolean" ||
      (!allowed && (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1))
    )
      throw new Error("Invalid rate limit result");
  } catch {
    // Redis errors may contain a connection URL in their cause. Emit a fresh public exception.
    return deny(new RateLimitServiceUnavailableException());
  }
  if (!result.allowed) deny(new RateLimitedException(result.retryAfterSeconds, result));
  return result;
}

async function lockEligibility(tx: Transaction<DB>, userId: string, deny: Deny): Promise<string> {
  const accounts = await sql<{
    display_name: string;
    is_active: number;
    deleted_at: string | null;
    approved: number;
  }>`
    SELECT display_name,is_active,deleted_at,((signup_role IS NULL OR signup_role <> 'teacher' OR signup_approved_at IS NOT NULL) AND (email_verified_at IS NOT NULL OR signup_approved_at IS NOT NULL)) AS approved
    FROM users WHERE id=${userId} FOR UPDATE`.execute(tx);
  const account = accounts.rows[0];
  if (!account || account.is_active !== 1 || account.deleted_at !== null)
    return deny(new UnauthenticatedException());
  if (account.approved !== 1) return deny(new EmailNotVerifiedException());
  // Match the routine's users -> current membership -> teacher profile lock order.
  // The public denial precedence still checks teacher eligibility before current membership.
  const current =
    await sql`SELECT id FROM class_members WHERE current_user_id=${userId} FOR UPDATE`.execute(tx);
  const teacher =
    await sql`SELECT user_id FROM teacher_profiles WHERE user_id=${userId} FOR UPDATE`.execute(tx);
  if (teacher.rows.length) return deny(new MembershipRequestNotAllowedException());
  if (current.rows.length) return deny(new CurrentMembershipExistsException());
  if (typeof account.display_name !== "string") throw membershipRequestInternalError();
  return account.display_name;
}

async function preliminaryClass(
  database: Kysely<DB>,
  command: CreateMembershipRequestCommand,
  deny: Deny,
): Promise<string> {
  return database.transaction().execute(async (tx) => {
    await lockEligibility(tx, command.userId, deny);
    const invites = await sql<{ class_id: string }>`SELECT i.class_id FROM class_invite_codes i
      JOIN classes c ON c.id=i.class_id WHERE i.code=${command.inviteCode}
      AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP(6) AND c.status='active'`.execute(tx);
    const invite = invites.rows[0];
    if (!invite) return deny(new InvalidInviteCodeException());
    if (!validId(invite.class_id)) throw membershipRequestInternalError();
    return invite.class_id;
  });
}

async function requestInTransaction(
  tx: Transaction<DB>,
  command: CreateMembershipRequestCommand,
  classId: string,
  deny: Deny,
): Promise<CreateMembershipRequestResult> {
  const displayName = await lockEligibility(tx, command.userId, deny);
  const classes = await sql<{
    status: string;
  }>`SELECT status FROM classes WHERE id=${classId} FOR UPDATE`.execute(tx);
  if (classes.rows[0]?.status !== "active") return deny(new InvalidInviteCodeException());
  const invites = await sql`SELECT id FROM class_invite_codes WHERE class_id=${classId}
    AND code=${command.inviteCode} AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE`.execute(
    tx,
  );
  if (!invites.rows.length) return deny(new InvalidInviteCodeException());
  const members =
    await sql<Member>`SELECT id,role,status,row_version,display_name_in_class,created_at
    FROM class_members WHERE class_id=${classId} AND user_id=${command.userId} FOR UPDATE`.execute(
      tx,
    );
  const existing = members.rows[0];
  let previousReason: string | null = null;
  if (existing) {
    if (!validId(existing.id) || !validId(existing.row_version))
      throw membershipRequestInternalError();
    const history = await sql<{
      reason: string | null;
    }>`SELECT reason FROM class_member_status_history
      WHERE member_id=${existing.id} AND to_status=${existing.status} ORDER BY created_at DESC,id DESC LIMIT 1`.execute(
      tx,
    );
    previousReason = history.rows[0]?.reason ?? null;
  }
  await sql`CALL request_class_membership(${classId},${command.userId},${command.inviteCode},@request_member_id,@request_occurred_at)`.execute(
    tx,
  );
  const outputs = await sql<{
    member_id: string;
    occurred_at: string;
  }>`SELECT CAST(@request_member_id AS CHAR) AS member_id,@request_occurred_at AS occurred_at`.execute(
    tx,
  );
  const out = outputs.rows[0];
  if (
    !out ||
    !validId(out.member_id) ||
    typeof out.occurred_at !== "string" ||
    !dateTime6.test(out.occurred_at)
  )
    throw membershipRequestInternalError();
  const results =
    await sql<Member>`SELECT m.id,m.role,m.status,m.row_version,m.display_name_in_class,m.created_at
    FROM class_members m JOIN class_member_status_history h ON h.member_id=m.id AND h.class_id=m.class_id
    WHERE m.id=${out.member_id} AND m.class_id=${classId} AND m.user_id=${command.userId}
      AND m.role='student' AND m.status='pending' AND m.status_changed_at=${out.occurred_at} AND m.updated_at=${out.occurred_at}
      AND h.from_status <=> ${existing?.status ?? null} AND h.to_status='pending' AND h.actor_user_id=${command.userId}
      AND h.actor_member_id IS NULL AND h.actor_operator_id IS NULL AND h.reason IS NULL AND h.created_at=${out.occurred_at}
    ORDER BY h.id DESC LIMIT 1`.execute(tx);
  const member = results.rows[0];
  if (
    !member ||
    member.id !== out.member_id ||
    member.role !== "student" ||
    member.status !== "pending" ||
    member.row_version !== (existing ? (BigInt(existing.row_version) + 1n).toString() : "1") ||
    member.display_name_in_class !== (existing?.display_name_in_class ?? null) ||
    member.created_at !== (existing?.created_at ?? out.occurred_at) ||
    (existing && member.id !== existing.id)
  )
    throw membershipRequestInternalError();
  const after = {
    display_name_snapshot: member.display_name_in_class ?? displayName,
    member_id: member.id,
    reason: null,
    role: "student",
    status: "pending",
  };
  const before = existing
    ? {
        display_name_snapshot: existing.display_name_in_class ?? displayName,
        member_id: existing.id,
        reason: previousReason,
        role: existing.role,
        status: existing.status,
      }
    : null;
  await sql`INSERT INTO audit_logs
    (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,after_json,before_json,
     class_id,reason,request_id,target_id,target_snapshot,target_type,created_at)
    VALUES ('member.requested',${displayName},NULL,'student',${command.userId},${JSON.stringify(after)},
      ${before === null ? null : JSON.stringify(before)},${classId},NULL,${command.requestId},${member.id},NULL,'member',${out.occurred_at})`.execute(
    tx,
  );
  return {
    class_id: classId,
    membership_id: member.id,
    next_action: "BOOTSTRAP",
    row_version: member.row_version,
    status: "pending",
  };
}

/** MariaDB caller candidate. HTTP authentication/CSRF and live DB selection remain at the caller. */
export async function requestMembershipMariaDb(
  database: Kysely<DB>,
  input: CreateMembershipRequestCommand,
  dependencies: MembershipRequestDependencies,
): Promise<CreateMembershipRequestResult> {
  const command = commandSnapshot(input);
  const publicErrors = new WeakSet<object>();
  const deny: Deny = (error) => {
    publicErrors.add(error);
    throw error;
  };
  try {
    await consume(
      dependencies,
      {
        key: `invite-code:ip:${createPrivacySafeSubject(dependencies.authConfig.emailHmacKey, dependencies.authConfig.emailHmacKeyVersion, "invite_code_ip", `${command.userId}:${command.clientIp}`)}`,
      },
      deny,
    );
    const accountLimit = await consume(
      dependencies,
      { key: `membership-request:user:${command.userId}` },
      deny,
    );
    let classId: string;
    try {
      classId = await preliminaryClass(database, command, deny);
    } catch (error) {
      if (error instanceof InvalidInviteCodeException && accountLimit.remaining === 0)
        deny(new RateLimitedException(accountLimit.retryAfterSeconds, accountLimit));
      throw error;
    }
    // Like the PostgreSQL createRequest path, this neither persists an idempotency
    // response nor retries a failed transaction or an indeterminate COMMIT.
    return await database
      .transaction()
      .execute((tx) => requestInTransaction(tx, command, classId, deny));
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    throw mapMariaDbMembershipRequestError(error);
  }
}
