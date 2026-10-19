import type { DB } from "@classhub/db";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import { ResourceVersionChangedException } from "../../common/http/if-match.js";
import { isAllowedPlainText } from "../../common/validation/text-validation.js";
import { schoolDetailsView, type SchoolDetailsRow } from "../../schools/school-details.view.js";
import {
  ClassAlreadyExistsException,
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
} from "../classes.errors.js";
import type {
  CurrentClassResult,
  UpdateCurrentClassCommand,
  UpdateCurrentClassResult,
} from "../classes.types.js";

type Deny = (error: HttpException) => never;
type ClassRow = {
  academic_year: number;
  expected_student_count: number;
  grade: number;
  id: string;
  name: string;
  row_version: string;
  status: string;
  edu_office_code: string;
  school_code: string;
  updated_at: string;
};
type School = SchoolDetailsRow & { school_name: string };
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,18}$/u.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const internal = () =>
  new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "반 정보를 확인할 수 없습니다. 현재 반 정보를 다시 확인해 주세요.",
  });
const invalid = () =>
  new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "반 정보 변경 요청을 확인해 주세요.",
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
    // Direct UPDATE has no routine SIGNAL contract. Native diagnostics cannot identify a constraint safely.
    throw internal();
  }
}

async function studentCount(database: Kysely<DB>, classId: string): Promise<number> {
  const result = await sql<{
    count: string;
  }>`SELECT COUNT(*) AS count FROM class_members m JOIN users a ON a.id=m.user_id
    WHERE m.class_id=${classId} AND m.role='student' AND m.status='approved' AND a.is_active=1 AND a.deleted_at IS NULL`.execute(
    database,
  );
  const count = result.rows[0]?.count;
  if (
    typeof count !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(count) ||
    BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw internal();
  return Number(count);
}

function view(
  current: Pick<
    ClassRow,
    "academic_year" | "expected_student_count" | "grade" | "id" | "name" | "row_version"
  >,
  school: School,
  role: "student" | "teacher",
  teacherName: string,
  count: number,
): CurrentClassResult {
  if (!validId(current.id) || !validId(current.row_version)) throw internal();
  return {
    academic_year: current.academic_year,
    active_student_count: count,
    ...(role === "teacher" ? { expected_student_count: current.expected_student_count } : {}),
    grade: current.grade,
    id: current.id,
    name: current.name,
    role,
    row_version: current.row_version,
    ...schoolDetailsView(school),
    school_name: school.school_name,
    status: "active",
    teacher_display_name: teacherName,
  };
}

/** HTTP session authentication stays at the caller, matching the PG teacher/student read path. */
export async function getCurrentClassMariaDb(
  database: Kysely<DB>,
  actorUserId: string,
): Promise<CurrentClassResult> {
  if (!validId(actorUserId)) throw invalid();
  return guarded(async (deny) => {
    const result = await sql<ClassRow & School & { role: string; teacher_display_name: string }>`
      SELECT c.academic_year,c.expected_student_count,c.grade,c.id,c.name,c.row_version,c.status,m.role,
        s.homepage_url,s.phone_number,s.road_address,s.road_address_detail,s.school_name,a.display_name AS teacher_display_name
      FROM class_members m JOIN classes c ON c.id=m.class_id
      JOIN schools s ON s.edu_office_code=c.edu_office_code AND s.school_code=c.school_code
      JOIN class_members t ON t.class_id=c.id AND t.role='teacher' AND t.status='approved'
      JOIN users a ON a.id=t.user_id WHERE m.user_id=${actorUserId} AND m.status='approved' LIMIT 1`.execute(
      database,
    );
    const current = result.rows[0];
    if (!current) return deny(new CurrentClassNotFoundException());
    if (current.status === "suspended") return deny(new CurrentClassSuspendedException());
    if (current.status !== "active" || (current.role !== "student" && current.role !== "teacher"))
      return deny(new CurrentClassNotFoundException());
    return view(
      current,
      current,
      current.role,
      current.teacher_display_name,
      await studentCount(database, current.id),
    );
  });
}

function snapshot(input: UpdateCurrentClassCommand): UpdateCurrentClassCommand {
  const command = {
    actorUserId: input?.actorUserId,
    expectedRowVersion: input?.expectedRowVersion,
    expectedStudentCount: input?.expectedStudentCount,
    name: input?.name,
    requestId: input?.requestId,
  };
  if (
    !validId(command.actorUserId) ||
    typeof command.expectedRowVersion !== "string" ||
    !/^[1-9][0-9]*$/u.test(command.expectedRowVersion) ||
    typeof command.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(command.requestId)
  )
    throw invalid();
  if (typeof command.name === "string") command.name = command.name.trim();
  if (
    command.name !== undefined &&
    (typeof command.name !== "string" ||
      [...command.name].length < 1 ||
      [...command.name].length > 40 ||
      /[\uD800-\uDFFF]/u.test(command.name) ||
      !isAllowedPlainText(command.name))
  )
    throw invalid();
  if (
    command.expectedStudentCount !== undefined &&
    (!Number.isInteger(command.expectedStudentCount) ||
      command.expectedStudentCount < 1 ||
      command.expectedStudentCount > 60)
  )
    throw invalid();
  return command;
}

async function teacherContext(database: Kysely<DB>, actorUserId: string, deny: Deny) {
  const result = await sql<{
    class_id: string;
    class_status: string;
    member_id: string;
    role: string;
    profile_status: string | null;
    temporary_password_must_change: number | null;
  }>`
    SELECT c.id AS class_id,c.status AS class_status,m.id AS member_id,m.role,p.status AS profile_status,p.temporary_password_must_change
    FROM class_members m JOIN classes c ON c.id=m.class_id LEFT JOIN teacher_profiles p ON p.user_id=m.user_id
    WHERE m.user_id=${actorUserId} AND m.status='approved' LIMIT 1`.execute(database);
  const context = result.rows[0];
  if (!context) deny(new CurrentClassNotFoundException());
  if (context.class_status === "suspended") deny(new CurrentClassSuspendedException());
  if (context.class_status !== "active") deny(new CurrentClassNotFoundException());
  if (
    context.role !== "teacher" ||
    context.profile_status !== "active" ||
    context.temporary_password_must_change !== 0
  )
    deny(new ClassRoleInsufficientException());
  if (!validId(context.class_id) || !validId(context.member_id)) throw internal();
  return context;
}

/** Column-scoped class details candidate: no-op, optimistic version, audit and PG projection. */
export async function updateCurrentClassMariaDb(
  database: Kysely<DB>,
  input: UpdateCurrentClassCommand,
): Promise<UpdateCurrentClassResult> {
  const command = snapshot(input);
  return guarded(async (deny: Deny) => {
    const context = await teacherContext(database, command.actorUserId, deny);
    return database.transaction().execute(async (tx) => {
      // PG uses an application Date at transaction callback entry for updated_at; audit time keeps its DB default.
      const updatedAt = new Date().toISOString().replace("T", " ").replace("Z", "000");
      const accounts = await sql<{
        id: string;
        deleted_at: string | null;
        display_name: string;
        is_active: number;
      }>`
        SELECT id,deleted_at,display_name,is_active FROM users WHERE id=${command.actorUserId} FOR UPDATE`.execute(
        tx,
      );
      const account = accounts.rows[0];
      if (!account || account.is_active !== 1 || account.deleted_at !== null)
        deny(new UnauthenticatedException());
      if (account.id !== command.actorUserId) throw internal();
      const classes =
        await sql<ClassRow>`SELECT academic_year,edu_office_code,expected_student_count,grade,id,name,row_version,school_code,status,updated_at
        FROM classes WHERE id=${context.class_id} FOR UPDATE`.execute(tx);
      const target = classes.rows[0];
      if (!target) deny(new CurrentClassNotFoundException());
      if (target.status === "suspended") deny(new CurrentClassSuspendedException());
      if (target.status !== "active") deny(new CurrentClassNotFoundException());
      if (target.id !== context.class_id || !validId(target.row_version)) throw internal();
      const members = await sql<{
        id: string;
        role: string;
        status: string;
      }>`SELECT id,role,status FROM class_members
        WHERE id=${context.member_id} AND class_id=${target.id} AND user_id=${command.actorUserId} FOR UPDATE`.execute(
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
        FROM teacher_profiles WHERE user_id=${command.actorUserId} FOR UPDATE`.execute(tx);
      if (
        profiles.rows[0]?.status !== "active" ||
        profiles.rows[0]?.temporary_password_must_change !== 0
      )
        deny(new ClassRoleInsufficientException());
      if (target.row_version !== command.expectedRowVersion)
        deny(new ResourceVersionChangedException(target.row_version));
      const name = command.name ?? target.name,
        count = command.expectedStudentCount ?? target.expected_student_count;
      const nameChanged = name !== target.name,
        countChanged = count !== target.expected_student_count;
      if (nameChanged) {
        // Same measured PostgreSQL whitespace/case-fold set as 0002's generated key and create-class precheck.
        const whitespace = String.raw`[\x{0009}-\x{000D}\x{0020}\x{0085}\x{2000}-\x{2006}\x{2008}-\x{200A}\x{2028}-\x{2029}\x{205F}\x{3000}]+`;
        const duplicates = await sql<{
          id: string;
        }>`SELECT id FROM classes WHERE id<>${target.id} AND edu_office_code=${target.edu_office_code}
          AND school_code=${target.school_code} AND academic_year=${target.academic_year} AND grade=${target.grade}
          AND BINARY name_normalized=BINARY LOWER(REGEXP_REPLACE(TRIM(${name}),${whitespace},' ') COLLATE utf8mb4_uca1400_as_ci)
          AND status IN ('active','suspended') LIMIT 1`.execute(tx);
        if (duplicates.rows.length) deny(new ClassAlreadyExistsException());
      }
      let result = target;
      if (nameChanged || countChanged) {
        const changed = await sql`UPDATE classes SET ${sql.join([
          ...(nameChanged ? [sql`name=${name}`] : []),
          ...(countChanged ? [sql`expected_student_count=${count}`] : []),
          sql`row_version=row_version+1`,
          sql`updated_at=${updatedAt}`,
        ])} WHERE id=${target.id} AND row_version=${command.expectedRowVersion} AND status='active'`.execute(
          tx,
        );
        if (changed.numAffectedRows !== 1n)
          deny(new ResourceVersionChangedException(target.row_version));
        const updatedRows =
          await sql<ClassRow>`SELECT academic_year,edu_office_code,expected_student_count,grade,id,name,row_version,school_code,status,updated_at
          FROM classes WHERE id=${target.id}`.execute(tx);
        const updated = updatedRows.rows[0];
        if (
          !updated ||
          updated.id !== target.id ||
          updated.name !== name ||
          updated.expected_student_count !== count ||
          updated.row_version !== (BigInt(target.row_version) + 1n).toString() ||
          updated.updated_at !== updatedAt ||
          updated.status !== "active" ||
          updated.edu_office_code !== target.edu_office_code ||
          updated.school_code !== target.school_code ||
          updated.academic_year !== target.academic_year ||
          updated.grade !== target.grade
        )
          throw internal();
        result = updated;
        const before = {
          ...(nameChanged ? { name: target.name } : {}),
          ...(countChanged ? { expected_student_count: target.expected_student_count } : {}),
        };
        const after = {
          ...(nameChanged ? { name: updated.name } : {}),
          ...(countChanged ? { expected_student_count: updated.expected_student_count } : {}),
        };
        await sql`INSERT INTO audit_logs (action,actor_display_name_snapshot,actor_member_id,actor_role_snapshot,actor_user_id,
          after_json,before_json,class_id,reason,request_id,target_id,target_snapshot,target_type)
          VALUES ('class.updated',${account.display_name},${actor.id},'teacher',${command.actorUserId},${JSON.stringify(after)},${JSON.stringify(before)},
            ${target.id},NULL,${command.requestId},${target.id},NULL,'class')`.execute(tx);
      }
      const schools =
        await sql<School>`SELECT homepage_url,phone_number,road_address,road_address_detail,school_name FROM schools
        WHERE edu_office_code=${result.edu_office_code} AND school_code=${result.school_code}`.execute(
          tx,
        );
      const school = schools.rows[0];
      if (!school) throw internal();
      return view(
        result,
        school,
        "teacher",
        account.display_name,
        await studentCount(tx, result.id),
      );
    });
  });
}
