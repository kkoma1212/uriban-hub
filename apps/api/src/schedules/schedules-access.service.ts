import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import type { Transaction } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { addCalendarDays, databaseDate } from "../common/date/kst-date.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { schedulesDatabase, schedulesTransaction } from "./mariadb/schedules-dialect.js";
import {
  ScheduleClassSuspendedException,
  ScheduleNotFoundException,
  ScheduleRoleInsufficientException,
} from "./schedules.errors.js";

export type ScheduleActorRole = "student" | "teacher";

export interface ScheduleAccessContext {
  academicYear: number;
  classId: string;
  eduOfficeCode: string;
  grade: number;
  memberId: string;
  role: ScheduleActorRole;
  schoolCode: string;
}

export interface ScheduleResourceRow {
  class_id: string;
  description: string | null;
  due_date: Date | string;
  id: string;
  row_version: string;
  schedule_type: string;
  subject: string | null;
  title: string;
}

export interface LockedScheduleActor extends ScheduleAccessContext {
  displayName: string;
}

interface RawCurrentContext {
  academic_year: number;
  class_id: string;
  class_status: string;
  edu_office_code: string;
  grade: number;
  member_id: string;
  profile_status: string | null;
  role: string;
  school_code: string;
  temporary_password_must_change: boolean | null;
}

const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;

function isPositiveId(value: string): boolean {
  if (!/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

@Injectable()
export class SchedulesAccessService {
  private readonly database: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
  ) {
    ({ database: this.database, engine: this.engine } = schedulesDatabase(database, environment));
  }

  async getCollectionContext(actorUserId: string): Promise<ScheduleAccessContext> {
    const current = await this.getRawCurrentContext(actorUserId);
    if (current === undefined || current.class_status === "archived") {
      throw new ScheduleNotFoundException();
    }
    return this.assertActiveContext(current);
  }

  async getResourceContext(
    actorUserId: string,
    scheduleId: string,
    serverToday: string,
  ): Promise<{ context: ScheduleAccessContext; schedule: ScheduleResourceRow }> {
    if (!isPositiveId(scheduleId)) throw new ScheduleNotFoundException();

    const [current, schedule] = await Promise.all([
      this.getRawCurrentContext(actorUserId),
      this.database
        .selectFrom("schedules")
        .select([
          "class_id",
          "description",
          "due_date",
          "id",
          "row_version",
          "schedule_type",
          "subject",
          "title",
        ])
        .where("id", "=", scheduleId)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
    ]);

    if (
      current === undefined ||
      current.class_status === "archived" ||
      schedule === undefined ||
      schedule.class_id !== current.class_id
    ) {
      throw new ScheduleNotFoundException();
    }

    const context = this.assertActiveContext(current);
    this.assertHistoryWindow(schedule, serverToday);
    return { context, schedule };
  }

  async lockActorContext(
    transaction: Transaction<DB>,
    preliminary: ScheduleAccessContext,
    actorUserId: string,
  ): Promise<LockedScheduleActor> {
    transaction = schedulesTransaction(transaction, this.engine);
    const account = await transaction
      .selectFrom("users")
      .select(["deleted_at", "display_name", "is_active"])
      .where("id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }

    const targetClass = await transaction
      .selectFrom("classes")
      .select(["academic_year", "edu_office_code", "grade", "id", "school_code", "status"])
      .where("id", "=", preliminary.classId)
      .forUpdate()
      .executeTakeFirst();
    if (targetClass === undefined || targetClass.status === "archived") {
      throw new ScheduleNotFoundException();
    }
    if (targetClass.status === "suspended") throw new ScheduleClassSuspendedException();
    if (targetClass.status !== "active") throw new ScheduleNotFoundException();

    const actorMember = await transaction
      .selectFrom("class_members")
      .select(["id", "role", "status", "user_id"])
      .where("id", "=", preliminary.memberId)
      .where("class_id", "=", targetClass.id)
      .where("user_id", "=", actorUserId)
      .forUpdate()
      .executeTakeFirst();
    if (actorMember === undefined || actorMember.status !== "approved") {
      throw new ScheduleNotFoundException();
    }
    if (actorMember.role !== "teacher") {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 관리할 수 있어요.");
    }

    const profile = await transaction
      .selectFrom("teacher_profiles")
      .select(["status", "temporary_password_must_change"])
      .where("user_id", "=", actorUserId)
      .executeTakeFirst();
    if (
      profile === undefined ||
      profile.status !== "active" ||
      profile.temporary_password_must_change
    ) {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 관리할 수 있어요.");
    }

    return {
      academicYear: targetClass.academic_year,
      classId: targetClass.id,
      displayName: account.display_name,
      eduOfficeCode: targetClass.edu_office_code,
      grade: targetClass.grade,
      memberId: actorMember.id,
      role: "teacher",
      schoolCode: targetClass.school_code,
    };
  }

  async lockSchedule(
    transaction: Transaction<DB>,
    classId: string,
    scheduleId: string,
    serverToday: string,
  ): Promise<ScheduleResourceRow> {
    transaction = schedulesTransaction(transaction, this.engine);
    if (!isPositiveId(scheduleId)) throw new ScheduleNotFoundException();
    const schedule = await transaction
      .selectFrom("schedules")
      .select([
        "class_id",
        "description",
        "due_date",
        "id",
        "row_version",
        "schedule_type",
        "subject",
        "title",
      ])
      .where("id", "=", scheduleId)
      .where("class_id", "=", classId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (schedule === undefined) throw new ScheduleNotFoundException();
    this.assertHistoryWindow(schedule, serverToday);
    return schedule;
  }

  assertHistoryWindow(schedule: Pick<ScheduleResourceRow, "due_date">, serverToday: string): void {
    const oldestVisible = addCalendarDays(serverToday, -90);
    if (databaseDate(schedule.due_date) < oldestVisible) throw new ScheduleNotFoundException();
  }

  private async getRawCurrentContext(actorUserId: string): Promise<RawCurrentContext | undefined> {
    return this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "class.academic_year",
        "class.edu_office_code",
        "class.grade",
        "class.id as class_id",
        "class.school_code",
        "class.status as class_status",
        "member.id as member_id",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();
  }

  private assertActiveContext(current: RawCurrentContext): ScheduleAccessContext {
    if (current.class_status === "suspended") throw new ScheduleClassSuspendedException();
    if (current.class_status !== "active") throw new ScheduleNotFoundException();
    if (current.role !== "student" && current.role !== "teacher") {
      throw new ScheduleRoleInsufficientException();
    }
    if (
      current.role === "teacher" &&
      (current.profile_status !== "active" || current.temporary_password_must_change !== false)
    ) {
      throw new ScheduleRoleInsufficientException("이 반의 선생님만 일정을 관리할 수 있어요.");
    }
    return {
      academicYear: current.academic_year,
      classId: current.class_id,
      eduOfficeCode: current.edu_office_code,
      grade: current.grade,
      memberId: current.member_id,
      role: current.role,
      schoolCode: current.school_code,
    };
  }
}
