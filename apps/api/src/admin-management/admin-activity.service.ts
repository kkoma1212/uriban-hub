import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { DB } from "@classhub/db";
import { sql, type ExpressionBuilder } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AdminActivityDays } from "./admin-directory.dto.js";

export const ADMIN_ACTIVITY_PAGE_SIZE = 20;

/** 반 활동 수: 기간 안에 새로 생긴 건수만(글 내용·작성자 없음). 반 대화가 꺼져 있으면 null. */
export interface AdminActivityCounts {
  notices: number;
  schedules: number;
  supplies: number;
  attendance: number;
  polls: number;
  help_requests: number;
  class_chat_messages: number | null;
  /** 기간 안에 한 번이라도 로그인한 이 반 학생 수 */
  active_students: number;
}

export interface AdminClassActivityRow extends AdminActivityCounts {
  id: string;
  name: string;
  school_name: string;
  students: number;
}

export interface AdminClassActivityList {
  days: AdminActivityDays;
  /** 운영 중인 반 전체의 기간 합계 */
  totals: AdminActivityCounts;
  classes: AdminClassActivityRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminActivityTrend {
  days: AdminActivityDays;
  /** 한국 날짜 YYYY-MM-DD(처음·마지막 날 포함) */
  from: string;
  to: string;
  series: Array<{ date: string; signups: number; activity: number }>;
}

// 일별 추이의 "활동" = 반 활동 현황과 같은 표·같은 기준(지운 글 제외). 반 대화는 켜졌을 때만 더한다.
const ACTIVITY_TABLES: ReadonlyArray<{ table: string; liveOnly: string | null }> = [
  { table: "notices", liveOnly: "deleted_at IS NULL" },
  { table: "schedules", liveOnly: "deleted_at IS NULL" },
  { table: "supplies", liveOnly: "deleted_at IS NULL" },
  { table: "attendance_notifications", liveOnly: null },
  { table: "polls", liveOnly: null },
  { table: "help_requests", liveOnly: null },
];

const COUNT_KEYS = [
  "notices",
  "schedules",
  "supplies",
  "attendance",
  "polls",
  "help_requests",
  "class_chat_messages",
  "active_students",
] as const;

type ClassScope = ExpressionBuilder<DB & { c: DB["classes"] }, "c">;

@Injectable()
export class AdminActivityService {
  private readonly db: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";
  private readonly classChatEnabled: boolean;

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid administrator activity database engine.");
    this.engine = engine;
    this.db = database;
    this.classChatEnabled = config.get("CLASS_CHAT_ENABLED", { infer: true }) === true;
  }

  async listClassActivity(query: {
    days?: AdminActivityDays | undefined;
    page?: number | undefined;
  }): Promise<AdminClassActivityList> {
    const days = query.days ?? 7;
    const page = query.page ?? 1;
    const since = this.daysAgo(days);
    // 운영 중인 반만 센다 — 지난 반·정지 반은 활동이 없는 게 정상이라 목록을 흐린다.
    const activeClasses = this.db
      .selectFrom("classes as c")
      .innerJoin("schools as s", (join) =>
        join
          .onRef("s.edu_office_code", "=", "c.edu_office_code")
          .onRef("s.school_code", "=", "c.school_code"),
      )
      .where("c.status", "=", "active");
    const perClass = activeClasses.select((eb) => [
      "c.id",
      "c.name",
      "c.created_at",
      "s.school_name",
      eb
        .selectFrom("class_members as m")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("m.class_id", "=", "c.id")
        .where("m.role", "=", "student")
        .where("m.status", "=", "approved")
        .as("students"),
      ...this.countColumns(eb, since),
    ]);
    const totalsQuery = this.db
      .selectFrom(perClass.as("a"))
      .select((eb) => COUNT_KEYS.map((key) => eb.fn.sum<string | null>(`a.${key}`).as(key)));
    const [totalRow, totalsRow, rows] = await Promise.all([
      activeClasses.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
      totalsQuery.executeTakeFirstOrThrow(),
      perClass
        .orderBy("c.created_at", "desc")
        .orderBy("c.id", "desc")
        .limit(ADMIN_ACTIVITY_PAGE_SIZE)
        .offset((page - 1) * ADMIN_ACTIVITY_PAGE_SIZE)
        .execute(),
    ]);
    return {
      days,
      totals: this.toCounts(totalsRow as Record<string, unknown>),
      classes: rows.map((row) => ({
        id: String(row.id),
        name: row.name,
        school_name: row.school_name,
        students: Number(row.students ?? 0),
        ...this.toCounts(row as Record<string, unknown>),
      })),
      total: Number(totalRow.total),
      page,
      page_size: ADMIN_ACTIVITY_PAGE_SIZE,
    };
  }

  // 반마다 기간 안의 새 건수. 지운 글·가린 대화는 세지 않는다.
  private countColumns(eb: ClassScope, since: ReturnType<AdminActivityService["daysAgo"]>) {
    const columns = [
      eb
        .selectFrom("notices as n")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("n.class_id", "=", "c.id")
        .where("n.deleted_at", "is", null)
        .where("n.created_at", ">=", since)
        .as("notices"),
      eb
        .selectFrom("schedules as sc")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("sc.class_id", "=", "c.id")
        .where("sc.deleted_at", "is", null)
        .where("sc.created_at", ">=", since)
        .as("schedules"),
      eb
        .selectFrom("supplies as su")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("su.class_id", "=", "c.id")
        .where("su.deleted_at", "is", null)
        .where("su.created_at", ">=", since)
        .as("supplies"),
      eb
        .selectFrom("attendance_notifications as an")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("an.class_id", "=", "c.id")
        .where("an.created_at", ">=", since)
        .as("attendance"),
      eb
        .selectFrom("polls as p")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("p.class_id", "=", "c.id")
        .where("p.created_at", ">=", since)
        .as("polls"),
      eb
        .selectFrom("help_requests as h")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("h.class_id", "=", "c.id")
        .where("h.created_at", ">=", since)
        .as("help_requests"),
      eb
        .selectFrom("class_members as am")
        .select((inner) => inner.fn.countAll().as("n"))
        .whereRef("am.class_id", "=", "c.id")
        .where("am.role", "=", "student")
        .where("am.status", "=", "approved")
        .where((inner) =>
          inner.exists(
            inner
              .selectFrom("sessions as l")
              .select("l.id")
              .whereRef("l.user_id", "=", "am.user_id")
              .where("l.issued_at", ">=", since),
          ),
        )
        .as("active_students"),
    ];
    // 반 대화 표는 기능을 켤 때만 설치된다 — 꺼져 있으면 묻지 않는다.
    return [
      ...columns,
      this.classChatEnabled
        ? eb
            .selectFrom("class_chat_messages as cm")
            .select((inner) => inner.fn.countAll().as("n"))
            .whereRef("cm.class_id", "=", "c.id")
            .where("cm.hidden_at", "is", null)
            .where("cm.created_at", ">=", since)
            .as("class_chat_messages")
        : // 합계(SUM)에 넣어도 형이 정해지도록 0으로 두고, 응답에서는 null로 바꾼다.
          sql<number>`0`.as("class_chat_messages"),
    ];
  }

  /** 한국 날짜 기준 하루마다 새 가입 수와 새 활동 건수(모든 반 합계). 빈 날도 0으로 채운다. */
  async activityTrend(query: {
    days?: AdminActivityDays | undefined;
  }): Promise<AdminActivityTrend> {
    const days = query.days ?? 7;
    const to = await readDatabaseKstToday(this.db, this.engine);
    const from = addCalendarDays(to, 1 - days);
    const tables = this.classChatEnabled
      ? [...ACTIVITY_TABLES, { table: "class_chat_messages", liveOnly: "hidden_at IS NULL" }]
      : ACTIVITY_TABLES;
    const [signups, ...activity] = await Promise.all([
      this.countByKstDay("users", "deleted_at IS NULL", from),
      ...tables.map(({ table, liveOnly }) => this.countByKstDay(table, liveOnly, from)),
    ]);
    const activityByDay = new Map<string, number>();
    for (const perTable of activity)
      for (const [day, n] of perTable) activityByDay.set(day, (activityByDay.get(day) ?? 0) + n);
    return {
      days,
      from,
      to,
      series: Array.from({ length: days }, (_, index) => {
        const date = addCalendarDays(from, index);
        return {
          date,
          signups: signups.get(date) ?? 0,
          activity: activityByDay.get(date) ?? 0,
        };
      }),
    };
  }

  // 표 이름·조건은 위 고정 목록에서만 온다(사용자 입력 없음). 시작일은 한국 자정을 UTC로 바꿔 비교한다.
  private async countByKstDay(
    table: string,
    liveOnly: string | null,
    from: string,
  ): Promise<Map<string, number>> {
    const day =
      this.engine === "mariadb"
        ? sql`DATE_FORMAT(created_at + INTERVAL 9 HOUR, '%Y-%m-%d')`
        : sql`to_char((created_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD')`;
    const start =
      this.engine === "mariadb"
        ? sql`CAST(${from} AS DATETIME(6)) - INTERVAL 9 HOUR`
        : sql`(CAST(${from} AS date)::timestamp AT TIME ZONE 'Asia/Seoul')`;
    const condition = liveOnly === null ? sql`` : sql` AND ${sql.raw(liveOnly)}`;
    const result = await sql<{ day: string; n: unknown }>`
      SELECT ${day} AS day, COUNT(*) AS n FROM ${sql.table(table)}
      WHERE created_at >= ${start}${condition}
      GROUP BY day`.execute(this.db);
    return new Map(result.rows.map((row) => [String(row.day), Number(row.n)]));
  }

  private toCounts(row: Record<string, unknown>): AdminActivityCounts {
    const count = (key: (typeof COUNT_KEYS)[number]) => Number(row[key] ?? 0);
    return {
      notices: count("notices"),
      schedules: count("schedules"),
      supplies: count("supplies"),
      attendance: count("attendance"),
      polls: count("polls"),
      help_requests: count("help_requests"),
      class_chat_messages: this.classChatEnabled ? count("class_chat_messages") : null,
      active_students: count("active_students"),
    };
  }

  private daysAgo(days: AdminActivityDays) {
    return this.engine === "mariadb"
      ? sql<Date>`UTC_TIMESTAMP(6) - INTERVAL ${sql.lit(days)} DAY`
      : sql<Date>`clock_timestamp() - ${sql.lit(days)} * INTERVAL '1 day'`;
  }
}
