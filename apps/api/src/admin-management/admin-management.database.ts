import { types } from "node:util";

import type { DB, JsonValue } from "@classhub/db";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { sql, type Transaction } from "kysely";

import { lockAdminAccountLiveness } from "../admin-accounts/admin-accounts.database.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
  mariaDbTimestamp,
} from "../common/database/mariadb-values.js";
import { adminError } from "./admin-error.js";

const invalid = () => new Error("Invalid MariaDB administrator management value.");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function identity(value: unknown): string {
  return typeof value === "string" && uuid.test(value) ? value : mariaDbId(value);
}
function json(value: unknown): JsonValue | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalid();
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw invalid();
  }
}
function digest(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw invalid();
  return value;
}

export const adminManagementMariaDbCodec = createMariaDbRowCodec({
  id: identity,
  class_id: mariaDbId,
  user_id: mariaDbId,
  row_version: mariaDbId,
  is_active: mariaDbBoolean,
  created_at: mariaDbDateTime,
  updated_at: mariaDbDateTime,
  status_changed_at: mariaDbDateTime,
  accepted_at: mariaDbDateTime,
  deleted_at: mariaDbNullable(mariaDbDateTime),
  withdrawn_at: mariaDbNullable(mariaDbDateTime),
  retention_expires_at: mariaDbNullable(mariaDbDateTime),
  effective_at: mariaDbNullable(mariaDbDateTime),
  published_at: mariaDbNullable(mariaDbDateTime),
  responded_at: mariaDbNullable(mariaDbDateTime),
  resolved_at: mariaDbNullable(mariaDbDateTime),
  before_json: json,
  after_json: json,
  value_json: json,
  content_sha256: digest,
});

export function isAdminManagementNativeError(error: unknown, errno: number, state: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    !types.isProxy(error) &&
    Object.getOwnPropertyDescriptor(error, "errno")?.value === errno &&
    Object.getOwnPropertyDescriptor(error, "sqlState")?.value === state
  );
}

export class AdminTermsInsertCollision extends Error {
  constructor(readonly insertError: unknown) {
    super("Administrator terms insert requires post-rollback identity verification.");
  }
}

/** Stable auto-increment administrator anchor, always before terms/state row locks. */
export async function lockAdminManagementMutation(transaction: Transaction<DB>): Promise<void> {
  // Existing app/operator ACLs forbid deleting this anchor or supplying/changing
  // account IDs. It also serializes empty system-state keys and concurrent draft
  // publications without granting a new lock table or locking random UUID minima.
  await lockAdminAccountLiveness(transaction, "mariadb");
}

interface MemberBefore {
  id: string;
  class_id: string;
  user_id: string;
  row_version: string;
  role: string;
  status: string;
  student_number: number | null;
  display_name_in_class: string | null;
}

export async function transitionMariaDbAdminMember(
  transaction: Transaction<DB>,
  before: MemberBefore,
  status: string,
  reason: string | null,
  adminId: string,
  occurredAt: Date,
) {
  const memberId = mariaDbId(before.id);
  const classId = mariaDbId(before.class_id);
  const userId = mariaDbId(before.user_id);
  const actorId = mariaDbId(adminId);
  const timestamp = mariaDbTimestamp(occurredAt);
  try {
    await sql`CALL set_admin_member_status(${classId},${userId},${memberId},${status},
      ${reason},${actorId},${timestamp},@admin_member_history_id)`.execute(transaction);
  } catch (error) {
    if (isAdminManagementNativeError(error, 32102, "45000"))
      throw adminError(NotFoundException, "MEMBER_NOT_FOUND");
    if (
      isAdminManagementNativeError(error, 32103, "45000") ||
      isAdminManagementNativeError(error, 30002, "45000")
    )
      throw adminError(BadRequestException, "ADMIN_MEMBER_CLASS_NOT_ACTIVE");
    if (
      isAdminManagementNativeError(error, 32104, "45000") ||
      isAdminManagementNativeError(error, 32107, "45000")
    )
      throw adminError(BadRequestException, "ADMIN_MEMBER_STATUS_TRANSITION_INVALID");
    if (isAdminManagementNativeError(error, 32105, "45000"))
      throw adminError(BadRequestException, "ADMIN_MEMBER_REASON_REQUIRED");
    if (isAdminManagementNativeError(error, 32106, "45000"))
      throw adminError(BadRequestException, "ADMIN_MEMBER_ACCOUNT_INACTIVE");
    throw error;
  }
  const { rows } = await sql<{
    id: string;
    status: string;
    row_version: string;
    status_changed_at: Date;
    student_number: number | null;
    display_name_in_class: string | null;
  }>`SELECT m.id,m.status,m.row_version,m.status_changed_at,m.student_number,m.display_name_in_class
    FROM class_members m JOIN class_member_status_history h
      ON h.id=@admin_member_history_id AND h.member_id=m.id AND h.class_id=m.class_id
    WHERE m.id=${memberId} AND m.class_id=${classId} AND m.user_id=${userId}
      AND m.role='student' AND m.status=${status}
      AND m.status_changed_at=${timestamp} AND m.updated_at=${timestamp}
      AND h.from_status=${before.status} AND h.to_status=${status}
      AND h.actor_admin_account_id=${actorId} AND h.actor_user_id IS NULL
      AND h.actor_member_id IS NULL AND h.actor_operator_id IS NULL AND h.reason <=> ${reason}`.execute(
    transaction,
  );
  const changed = rows[0];
  if (
    rows.length !== 1 ||
    changed === undefined ||
    changed.id !== memberId ||
    changed.status !== status ||
    changed.row_version !== (BigInt(mariaDbId(before.row_version)) + 1n).toString() ||
    changed.display_name_in_class !== before.display_name_in_class ||
    changed.student_number !== (status === "removed" ? null : before.student_number)
  )
    throw invalid();
  return {
    id: changed.id,
    status: changed.status,
    row_version: changed.row_version,
    status_changed_at: changed.status_changed_at,
  };
}
