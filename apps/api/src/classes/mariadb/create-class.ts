import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  MariaDbIdempotencyService,
  normalizeIdempotencyKey,
  type DB,
  type JsonValue,
} from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { EmailNotVerifiedException, UnauthenticatedException } from "../../auth/auth.errors.js";
import { isAllowedPlainText } from "../../common/validation/text-validation.js";
import type { CreateClassCommand, CreateClassResult } from "../classes.types.js";
import { generateInviteCode } from "../invite-code.js";
import {
  createClassInternalError,
  invalidCreateClassInput,
  mapMariaDbCreateClassError,
} from "./create-class.errors.js";

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const integerIn = (value: number, minimum: number, maximum: number) =>
  Number.isInteger(value) && value >= minimum && value <= maximum;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function commandSnapshot(
  input: CreateClassCommand,
): CreateClassCommand & { idempotencyKey: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (
    !validId(input.actorUserId) ||
    !integerIn(input.academicYear, 2020, 2100) ||
    !integerIn(input.expectedStudentCount, 1, 60) ||
    !integerIn(input.grade, 1, 6) ||
    typeof input.eduOfficeCode !== "string" ||
    !/^[A-Z][0-9]{2}$/u.test(input.eduOfficeCode) ||
    typeof input.schoolCode !== "string" ||
    !/^[0-9]{7}$/u.test(input.schoolCode) ||
    !name ||
    [...name].length > 40 ||
    /[\uD800-\uDFFF]/u.test(name) ||
    !isAllowedPlainText(name) ||
    typeof input.requestId !== "string" ||
    !uuid.test(input.requestId)
  )
    throw invalidCreateClassInput();
  let idempotencyKey: string;
  try {
    idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  } catch (error) {
    throw mapMariaDbCreateClassError(error);
  }
  return { ...input, name, idempotencyKey };
}

type CreationOutput = {
  class_id: string;
  member_id: string;
  invite_id: string;
  invite_code: string;
  invite_created_at: string;
  invite_expires_at: string;
  occurred_at: string;
};
type CreatedClass = {
  academic_year: number;
  expected_student_count: number;
  grade: number;
  id: string;
  name: string;
  row_version: string;
  school_name: string;
  status: "active";
};

/** Public API keeps the PostgreSQL millisecond format; the original DATETIME6 stays in audit. */
export function classTimestampIso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value))
    throw createClassInternalError();
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    throw createClassInternalError();
  return value.slice(0, 10) + "T" + value.slice(11, 23) + "Z";
}

async function callCreation(
  transaction: Transaction<DB>,
  command: CreateClassCommand,
): Promise<CreationOutput> {
  const candidates = Array.from({ length: 5 }, () => generateInviteCode());
  // Leave native 1213 intact so the idempotency boundary can roll back and retry
  // the whole transaction. Domain/error mapping happens only after it finishes.
  await sql`CALL create_class_with_teacher_and_invite(${command.actorUserId}, ${command.name},
    ${command.academicYear}, ${command.grade}, ${command.eduOfficeCode}, ${command.schoolCode},
    ${command.expectedStudentCount}, ${candidates[0]}, ${candidates[1]}, ${candidates[2]}, ${candidates[3]}, ${candidates[4]},
    @create_class_id, @create_member_id, @create_invite_id, @create_invite_code,
    @create_invite_created_at, @create_invite_expires_at, @create_occurred_at)`.execute(
    transaction,
  );
  const result = await sql<CreationOutput>`SELECT CAST(@create_class_id AS CHAR) AS class_id,
    CAST(@create_member_id AS CHAR) AS member_id, CAST(@create_invite_id AS CHAR) AS invite_id,
    @create_invite_code AS invite_code, @create_invite_created_at AS invite_created_at,
    @create_invite_expires_at AS invite_expires_at, @create_occurred_at AS occurred_at`.execute(
    transaction,
  );
  const out = result.rows[0];
  if (
    !out ||
    !validId(out.class_id) ||
    !validId(out.member_id) ||
    !validId(out.invite_id) ||
    !candidates.includes(out.invite_code) ||
    !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u.test(out.invite_code)
  )
    throw createClassInternalError();
  classTimestampIso(out.occurred_at);
  classTimestampIso(out.invite_created_at);
  classTimestampIso(out.invite_expires_at);
  if (out.invite_created_at !== out.occurred_at || out.invite_expires_at <= out.invite_created_at)
    throw createClassInternalError();
  return out;
}

async function createdClass(
  transaction: Transaction<DB>,
  command: CreateClassCommand,
  out: CreationOutput,
): Promise<CreatedClass> {
  const result =
    await sql<CreatedClass>`SELECT c.id, c.academic_year, c.expected_student_count, c.grade,
    c.name, c.row_version, c.status, s.school_name FROM classes c JOIN schools s
    ON s.edu_office_code=c.edu_office_code AND s.school_code=c.school_code
    JOIN class_members m ON m.class_id=c.id AND m.id=${out.member_id}
    JOIN class_invite_codes i ON i.class_id=c.id AND i.id=${out.invite_id}
    WHERE c.id=${out.class_id} AND c.created_by_user_id=${command.actorUserId}
      AND c.edu_office_code=${command.eduOfficeCode} AND c.school_code=${command.schoolCode}
      AND m.user_id=${command.actorUserId} AND m.role='teacher' AND m.status='approved'
      AND i.created_by_member_id=m.id AND i.code=${out.invite_code} AND i.revoked_at IS NULL
      AND c.created_at=${out.occurred_at} AND m.created_at=${out.occurred_at}
      AND i.created_at=${out.invite_created_at} AND i.expires_at=${out.invite_expires_at}
      AND TIMESTAMPDIFF(MICROSECOND,i.created_at,i.expires_at)=1209600000000`.execute(transaction);
  const row = result.rows[0];
  if (
    !row ||
    row.id !== out.class_id ||
    row.academic_year !== command.academicYear ||
    row.grade !== command.grade ||
    row.expected_student_count !== command.expectedStudentCount ||
    row.name !== command.name ||
    row.status !== "active" ||
    row.row_version !== "1" ||
    typeof row.school_name !== "string"
  )
    throw createClassInternalError();
  return row;
}

async function writeAudits(
  transaction: Transaction<DB>,
  command: CreateClassCommand,
  out: CreationOutput,
  row: CreatedClass,
  displayName: string,
): Promise<void> {
  const records = [
    {
      action: "class.created",
      targetType: "class",
      targetId: out.class_id,
      after: {
        academic_year: row.academic_year,
        archived_at: null,
        class_id: row.id,
        expected_student_count: row.expected_student_count,
        grade: row.grade,
        name: row.name,
        status: row.status,
        suspended_reason: null,
      },
    },
    {
      action: "invite_code.created",
      targetType: "invite_code",
      targetId: out.invite_id,
      after: {
        class_id: row.id,
        expires_at: classTimestampIso(out.invite_expires_at),
        invite_code_id: out.invite_id,
        revoke_reason: null,
        revoked_at: null,
      },
    },
  ];
  for (const record of records)
    await sql`INSERT INTO audit_logs
    (action, actor_display_name_snapshot, actor_member_id, actor_role_snapshot, actor_user_id,
     after_json, before_json, class_id, reason, request_id, target_id, target_snapshot, target_type, created_at)
    VALUES (${record.action}, ${displayName}, ${out.member_id}, 'teacher', ${command.actorUserId},
      ${JSON.stringify(record.after)}, NULL, ${out.class_id}, NULL, ${command.requestId},
      ${record.targetId}, NULL, ${record.targetType}, ${out.occurred_at})`.execute(transaction);
}

/**
 * MariaDB application caller candidate. Requires the guarded, attested app DB and
 * the reviewed 0030 approval routines. HTTP session/CSRF guards stay at the caller;
 * this does not select the live DB or replace other ClassesService operations.
 */
export async function createClassMariaDb(
  database: Kysely<DB>,
  input: CreateClassCommand,
): Promise<CreateClassResult> {
  const command = commandSnapshot(input);
  // This set only contains exceptions emitted by this invocation, not arbitrary
  // HttpExceptions/driver objects which might contain private SQL or parameters.
  const publicErrors = new WeakSet<object>();
  try {
    const result = await new MariaDbIdempotencyService(database).execute(
      {
        actorUserId: command.actorUserId,
        idempotencyKey: command.idempotencyKey,
        requestHash: createIdempotencyRequestHash({
          body: {
            academic_year: command.academicYear,
            edu_office_code: command.eduOfficeCode,
            expected_student_count: command.expectedStudentCount,
            grade: command.grade,
            name: command.name,
            school_code: command.schoolCode,
          },
          effectiveClassId: null,
        }),
        routeKey: createIdempotencyRouteKey("/classes", null),
      },
      async (transaction) => {
        const accounts = await sql<{
          display_name: string;
          is_active: number;
          deleted_at: string | null;
          approved: number;
        }>`
        SELECT display_name, is_active, deleted_at, ((signup_role IS NULL OR signup_role <> 'teacher' OR signup_approved_at IS NOT NULL) AND (email_verified_at IS NOT NULL OR signup_approved_at IS NOT NULL)) AS approved
        FROM users WHERE id=${command.actorUserId} FOR UPDATE`.execute(transaction);
        const account = accounts.rows[0];
        const denial =
          !account || account.is_active !== 1 || account.deleted_at !== null
            ? new UnauthenticatedException()
            : account.approved !== 1
              ? new EmailNotVerifiedException()
              : undefined;
        if (denial) {
          publicErrors.add(denial);
          throw denial;
        }
        if (!account || typeof account.display_name !== "string") throw createClassInternalError();
        const out = await callCreation(transaction, command);
        const row = await createdClass(transaction, command, out);
        await writeAudits(transaction, command, out, row, account.display_name);
        const body: CreateClassResult = {
          class: row,
          invite_code: {
            code: out.invite_code,
            id: out.invite_id,
            created_at: classTimestampIso(out.invite_created_at),
            expires_at: classTimestampIso(out.invite_expires_at),
            status: "active",
          },
          next_action: "HOME",
          teacher_membership_id: out.member_id,
        };
        return { body: body as unknown as JsonValue, statusCode: 201 };
      },
    );
    return result.body as unknown as CreateClassResult;
  } catch (error) {
    if (typeof error === "object" && error !== null && publicErrors.has(error)) throw error;
    throw mapMariaDbCreateClassError(error);
  }
}
