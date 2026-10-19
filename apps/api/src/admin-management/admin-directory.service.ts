import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type ExpressionBuilder } from "kysely";

import {
  createMariaDbRowCodec,
  mariaDbBoolean,
  mariaDbDateTime,
  mariaDbId,
  mariaDbNullable,
} from "../common/database/mariadb-values.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type {
  AdminClassStatus,
  AdminPersonRole,
  AdminPersonStatus,
} from "./admin-directory.dto.js";

export const ADMIN_CLASS_PAGE_SIZE = 20;
export const ADMIN_PEOPLE_PAGE_SIZE = 30;

/** 반 한 줄: 반 기본 정보·담임 이름·인원 수만(학생 이름·메일·활동 내용 없음). */
export interface AdminClassRow {
  id: string;
  name: string;
  academic_year: number;
  grade: number;
  school_name: string;
  region_name: string;
  status: string;
  created_at: string;
  teacher_name: string | null;
  students: number;
  pending_members: number;
}

export interface AdminClassList {
  classes: AdminClassRow[];
  total: number;
  page: number;
  page_size: number;
}

/** 사람 한 줄: 메일은 앞 두 글자만 보이게 가리고, 로그인 비밀·접속 주소는 없다. */
export interface AdminPersonRow {
  id: string;
  display_name: string;
  email_masked: string;
  role: AdminPersonRole;
  status: AdminPersonStatus;
  created_at: string;
  /** 보관 중인 로그인 기록의 마지막 시각(오래된 기록은 지워지므로 없으면 null) */
  last_login_at: string | null;
  class_name: string | null;
  school_name: string | null;
}

export interface AdminPeopleList {
  people: AdminPersonRow[];
  total: number;
  page: number;
  page_size: number;
}

const mariaClassCodec = createMariaDbRowCodec({
  id: mariaDbId,
  created_at: mariaDbDateTime,
  is_active: mariaDbBoolean,
  is_teacher: mariaDbBoolean,
  signup_approved_at: mariaDbNullable(mariaDbDateTime),
  last_login_at: mariaDbNullable(mariaDbDateTime),
});

/** "abcd@example.com" → "ab***@example.com": 누구인지 짐작만 되게, 전체 주소는 보내지 않는다. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = Array.from(email.slice(0, at));
  const visible = local.slice(0, Math.min(2, local.length - 1)).join("");
  return `${visible}***${email.slice(at)}`;
}

const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

@Injectable()
export class AdminDirectoryService {
  private readonly db: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator directory database engine.");
    this.engine = engine;
    this.db = engine === "mariadb" ? database.withPlugin(mariaClassCodec) : database;
  }

  async listClasses(query: {
    search?: string | undefined;
    status?: AdminClassStatus | undefined;
    page?: number | undefined;
  }): Promise<AdminClassList> {
    const page = query.page ?? 1;
    const search = query.search?.normalize("NFC").trim();
    const filtered = this.filteredClasses(search, query.status);
    const [totalRow, rows] = await Promise.all([
      filtered.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
      filtered
        .select((eb) => [
          "c.id",
          "c.name",
          "c.academic_year",
          "c.grade",
          "c.status",
          "c.created_at",
          "s.school_name",
          "s.region_name",
          // 담임 이름: 승인된 선생님 중 먼저 들어온 한 명(반마다 한 줄을 지키려고 하위 조회로).
          eb
            .selectFrom("class_members as t")
            .innerJoin("users as u", "u.id", "t.user_id")
            .select("u.display_name")
            .whereRef("t.class_id", "=", "c.id")
            .where("t.role", "=", "teacher")
            .where("t.status", "=", "approved")
            .orderBy("t.id")
            .limit(1)
            .as("teacher_name"),
          eb
            .selectFrom("class_members as m")
            .select((inner) => inner.fn.countAll().as("n"))
            .whereRef("m.class_id", "=", "c.id")
            .where("m.role", "=", "student")
            .where("m.status", "=", "approved")
            .as("students"),
          eb
            .selectFrom("class_members as p")
            .select((inner) => inner.fn.countAll().as("n"))
            .whereRef("p.class_id", "=", "c.id")
            .where("p.status", "=", "pending")
            .as("pending_members"),
        ])
        .orderBy("c.created_at", "desc")
        .orderBy("c.id", "desc")
        .limit(ADMIN_CLASS_PAGE_SIZE)
        .offset((page - 1) * ADMIN_CLASS_PAGE_SIZE)
        .execute(),
    ]);
    return {
      classes: rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        academic_year: Number(row.academic_year),
        grade: Number(row.grade),
        school_name: row.school_name,
        region_name: row.region_name,
        status: row.status,
        created_at: toIso(row.created_at),
        teacher_name: row.teacher_name ?? null,
        students: Number(row.students ?? 0),
        pending_members: Number(row.pending_members ?? 0),
      })),
      total: Number(totalRow.total),
      page,
      page_size: ADMIN_CLASS_PAGE_SIZE,
    };
  }

  async listPeople(query: {
    search?: string | undefined;
    role?: AdminPersonRole | undefined;
    status?: AdminPersonStatus | undefined;
    page?: number | undefined;
  }): Promise<AdminPeopleList> {
    const page = query.page ?? 1;
    const filtered = this.filteredPeople(query);
    const [totalRow, rows] = await Promise.all([
      filtered.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
      filtered
        .leftJoin("class_members as cm", (join) =>
          join.onRef("cm.user_id", "=", "u.id").on("cm.status", "=", "approved"),
        )
        .leftJoin("classes as c", "c.id", "cm.class_id")
        .leftJoin("schools as s", (join) =>
          join
            .onRef("s.edu_office_code", "=", "c.edu_office_code")
            .onRef("s.school_code", "=", "c.school_code"),
        )
        .select((eb) => [
          "u.id",
          "u.display_name",
          "u.email_normalized",
          "u.is_active",
          "u.signup_approved_at",
          "u.signup_role",
          "u.created_at",
          "c.name as class_name",
          "s.school_name",
          this.isTeacher(eb).as("is_teacher"),
          eb
            .selectFrom("sessions as l")
            .select((inner) => inner.fn.max("l.issued_at").as("t"))
            .whereRef("l.user_id", "=", "u.id")
            .as("last_login_at"),
        ])
        .orderBy("u.created_at", "desc")
        .orderBy("u.id", "desc")
        .limit(ADMIN_PEOPLE_PAGE_SIZE)
        .offset((page - 1) * ADMIN_PEOPLE_PAGE_SIZE)
        .execute(),
    ]);
    return {
      people: rows.map((row) => ({
        id: String(row.id),
        display_name: row.display_name,
        email_masked: maskEmail(row.email_normalized),
        role: row.is_teacher ? "teacher" : "student",
        status: !row.is_active
          ? "inactive"
          : row.signup_approved_at === null && row.signup_role !== null
            ? "pending"
            : "active",
        created_at: toIso(row.created_at),
        last_login_at: row.last_login_at == null ? null : toIso(row.last_login_at),
        class_name: row.class_name ?? null,
        school_name: row.school_name ?? null,
      })),
      total: Number(totalRow.total),
      page,
      page_size: ADMIN_PEOPLE_PAGE_SIZE,
    };
  }

  // 선생님 = 선생님으로 가입했거나 선생님 자격이 있는 계정. 가입 유형이 비어 있어도 참/거짓만 나오게 쓴다.
  private isTeacher(eb: ExpressionBuilder<DB & { u: DB["users"] }, "u">) {
    return eb.or([
      eb.and([eb("u.signup_role", "is not", null), eb("u.signup_role", "=", "teacher")]),
      eb.exists(
        eb.selectFrom("teacher_profiles as tp").select("tp.id").whereRef("tp.user_id", "=", "u.id"),
      ),
    ]);
  }

  private filteredPeople(query: {
    search?: string | undefined;
    role?: AdminPersonRole | undefined;
    status?: AdminPersonStatus | undefined;
  }) {
    let people = this.db.selectFrom("users as u").where("u.deleted_at", "is", null);
    if (query.role === "teacher") people = people.where((eb) => this.isTeacher(eb));
    if (query.role === "student") people = people.where((eb) => eb.not(this.isTeacher(eb)));
    if (query.status === "inactive") people = people.where("u.is_active", "=", false);
    // 승인 대기는 한눈에 보기와 같은 기준: 가입 유형이 있는 계정 중 승인 전. 유형이 없는 예전 계정은 사용 중.
    if (query.status === "pending")
      people = people
        .where("u.is_active", "=", true)
        .where("u.signup_approved_at", "is", null)
        .where("u.signup_role", "is not", null);
    if (query.status === "active")
      people = people
        .where("u.is_active", "=", true)
        .where((eb) =>
          eb.or([eb("u.signup_approved_at", "is not", null), eb("u.signup_role", "is", null)]),
        );
    const search = query.search?.normalize("NFC").trim();
    if (search !== undefined && search.length > 0) {
      const pattern = `%${escapeLikePattern(search)}%`;
      people = people.where((eb) =>
        this.engine === "mariadb"
          ? sql<boolean>`(LOWER(u.display_name) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
            OR LOWER(u.email_normalized) LIKE LOWER(${pattern}) ESCAPE ${"\\"})`
          : eb.or([
              eb("u.display_name", "ilike", pattern),
              eb("u.email_normalized", "ilike", pattern),
            ]),
      );
    }
    return people;
  }

  private filteredClasses(search: string | undefined, status: AdminClassStatus | undefined) {
    let query = this.db
      .selectFrom("classes as c")
      .innerJoin("schools as s", (join) =>
        join
          .onRef("s.edu_office_code", "=", "c.edu_office_code")
          .onRef("s.school_code", "=", "c.school_code"),
      );
    if (status !== undefined) query = query.where("c.status", "=", status);
    if (search !== undefined && search.length > 0) {
      const pattern = `%${escapeLikePattern(search)}%`;
      query = query.where((eb) =>
        this.engine === "mariadb"
          ? sql<boolean>`(LOWER(s.school_name) LIKE LOWER(${pattern}) ESCAPE ${"\\"}
            OR LOWER(c.name) LIKE LOWER(${pattern}) ESCAPE ${"\\"})`
          : eb.or([eb("s.school_name", "ilike", pattern), eb("c.name", "ilike", pattern)]),
      );
    }
    return query;
  }
}
