import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  IdempotencyService,
} from "@classhub/db";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { hasApprovedAccountAccess } from "../auth/account-access-policy.js";
import { EmailNotVerifiedException, UnauthenticatedException } from "../auth/auth.errors.js";
import { ResourceVersionChangedException } from "../common/http/if-match.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { schoolDetailsView } from "../schools/school-details.view.js";
import {
  generateInviteCode,
  INVITE_LIFETIME_MS,
  type InviteCodeJson,
  inviteView,
} from "./invite-code.js";
import {
  ClassArchiveConflictException,
  ClassAlreadyExistsException,
  ClassCreationNotAllowedException,
  ClassNameConfirmationMismatchException,
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
  CurrentInviteCodeNotFoundException,
  GradeNotAllowedException,
  InviteCodeGenerationFailedException,
  isClassIdentityViolation,
  mapIdempotencyError,
  SchoolKindNotSupportedException,
  SchoolNotFoundException,
} from "./classes.errors.js";
import type {
  ArchiveCurrentClassCommand,
  ArchiveCurrentClassResult,
  CreateClassCommand,
  CreateClassResult,
  CurrentClassResult,
  CurrentInviteCodeResult,
  RotateInviteCodeCommand,
  RotateInviteCodeResult,
  UpdateCurrentClassCommand,
  UpdateCurrentClassResult,
} from "./classes.types.js";

const CREATE_ROUTE = "/classes";
const ROTATE_ROUTE = "/classes/current/invite-code/rotate";

interface TeacherContext {
  classId: string;
  memberId: string;
}

interface RotateInviteCodeJson {
  [key: string]: InviteCodeJson | string;
  class_id: string;
  invite_code: InviteCodeJson;
}

interface ClassJson {
  [key: string]: number | string;
  academic_year: number;
  expected_student_count: number;
  grade: number;
  id: string;
  name: string;
  row_version: string;
  school_name: string;
  status: "active";
}

interface CreateClassJson {
  [key: string]: ClassJson | InviteCodeJson | string;
  class: ClassJson;
  invite_code: InviteCodeJson;
  next_action: "HOME";
  teacher_membership_id: string;
}

@Injectable()
export class ClassesService {
  private readonly idempotency: IdempotencyService;

  constructor(@Inject(DATABASE) private readonly database: ClassHubDatabase) {
    this.idempotency = new IdempotencyService(database);
  }

  async create(command: CreateClassCommand): Promise<CreateClassResult> {
    try {
      const result = await this.idempotency.execute<CreateClassJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
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
          routeKey: createIdempotencyRouteKey(CREATE_ROUTE, null),
        },
        async (transaction) => {
          const now = new Date();
          const account = await transaction
            .selectFrom("users")
            .select([
              "deleted_at",
              "display_name",
              "email_verified_at",
              "is_active",
              "signup_approved_at",
              "signup_role",
            ])
            .where("id", "=", command.actorUserId)
            .forUpdate()
            .executeTakeFirst();
          if (account === undefined || !account.is_active || account.deleted_at !== null) {
            throw new UnauthenticatedException();
          }
          if (!hasApprovedAccountAccess(account)) throw new EmailNotVerifiedException();

          const profile = await transaction
            .selectFrom("teacher_profiles")
            .select(["status", "temporary_password_must_change"])
            .where("user_id", "=", command.actorUserId)
            .executeTakeFirst();
          if (
            profile === undefined ||
            profile.status !== "active" ||
            profile.temporary_password_must_change
          ) {
            throw new ClassRoleInsufficientException();
          }

          const currentMembership = await transaction
            .selectFrom("class_members")
            .select("id")
            .where("user_id", "=", command.actorUserId)
            .where("status", "in", ["pending", "approved"])
            .forUpdate()
            .executeTakeFirst();
          if (currentMembership !== undefined) throw new ClassCreationNotAllowedException();

          const school = await transaction
            .selectFrom("schools")
            .select(["school_kind", "school_name"])
            .where("edu_office_code", "=", command.eduOfficeCode)
            .where("school_code", "=", command.schoolCode)
            .forUpdate()
            .executeTakeFirst();
          if (school === undefined) throw new SchoolNotFoundException();
          // 초등은 학급 자체를 만들 수 없다 — 이유는 예외 정의에 적어뒀다.
          if (school.school_kind === "elementary") throw new SchoolKindNotSupportedException();
          const maximumGrade = 3;
          if (command.grade > maximumGrade) throw new GradeNotAllowedException();

          const duplicate = await transaction
            .selectFrom("classes")
            .select("id")
            .where("edu_office_code", "=", command.eduOfficeCode)
            .where("school_code", "=", command.schoolCode)
            .where("academic_year", "=", command.academicYear)
            .where("grade", "=", command.grade)
            .where(
              "name_normalized",
              "=",
              sql<string>`lower(regexp_replace(btrim(${command.name}), '[[:space:]]+', ' ', 'g'))`,
            )
            .where("status", "in", ["active", "suspended"])
            .executeTakeFirst();
          if (duplicate !== undefined) throw new ClassAlreadyExistsException();

          const createdClass = await transaction
            .insertInto("classes")
            .values({
              academic_year: command.academicYear,
              created_by_user_id: command.actorUserId,
              edu_office_code: command.eduOfficeCode,
              expected_student_count: command.expectedStudentCount,
              grade: command.grade,
              name: command.name,
              school_code: command.schoolCode,
            })
            .returning([
              "academic_year",
              "expected_student_count",
              "grade",
              "id",
              "name",
              "row_version",
              "status",
            ])
            .executeTakeFirstOrThrow();

          const teacherMember = await transaction
            .insertInto("class_members")
            .values({
              class_id: createdClass.id,
              role: "teacher",
              status: "approved",
              user_id: command.actorUserId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("class_member_status_history")
            .values({
              actor_member_id: teacherMember.id,
              actor_operator_id: null,
              actor_user_id: command.actorUserId,
              class_id: createdClass.id,
              from_status: null,
              member_id: teacherMember.id,
              reason: null,
              to_status: "approved",
            })
            .execute();

          let createdInvite:
            { code: string; created_at: Date; expires_at: Date; id: string } | undefined;
          const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS);
          for (let attempt = 0; attempt < 5 && createdInvite === undefined; attempt += 1) {
            createdInvite = await transaction
              .insertInto("class_invite_codes")
              .values({
                class_id: createdClass.id,
                code: generateInviteCode(),
                created_at: now,
                created_by_member_id: teacherMember.id,
                expires_at: expiresAt,
              })
              .onConflict((conflict) => conflict.column("code").doNothing())
              .returning(["code", "created_at", "expires_at", "id"])
              .executeTakeFirst();
          }
          if (createdInvite === undefined) throw new InviteCodeGenerationFailedException();

          await transaction
            .insertInto("audit_logs")
            .values([
              {
                action: "class.created",
                actor_display_name_snapshot: account.display_name,
                actor_member_id: teacherMember.id,
                actor_role_snapshot: "teacher",
                actor_user_id: command.actorUserId,
                after_json: {
                  academic_year: createdClass.academic_year,
                  archived_at: null,
                  class_id: createdClass.id,
                  expected_student_count: createdClass.expected_student_count,
                  grade: createdClass.grade,
                  name: createdClass.name,
                  status: createdClass.status,
                  suspended_reason: null,
                },
                before_json: null,
                class_id: createdClass.id,
                reason: null,
                request_id: command.requestId,
                target_id: createdClass.id,
                target_snapshot: null,
                target_type: "class",
              },
              {
                action: "invite_code.created",
                actor_display_name_snapshot: account.display_name,
                actor_member_id: teacherMember.id,
                actor_role_snapshot: "teacher",
                actor_user_id: command.actorUserId,
                after_json: {
                  class_id: createdClass.id,
                  expires_at: createdInvite.expires_at.toISOString(),
                  invite_code_id: createdInvite.id,
                  revoke_reason: null,
                  revoked_at: null,
                },
                before_json: null,
                class_id: createdClass.id,
                reason: null,
                request_id: command.requestId,
                target_id: createdInvite.id,
                target_snapshot: null,
                target_type: "invite_code",
              },
            ])
            .execute();

          const body: CreateClassJson = {
            class: {
              academic_year: createdClass.academic_year,
              expected_student_count: createdClass.expected_student_count,
              grade: createdClass.grade,
              id: createdClass.id,
              name: createdClass.name,
              row_version: createdClass.row_version,
              school_name: school.school_name,
              status: "active",
            },
            invite_code: inviteView(createdInvite, now),
            next_action: "HOME",
            teacher_membership_id: teacherMember.id,
          };
          return { body, statusCode: 201 };
        },
      );
      return result.body as unknown as CreateClassResult;
    } catch (error) {
      if (isClassIdentityViolation(error)) throw new ClassAlreadyExistsException();
      mapIdempotencyError(error);
    }
  }

  async archiveCurrent(command: ArchiveCurrentClassCommand): Promise<ArchiveCurrentClassResult> {
    command = { ...command };
    const preliminary = await this.getTeacherContext(command.actorUserId);

    return this.database.transaction().execute(async (transaction) => {
      if (preliminary.classId !== command.expectedClassId)
        throw new ClassArchiveConflictException();
      const clock = await sql<{ occurred_at: Date }>`
        select transaction_timestamp() as occurred_at
      `.execute(transaction);
      const now = clock.rows[0]?.occurred_at;
      if (!(now instanceof Date)) {
        throw new Error("PostgreSQL transaction timestamp is unavailable.");
      }

      const account = await transaction
        .selectFrom("users")
        .select(["deleted_at", "display_name", "is_active"])
        .where("id", "=", command.actorUserId)
        .forUpdate()
        .executeTakeFirst();
      if (account === undefined || !account.is_active || account.deleted_at !== null) {
        throw new UnauthenticatedException();
      }

      const targetClass = await transaction
        .selectFrom("classes")
        .select([
          "academic_year",
          "archived_at",
          "expected_student_count",
          "grade",
          "id",
          "name",
          "row_version",
          "status",
          "suspended_reason",
        ])
        .where("id", "=", preliminary.classId)
        .forUpdate()
        .executeTakeFirst();
      if (targetClass === undefined) throw new CurrentClassNotFoundException();
      if (targetClass.status === "suspended") throw new CurrentClassSuspendedException();
      if (targetClass.status !== "active") throw new ClassArchiveConflictException();
      if (targetClass.row_version !== command.expectedRowVersion)
        throw new ResourceVersionChangedException(targetClass.row_version);

      const currentMembers = await transaction
        .selectFrom("class_members")
        .select(["id", "role", "status", "student_number", "user_id"])
        .where("class_id", "=", targetClass.id)
        .where("status", "in", ["pending", "approved"])
        .orderBy("id", "asc")
        .forUpdate()
        .execute();
      const actorMember = currentMembers.find((member) => member.id === preliminary.memberId);
      if (
        actorMember === undefined ||
        actorMember.user_id !== command.actorUserId ||
        actorMember.role !== "teacher" ||
        actorMember.status !== "approved"
      ) {
        throw new ClassRoleInsufficientException();
      }

      const openInvites = await transaction
        .selectFrom("class_invite_codes")
        .select(["class_id", "expires_at", "id", "revoke_reason", "revoked_at"])
        .where("class_id", "=", targetClass.id)
        .where("revoked_at", "is", null)
        .orderBy("id", "asc")
        .forUpdate()
        .execute();

      const profile = await transaction
        .selectFrom("teacher_profiles")
        .select(["status", "temporary_password_must_change"])
        .where("user_id", "=", command.actorUserId)
        .forUpdate()
        .executeTakeFirst();
      if (
        profile === undefined ||
        profile.status !== "active" ||
        profile.temporary_password_must_change
      ) {
        throw new ClassRoleInsufficientException();
      }

      if (command.classNameConfirmation !== targetClass.name) {
        throw new ClassNameConfirmationMismatchException();
      }

      const archivedClass = await transaction
        .updateTable("classes")
        .set({
          archived_at: now,
          archived_by_operator_id: null,
          archived_by_user_id: command.actorUserId,
          row_version: sql`row_version + 1`,
          status: "archived",
          updated_at: now,
        })
        .where("id", "=", targetClass.id)
        .where("status", "=", "active")
        .returning(["archived_at", "id", "row_version"])
        .executeTakeFirst();
      if (archivedClass === undefined || !(archivedClass.archived_at instanceof Date)) {
        throw new ClassArchiveConflictException();
      }

      const archiveReason = "반 운영 종료";
      for (const invite of openInvites) {
        const revoked = await transaction
          .updateTable("class_invite_codes")
          .set({
            revoke_reason: archiveReason,
            revoked_at: now,
            revoked_by_member_id: actorMember.id,
            revoked_by_operator_id: null,
          })
          .where("id", "=", invite.id)
          .where("revoked_at", "is", null)
          .returning("id")
          .executeTakeFirst();
        if (revoked === undefined) throw new ClassArchiveConflictException();
      }

      const historyRows: Array<{
        actor_member_id: string;
        actor_operator_id: null;
        actor_user_id: string;
        class_id: string;
        created_at: Date;
        from_status: string;
        member_id: string;
        reason: string;
        to_status: string;
      }> = [];
      for (const member of currentMembers) {
        const fromStatus = member.status;
        const toStatus = fromStatus === "pending" ? "canceled" : "archived";
        const changed = await transaction
          .updateTable("class_members")
          .set({
            row_version: sql`row_version + 1`,
            status: toStatus,
            status_changed_at: now,
            student_number: null,
            updated_at: now,
          })
          .where("id", "=", member.id)
          .where("class_id", "=", targetClass.id)
          .where("status", "=", fromStatus)
          .returning("id")
          .executeTakeFirst();
        if (changed === undefined) throw new ClassArchiveConflictException();
        historyRows.push({
          actor_member_id: actorMember.id,
          actor_operator_id: null,
          actor_user_id: command.actorUserId,
          class_id: targetClass.id,
          created_at: now,
          from_status: fromStatus,
          member_id: member.id,
          reason: archiveReason,
          to_status: toStatus,
        });
      }
      if (historyRows.length > 0) {
        await transaction.insertInto("class_member_status_history").values(historyRows).execute();
      }

      const classBefore = {
        archived_at: targetClass.archived_at?.toISOString() ?? null,
        status: targetClass.status,
      };
      await transaction
        .insertInto("audit_logs")
        .values({
          action: "class.archived",
          actor_display_name_snapshot: account.display_name,
          actor_member_id: actorMember.id,
          actor_role_snapshot: "teacher",
          actor_user_id: command.actorUserId,
          after_json: {
            archived_at: now.toISOString(),
            status: "archived",
          },
          before_json: classBefore,
          class_id: targetClass.id,
          created_at: now,
          reason: null,
          request_id: command.requestId,
          target_id: targetClass.id,
          target_snapshot: null,
          target_type: "class",
        })
        .execute();

      for (const invite of openInvites) {
        const inviteBefore = {
          revoke_reason: invite.revoke_reason,
          revoked_at: invite.revoked_at?.toISOString() ?? null,
        };
        await transaction
          .insertInto("audit_logs")
          .values({
            action: "invite_code.revoked",
            actor_display_name_snapshot: account.display_name,
            actor_member_id: actorMember.id,
            actor_role_snapshot: "teacher",
            actor_user_id: command.actorUserId,
            after_json: {
              revoke_reason: archiveReason,
              revoked_at: now.toISOString(),
            },
            before_json: inviteBefore,
            class_id: targetClass.id,
            created_at: now,
            reason: archiveReason,
            request_id: command.requestId,
            target_id: invite.id,
            target_snapshot: null,
            target_type: "invite_code",
          })
          .execute();
      }

      return {
        archived_at: archivedClass.archived_at.toISOString(),
        class_id: archivedClass.id,
        next_action: "CREATE_CLASS",
        row_version: archivedClass.row_version,
      };
    });
  }

  async getCurrent(userId: string): Promise<CurrentClassResult> {
    const current = await this.database
      .selectFrom("class_members as current_member")
      .innerJoin("classes as class", "class.id", "current_member.class_id")
      .innerJoin("schools as school", (join) =>
        join
          .onRef("school.edu_office_code", "=", "class.edu_office_code")
          .onRef("school.school_code", "=", "class.school_code"),
      )
      .innerJoin("class_members as teacher_member", (join) =>
        join
          .onRef("teacher_member.class_id", "=", "class.id")
          .on("teacher_member.role", "=", "teacher")
          .on("teacher_member.status", "=", "approved"),
      )
      .innerJoin("users as teacher", "teacher.id", "teacher_member.user_id")
      .select([
        "class.academic_year",
        "class.expected_student_count",
        "class.grade",
        "class.id",
        "class.name",
        "class.row_version",
        "class.status",
        "current_member.role",
        "school.homepage_url",
        "school.phone_number",
        "school.road_address",
        "school.road_address_detail",
        "school.school_name",
        "teacher.display_name as teacher_display_name",
      ])
      .where("current_member.user_id", "=", userId)
      .where("current_member.status", "=", "approved")
      .executeTakeFirst();

    if (current === undefined) throw new CurrentClassNotFoundException();
    if (current.status === "suspended") throw new CurrentClassSuspendedException();
    if (current.status !== "active") throw new CurrentClassNotFoundException();
    if (current.role !== "teacher" && current.role !== "student") {
      throw new CurrentClassNotFoundException();
    }

    const activeStudentCount = await this.database
      .selectFrom("class_members as member")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("member.class_id", "=", current.id)
      .where("member.role", "=", "student")
      .where("member.status", "=", "approved")
      .where("account.is_active", "=", true)
      .where("account.deleted_at", "is", null)
      .executeTakeFirstOrThrow();

    return {
      academic_year: current.academic_year,
      active_student_count: Number(activeStudentCount.count),
      ...(current.role === "teacher"
        ? { expected_student_count: current.expected_student_count }
        : {}),
      grade: current.grade,
      id: current.id,
      name: current.name,
      role: current.role,
      row_version: current.row_version,
      ...schoolDetailsView(current),
      school_name: current.school_name,
      status: "active",
      teacher_display_name: current.teacher_display_name,
    };
  }

  async updateCurrent(command: UpdateCurrentClassCommand): Promise<UpdateCurrentClassResult> {
    const preliminary = await this.getTeacherContext(command.actorUserId);

    try {
      return await this.database.transaction().execute(async (transaction) => {
        const now = new Date();
        const account = await transaction
          .selectFrom("users")
          .select(["deleted_at", "display_name", "is_active"])
          .where("id", "=", command.actorUserId)
          .forUpdate()
          .executeTakeFirst();
        if (account === undefined || !account.is_active || account.deleted_at !== null) {
          throw new UnauthenticatedException();
        }

        const targetClass = await transaction
          .selectFrom("classes")
          .select([
            "academic_year",
            "edu_office_code",
            "expected_student_count",
            "grade",
            "id",
            "name",
            "row_version",
            "school_code",
            "status",
          ])
          .where("id", "=", preliminary.classId)
          .forUpdate()
          .executeTakeFirst();
        if (targetClass === undefined) throw new CurrentClassNotFoundException();
        if (targetClass.status === "suspended") throw new CurrentClassSuspendedException();
        if (targetClass.status !== "active") throw new CurrentClassNotFoundException();

        const actorMember = await transaction
          .selectFrom("class_members")
          .select(["id", "role", "status"])
          .where("id", "=", preliminary.memberId)
          .where("class_id", "=", targetClass.id)
          .where("user_id", "=", command.actorUserId)
          .forUpdate()
          .executeTakeFirst();
        if (
          actorMember === undefined ||
          actorMember.role !== "teacher" ||
          actorMember.status !== "approved"
        ) {
          throw new ClassRoleInsufficientException();
        }

        const profile = await transaction
          .selectFrom("teacher_profiles")
          .select(["status", "temporary_password_must_change"])
          .where("user_id", "=", command.actorUserId)
          .executeTakeFirst();
        if (
          profile === undefined ||
          profile.status !== "active" ||
          profile.temporary_password_must_change
        ) {
          throw new ClassRoleInsufficientException();
        }

        if (targetClass.row_version !== command.expectedRowVersion) {
          throw new ResourceVersionChangedException(targetClass.row_version);
        }

        const nextName = command.name ?? targetClass.name;
        const nextExpectedStudentCount =
          command.expectedStudentCount ?? targetClass.expected_student_count;
        const nameChanged = nextName !== targetClass.name;
        const expectedStudentCountChanged =
          nextExpectedStudentCount !== targetClass.expected_student_count;

        if (nameChanged) {
          const duplicate = await transaction
            .selectFrom("classes")
            .select("id")
            .where("id", "!=", targetClass.id)
            .where("edu_office_code", "=", targetClass.edu_office_code)
            .where("school_code", "=", targetClass.school_code)
            .where("academic_year", "=", targetClass.academic_year)
            .where("grade", "=", targetClass.grade)
            .where(
              "name_normalized",
              "=",
              sql<string>`lower(regexp_replace(btrim(${nextName}), '[[:space:]]+', ' ', 'g'))`,
            )
            .where("status", "in", ["active", "suspended"])
            .executeTakeFirst();
          if (duplicate !== undefined) throw new ClassAlreadyExistsException();
        }

        let resultClass = targetClass;
        if (nameChanged || expectedStudentCountChanged) {
          const updated = await transaction
            .updateTable("classes")
            .set({
              ...(nameChanged ? { name: nextName } : {}),
              ...(expectedStudentCountChanged
                ? { expected_student_count: nextExpectedStudentCount }
                : {}),
              row_version: sql`row_version + 1`,
              updated_at: now,
            })
            .where("id", "=", targetClass.id)
            .where("row_version", "=", command.expectedRowVersion)
            .returning([
              "academic_year",
              "edu_office_code",
              "expected_student_count",
              "grade",
              "id",
              "name",
              "row_version",
              "school_code",
              "status",
            ])
            .executeTakeFirst();
          if (updated === undefined) {
            throw new ResourceVersionChangedException(targetClass.row_version);
          }
          resultClass = updated;

          const before: Record<string, number | string> = {};
          const after: Record<string, number | string> = {};
          if (nameChanged) {
            before.name = targetClass.name;
            after.name = updated.name;
          }
          if (expectedStudentCountChanged) {
            before.expected_student_count = targetClass.expected_student_count;
            after.expected_student_count = updated.expected_student_count;
          }
          await transaction
            .insertInto("audit_logs")
            .values({
              action: "class.updated",
              actor_display_name_snapshot: account.display_name,
              actor_member_id: actorMember.id,
              actor_role_snapshot: "teacher",
              actor_user_id: command.actorUserId,
              after_json: after,
              before_json: before,
              class_id: targetClass.id,
              reason: null,
              request_id: command.requestId,
              target_id: targetClass.id,
              target_snapshot: null,
              target_type: "class",
            })
            .execute();
        }

        const school = await transaction
          .selectFrom("schools")
          .select([
            "homepage_url",
            "phone_number",
            "road_address",
            "road_address_detail",
            "school_name",
          ])
          .where("edu_office_code", "=", resultClass.edu_office_code)
          .where("school_code", "=", resultClass.school_code)
          .executeTakeFirstOrThrow();
        const activeStudentCount = await transaction
          .selectFrom("class_members as member")
          .innerJoin("users as student", "student.id", "member.user_id")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("member.class_id", "=", resultClass.id)
          .where("member.role", "=", "student")
          .where("member.status", "=", "approved")
          .where("student.is_active", "=", true)
          .where("student.deleted_at", "is", null)
          .executeTakeFirstOrThrow();

        return {
          academic_year: resultClass.academic_year,
          active_student_count: Number(activeStudentCount.count),
          expected_student_count: resultClass.expected_student_count,
          grade: resultClass.grade,
          id: resultClass.id,
          name: resultClass.name,
          role: "teacher",
          row_version: resultClass.row_version,
          ...schoolDetailsView(school),
          school_name: school.school_name,
          status: "active",
          teacher_display_name: account.display_name,
        };
      });
    } catch (error) {
      if (isClassIdentityViolation(error)) throw new ClassAlreadyExistsException();
      throw error;
    }
  }

  async getCurrentInviteCode(userId: string, now = new Date()): Promise<CurrentInviteCodeResult> {
    const context = await this.getTeacherContext(userId);
    const invite = await this.database
      .selectFrom("class_invite_codes")
      .select(["code", "created_at", "expires_at", "id"])
      .where("class_id", "=", context.classId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (invite === undefined) throw new CurrentInviteCodeNotFoundException();

    return { class_id: context.classId, invite_code: inviteView(invite, now) };
  }

  async rotateInviteCode(command: RotateInviteCodeCommand): Promise<RotateInviteCodeResult> {
    const preliminary = await this.getTeacherContext(command.actorUserId);

    try {
      const result = await this.idempotency.execute<RotateInviteCodeJson>(
        {
          actorUserId: command.actorUserId,
          idempotencyKey: command.idempotencyKey as string,
          requestHash: createIdempotencyRequestHash({
            body: {},
            effectiveClassId: preliminary.classId,
          }),
          routeKey: createIdempotencyRouteKey(ROTATE_ROUTE, preliminary.classId),
        },
        async (transaction) => {
          const now = new Date();
          const account = await transaction
            .selectFrom("users")
            .select(["deleted_at", "display_name", "is_active"])
            .where("id", "=", command.actorUserId)
            .forUpdate()
            .executeTakeFirst();
          if (account === undefined || !account.is_active || account.deleted_at !== null) {
            throw new UnauthenticatedException();
          }

          const targetClass = await transaction
            .selectFrom("classes")
            .select(["id", "status"])
            .where("id", "=", preliminary.classId)
            .forUpdate()
            .executeTakeFirst();
          if (targetClass === undefined) throw new CurrentClassNotFoundException();
          if (targetClass.status === "suspended") throw new CurrentClassSuspendedException();
          if (targetClass.status !== "active") throw new CurrentClassNotFoundException();

          const actorMember = await transaction
            .selectFrom("class_members")
            .select(["id", "role", "status"])
            .where("id", "=", preliminary.memberId)
            .where("class_id", "=", targetClass.id)
            .where("user_id", "=", command.actorUserId)
            .forUpdate()
            .executeTakeFirst();
          if (
            actorMember === undefined ||
            actorMember.role !== "teacher" ||
            actorMember.status !== "approved"
          ) {
            throw new ClassRoleInsufficientException();
          }

          const profile = await transaction
            .selectFrom("teacher_profiles")
            .select(["status", "temporary_password_must_change"])
            .where("user_id", "=", command.actorUserId)
            .executeTakeFirst();
          if (
            profile === undefined ||
            profile.status !== "active" ||
            profile.temporary_password_must_change
          ) {
            throw new ClassRoleInsufficientException();
          }

          const previous = await transaction
            .selectFrom("class_invite_codes")
            .select(["expires_at", "id", "revoke_reason", "revoked_at"])
            .where("class_id", "=", targetClass.id)
            .where("revoked_at", "is", null)
            .forUpdate()
            .executeTakeFirst();
          if (previous === undefined) throw new CurrentInviteCodeNotFoundException();

          const revokeReason = "재발급";
          await transaction
            .updateTable("class_invite_codes")
            .set({
              revoke_reason: revokeReason,
              revoked_at: now,
              revoked_by_member_id: actorMember.id,
              revoked_by_operator_id: null,
            })
            .where("id", "=", previous.id)
            .where("revoked_at", "is", null)
            .executeTakeFirstOrThrow();

          let created: { code: string; created_at: Date; expires_at: Date; id: string } | undefined;
          const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS);
          for (let attempt = 0; attempt < 5 && created === undefined; attempt += 1) {
            created = await transaction
              .insertInto("class_invite_codes")
              .values({
                class_id: targetClass.id,
                code: generateInviteCode(),
                created_at: now,
                created_by_member_id: actorMember.id,
                expires_at: expiresAt,
              })
              .onConflict((conflict) => conflict.column("code").doNothing())
              .returning(["code", "created_at", "expires_at", "id"])
              .executeTakeFirst();
          }
          if (created === undefined) throw new InviteCodeGenerationFailedException();

          const previousBefore = {
            revoke_reason: previous.revoke_reason,
            revoked_at: previous.revoked_at?.toISOString() ?? null,
          };
          const previousAfter = {
            ...previousBefore,
            revoke_reason: revokeReason,
            revoked_at: now.toISOString(),
          };
          await transaction
            .insertInto("audit_logs")
            .values([
              {
                action: "invite_code.revoked",
                actor_display_name_snapshot: account.display_name,
                actor_member_id: actorMember.id,
                actor_role_snapshot: "teacher",
                actor_user_id: command.actorUserId,
                after_json: previousAfter,
                before_json: previousBefore,
                class_id: targetClass.id,
                reason: revokeReason,
                request_id: command.requestId,
                target_id: previous.id,
                target_snapshot: null,
                target_type: "invite_code",
              },
              {
                action: "invite_code.created",
                actor_display_name_snapshot: account.display_name,
                actor_member_id: actorMember.id,
                actor_role_snapshot: "teacher",
                actor_user_id: command.actorUserId,
                after_json: {
                  class_id: targetClass.id,
                  expires_at: created.expires_at.toISOString(),
                  invite_code_id: created.id,
                  revoke_reason: null,
                  revoked_at: null,
                },
                before_json: null,
                class_id: targetClass.id,
                reason: null,
                request_id: command.requestId,
                target_id: created.id,
                target_snapshot: null,
                target_type: "invite_code",
              },
            ])
            .execute();

          const body: RotateInviteCodeJson = {
            class_id: targetClass.id,
            invite_code: inviteView(created, now),
          };
          return { body, statusCode: 200 };
        },
      );
      return result.body as unknown as RotateInviteCodeResult;
    } catch (error) {
      mapIdempotencyError(error);
    }
  }

  private async getTeacherContext(userId: string): Promise<TeacherContext> {
    const current = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.id as class_id",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", userId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();
    if (current === undefined) throw new CurrentClassNotFoundException();
    if (current.class_status === "suspended") throw new CurrentClassSuspendedException();
    if (current.class_status !== "active") throw new CurrentClassNotFoundException();
    if (
      current.role !== "teacher" ||
      current.profile_status !== "active" ||
      current.temporary_password_must_change !== false
    ) {
      throw new ClassRoleInsufficientException();
    }
    return { classId: current.class_id, memberId: current.member_id };
  }
}
