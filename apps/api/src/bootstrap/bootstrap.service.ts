import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { schoolDetailsView } from "../schools/school-details.view.js";
import { decideBootstrapPolicy } from "./bootstrap-policy.js";
import type { BootstrapResult } from "./bootstrap.types.js";

function mariaDbBoolean(value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw new ServiceUnavailableException(
      "초기 정보를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    );
  }
  return value === 1;
}

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async getForUser(userId: string): Promise<BootstrapResult> {
    const mariaDb = this.config.get("DATABASE_ENGINE", { infer: true }) === "mariadb";
    const serverToday = await readDatabaseKstToday(this.database, mariaDb ? "mariadb" : "postgres");
    const rawState = await this.database
      .selectFrom("users")
      .leftJoin("teacher_profiles", "teacher_profiles.user_id", "users.id")
      .leftJoin("class_members as current_membership", (join) =>
        join
          .onRef("current_membership.user_id", "=", "users.id")
          .on("current_membership.status", "in", ["pending", "approved"]),
      )
      .leftJoin("classes as current_class", "current_class.id", "current_membership.class_id")
      .leftJoin("schools as current_school", (join) =>
        join
          .onRef("current_school.edu_office_code", "=", "current_class.edu_office_code")
          .onRef("current_school.school_code", "=", "current_class.school_code"),
      )
      .select([
        "current_class.id as class_id",
        "current_class.name as class_name",
        "current_class.status as class_status",
        "current_school.homepage_url as school_homepage_url",
        "current_school.phone_number as school_phone_number",
        "current_school.road_address as school_road_address",
        "current_school.road_address_detail as school_road_address_detail",
        "current_school.school_name",
        "current_membership.class_id as membership_class_id",
        "current_membership.display_name_in_class as membership_display_name_in_class",
        "current_membership.id as membership_id",
        "current_membership.role as membership_role",
        "current_membership.student_number as membership_student_number",
        "current_membership.status as membership_status",
        "teacher_profiles.status as teacher_status",
        "teacher_profiles.temporary_password_must_change",
        "users.deleted_at",
        "users.display_name",
        "users.email_verified_at",
        "users.is_active",
        "users.signup_approved_at",
        "users.signup_role",
      ])
      .where("users.id", "=", userId)
      .executeTakeFirst();
    const state =
      rawState === undefined || !mariaDb
        ? rawState
        : {
            ...rawState,
            is_active: mariaDbBoolean(rawState.is_active),
            temporary_password_must_change:
              rawState.temporary_password_must_change === null
                ? null
                : mariaDbBoolean(rawState.temporary_password_must_change),
          };

    if (state === undefined || !state.is_active || state.deleted_at !== null) {
      throw new UnauthenticatedException();
    }

    const lastMembership = await this.database
      .selectFrom("class_members")
      .select(["id", "status"])
      .where("user_id", "=", userId)
      .where("status", "not in", ["pending", "approved"])
      .orderBy("status_changed_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    const lastHistory =
      lastMembership === undefined
        ? undefined
        : await this.database
            .selectFrom("class_member_status_history")
            .select("reason")
            .where("member_id", "=", lastMembership.id)
            .where("to_status", "=", lastMembership.status)
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .executeTakeFirst();

    const teacherStatus = state.teacher_status as "active" | "revoked" | null;
    const membershipRole = state.membership_role as "student" | "teacher" | null;
    const membershipStatus = state.membership_status as "approved" | "pending" | null;
    const classStatus = state.class_status as "active" | "suspended" | null;
    const policy = decideBootstrapPolicy({
      attendanceNotificationsEnabled: this.config.get("ATTENDANCE_NOTIFICATIONS_ENABLED", {
        infer: true,
      }),
      classChatEnabled: this.config.get("CLASS_CHAT_ENABLED", { infer: true }),
      profilePhotosEnabled: this.config.get("PROFILE_PHOTOS_ENABLED", { infer: true }),
      classStatus,
      electionsEnabled: this.config.get("ELECTIONS_ENABLED", { infer: true }),
      emailVerified: state.email_verified_at !== null,
      membershipRole,
      membershipStatus,
      pollsEnabled: this.config.get("POLLS_ENABLED", { infer: true }),
      pollEditInstalled: this.config.get("POLL_EDIT_DATABASE_INSTALLED", { infer: true }),
      signupApproved: state.signup_approved_at !== null,
      signupRole: state.signup_role,
      studentAssessmentsEnabled: this.config.get("STUDENT_ASSESSMENTS_ENABLED", { infer: true }),
      teacherStatus,
      temporaryPasswordMustChange: state.temporary_password_must_change ?? false,
    });

    return {
      account: {
        display_name: state.display_name,
        email_verified: state.email_verified_at !== null,
        is_active: state.is_active,
        signup_role:
          state.signup_role === "student" || state.signup_role === "teacher"
            ? state.signup_role
            : null,
      },
      allowed_actions: policy.allowedActions,
      current_class:
        state.class_id === null ||
        state.class_name === null ||
        state.school_name === null ||
        classStatus === null
          ? null
          : {
              id: state.class_id,
              name: state.class_name,
              ...schoolDetailsView({
                homepage_url: state.school_homepage_url,
                phone_number: state.school_phone_number,
                road_address: state.school_road_address,
                road_address_detail: state.school_road_address_detail,
              }),
              school_name: state.school_name,
              status: classStatus,
            },
      current_membership:
        state.membership_id === null ||
        state.membership_class_id === null ||
        membershipRole === null ||
        membershipStatus === null
          ? null
          : {
              class_id: state.membership_class_id,
              display_name_in_class: state.membership_display_name_in_class,
              id: state.membership_id,
              role: membershipRole,
              student_number: state.membership_student_number,
              status: membershipStatus,
            },
      destination: policy.destination,
      last_membership_status: lastMembership?.status ?? null,
      last_status_reason: lastHistory?.reason ?? null,
      server_today: serverToday,
      teacher_profile:
        teacherStatus === null
          ? null
          : {
              status: teacherStatus,
              temporary_password_must_change: state.temporary_password_must_change ?? false,
            },
    };
  }
}
