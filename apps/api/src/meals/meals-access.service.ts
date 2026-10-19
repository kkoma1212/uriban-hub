import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { mealsDatabase } from "./mariadb/meals-database.js";
import {
  MealClassSuspendedException,
  MealNotFoundException,
  MealRoleInsufficientException,
} from "./meals.errors.js";

export interface MealAccessContext {
  eduOfficeCode: string;
  schoolCode: string;
}

@Injectable()
export class MealsAccessService {
  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    this.database = mealsDatabase(database, config).database;
  }

  async getCurrentSchool(actorUserId: string): Promise<MealAccessContext> {
    const context = await this.database
      .selectFrom("class_members as member")
      .innerJoin("classes as class", "class.id", "member.class_id")
      .innerJoin("users as account", "account.id", "member.user_id")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
      .select([
        "account.deleted_at",
        "account.is_active",
        "class.edu_office_code",
        "class.school_code",
        "class.status as class_status",
        "member.role",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("member.user_id", "=", actorUserId)
      .where("member.status", "=", "approved")
      .executeTakeFirst();

    if (context === undefined || !context.is_active || context.deleted_at !== null) {
      throw new MealNotFoundException();
    }
    if (context.class_status === "suspended") throw new MealClassSuspendedException();
    if (context.class_status !== "active") throw new MealNotFoundException();
    if (context.role !== "student" && context.role !== "teacher") {
      throw new MealRoleInsufficientException();
    }
    if (
      context.role === "teacher" &&
      (context.profile_status !== "active" || context.temporary_password_must_change !== false)
    ) {
      throw new MealRoleInsufficientException();
    }

    return {
      eduOfficeCode: context.edu_office_code,
      schoolCode: context.school_code,
    };
  }
}
