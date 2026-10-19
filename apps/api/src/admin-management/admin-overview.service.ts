import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import {
  serverErrorsInLastHour,
  serverStartedAt,
} from "../common/observability/server-error-window.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { adminManagementMariaDbCodec } from "./admin-management.database.js";

/** 관리자 첫 화면 "한눈에 보기": 개인 정보 없이 숫자만 모은다. */
export interface AdminOverview {
  generated_at: string;
  signups: {
    /** 관리자 승인을 기다리는 선생님 가입 */
    pending_teachers: number;
    /** 메일 인증 전인 학생 가입 */
    pending_students: number;
    new_last_7_days: number;
  };
  scale: {
    schools: number;
    active_classes: number;
    teachers: number;
    students: number;
    active_users: number;
  };
  server: {
    api_surface: AppEnvironment["API_SURFACE"];
    started_at: string;
    database_ms: number | null;
    redis_ok: boolean;
    maintenance_mode: boolean | null;
    /** 이 서버가 켜진 뒤 최근 1시간의 5xx 응답 수(재시작하면 0부터) */
    errors_last_hour: number;
    memory_mb: number;
  };
  support: {
    inquiries_open: number;
    inquiries_in_progress: number;
    /** 반 대화가 꺼져 있으면 null */
    class_chat_reports_open: number | null;
  };
}

type Engine = "postgres" | "mariadb";

@Injectable()
export class AdminOverviewService {
  private readonly db: ClassHubDatabase;
  private readonly engine: Engine;
  private readonly classChatEnabled: boolean;
  private readonly apiSurface: AppEnvironment["API_SURFACE"];

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator overview database engine.");
    this.engine = engine;
    this.apiSurface = config.get("API_SURFACE", { infer: true }) ?? "all";
    this.db = engine === "mariadb" ? database.withPlugin(adminManagementMariaDbCodec) : database;
    this.classChatEnabled = config.get("CLASS_CHAT_ENABLED", { infer: true }) === true;
  }

  async overview(): Promise<AdminOverview> {
    const [signups, scale, server, support] = await Promise.all([
      this.signups(),
      this.scale(),
      this.server(),
      this.support(),
    ]);
    return { generated_at: new Date().toISOString(), signups, scale, server, support };
  }

  private async signups(): Promise<AdminOverview["signups"]> {
    const pending = await this.db
      .selectFrom("users")
      .select(["signup_role", (eb) => eb.fn.countAll().as("total")])
      .where("deleted_at", "is", null)
      .where("is_active", "=", true)
      .where("signup_approved_at", "is", null)
      .where("signup_role", "in", ["teacher", "student"])
      .groupBy("signup_role")
      .execute();
    const recent = await this.db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll().as("total"))
      .where("deleted_at", "is", null)
      .where("created_at", ">=", this.daysAgo(7))
      .executeTakeFirstOrThrow();
    const byRole = (role: string) =>
      Number(pending.find((row) => row.signup_role === role)?.total ?? 0);
    return {
      pending_teachers: byRole("teacher"),
      pending_students: byRole("student"),
      new_last_7_days: Number(recent.total),
    };
  }

  private async scale(): Promise<AdminOverview["scale"]> {
    const count = async (query: { executeTakeFirstOrThrow(): Promise<{ total: unknown }> }) =>
      Number((await query.executeTakeFirstOrThrow()).total);
    const activeSchools = this.db
      .selectFrom("classes")
      .select(["edu_office_code", "school_code"])
      .distinct()
      .where("status", "=", "active")
      .as("school");
    const [schools, activeClasses, teachers, students, activeUsers] = await Promise.all([
      count(this.db.selectFrom(activeSchools).select((eb) => eb.fn.countAll().as("total"))),
      count(
        this.db
          .selectFrom("classes")
          .select((eb) => eb.fn.countAll().as("total"))
          .where("status", "=", "active"),
      ),
      count(
        this.db
          .selectFrom("teacher_profiles")
          .innerJoin("users", "users.id", "teacher_profiles.user_id")
          .select((eb) => eb.fn.countAll().as("total"))
          .where("teacher_profiles.status", "=", "active")
          .where("users.deleted_at", "is", null),
      ),
      count(
        this.db
          .selectFrom("class_members")
          .innerJoin("classes", "classes.id", "class_members.class_id")
          .select((eb) => eb.fn.countAll().as("total"))
          .where("class_members.role", "=", "student")
          .where("class_members.status", "=", "approved")
          .where("classes.status", "=", "active"),
      ),
      count(
        this.db
          .selectFrom("users")
          .select((eb) => eb.fn.countAll().as("total"))
          .where("deleted_at", "is", null)
          .where("is_active", "=", true),
      ),
    ]);
    return {
      schools,
      active_classes: activeClasses,
      teachers,
      students,
      active_users: activeUsers,
    };
  }

  private async server(): Promise<AdminOverview["server"]> {
    let databaseMs: number | null = null;
    try {
      const started = performance.now();
      await sql`SELECT 1`.execute(this.db);
      databaseMs = Math.round(performance.now() - started);
    } catch {
      databaseMs = null;
    }
    const redisOk = await this.rateLimiter.ensureAvailable().then(
      () => true,
      () => false,
    );
    const maintenance = await this.db
      .selectFrom("admin_system_state")
      .select("value_json")
      .where("key", "=", "maintenance_mode")
      .executeTakeFirst()
      .catch(() => null);
    const value = maintenance?.value_json as { enabled?: unknown } | null | undefined;
    return {
      api_surface: this.apiSurface,
      started_at: serverStartedAt().toISOString(),
      database_ms: databaseMs,
      redis_ok: redisOk,
      maintenance_mode: maintenance === null ? null : value?.enabled === true,
      errors_last_hour: serverErrorsInLastHour(),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }

  private async support(): Promise<AdminOverview["support"]> {
    const inquiries = await this.db
      .selectFrom("admin_inquiries")
      .select(["status", (eb) => eb.fn.countAll().as("total")])
      .where("status", "in", ["open", "in_progress"])
      .groupBy("status")
      .execute();
    const byStatus = (status: string) =>
      Number(inquiries.find((row) => row.status === status)?.total ?? 0);
    // 반 대화 표는 기능을 켤 때만 설치된다 — 꺼져 있으면 묻지 않는다.
    const reports = this.classChatEnabled
      ? Number(
          (
            await this.db
              .selectFrom("class_chat_reports")
              .select((eb) => eb.fn.countAll().as("total"))
              .where("resolved_at", "is", null)
              .executeTakeFirstOrThrow()
          ).total,
        )
      : null;
    return {
      inquiries_open: byStatus("open"),
      inquiries_in_progress: byStatus("in_progress"),
      class_chat_reports_open: reports,
    };
  }

  private daysAgo(days: number) {
    return this.engine === "mariadb"
      ? sql<Date>`UTC_TIMESTAMP(6) - INTERVAL ${sql.lit(days)} DAY`
      : sql<Date>`clock_timestamp() - ${sql.lit(days)} * INTERVAL '1 day'`;
  }
}
