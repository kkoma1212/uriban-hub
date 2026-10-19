import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { ClassRoleInsufficientException } from "../classes/classes.errors.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbDateTime,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { SearchSchoolsResult } from "./schools.types.js";

@Injectable()
export class SchoolsService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config?.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Unsupported schools database engine.");
    this.engine = engine;
    if (engine === "mariadb")
      this.database = database.withPlugin(
        createMariaDbRowCodec({
          is_active: mariaDbBoolean,
          deleted_at: mariaDbNullable(mariaDbDateTime),
          temporary_password_must_change: mariaDbNullable(mariaDbBoolean),
        }),
      );
  }

  async search(userId: string, rawQuery: string): Promise<SearchSchoolsResult> {
    const account = await this.database
      .selectFrom("users as account")
      .leftJoin("teacher_profiles as profile", "profile.user_id", "account.id")
      .select([
        "account.deleted_at",
        "account.is_active",
        "profile.status as profile_status",
        "profile.temporary_password_must_change",
      ])
      .where("account.id", "=", userId)
      .executeTakeFirst();
    if (account === undefined || !account.is_active || account.deleted_at !== null) {
      throw new UnauthenticatedException();
    }
    if (account.profile_status !== "active" || account.temporary_password_must_change !== false) {
      throw new ClassRoleInsufficientException();
    }

    const query = rawQuery.trim();
    const schools = await this.database
      .selectFrom("schools")
      .select([
        "edu_office_code",
        "edu_office_name",
        "region_name",
        "school_code",
        "school_kind",
        "school_name",
      ])
      .where(
        this.engine === "mariadb"
          ? // LOCATE is a literal substring operation: %, _ and backslashes are not LIKE patterns.
            sql<boolean>`LOCATE(LOWER(${query}), LOWER(school_name)) > 0`
          : sql<boolean>`position(lower(${query}) in lower(school_name)) > 0`,
      )
      /*
       * 초등은 학급을 만들 수 없으므로(classes.errors의 SchoolKindNotSupportedException)
       * 검색 결과에서도 뺀다. 남겨두면 교사가 자기 학교를 고르고 마지막 단계에서야
       * 거부당한다. NEIS 동기화는 초등도 그대로 받아 저장한다 — 나중에 정책이 바뀌면
       * 이 한 줄만 풀면 되고, 그때 학교 목록을 다시 가져오지 않아도 된다.
       */
      .where("school_kind", "!=", "elementary")
      .orderBy(
        sql<number>`CASE WHEN left(lower(school_name), char_length(${query})) = lower(${query}) THEN 0 ELSE 1 END`,
      )
      .orderBy("school_name")
      .orderBy("school_code")
      .limit(20)
      .execute();

    return {
      schools: schools.map((school) => ({
        ...school,
        school_kind: school.school_kind as "elementary" | "high" | "middle",
      })),
    };
  }
}
