import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql, type RawBuilder } from "kysely";

import { mariaDbDateTime } from "../common/database/mariadb-values.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { adminError } from "./admin-error.js";

/*
 * 시범 판정 지표(전략서 '압도 조건 2', 2026-10-22 사용자 결정): 공지·준비물을 고친 뒤 24시간 안에
 * 이미 확인했던 학생이 다시 확인했는가. 학생 이름·번호는 돌려주지 않고 숫자만 센다.
 *
 * 자료의 한계(사용자 결정 '지금 자료로, 마지막 수정만'): 확인 기록은 학생마다 마지막 상태만 남는다
 * (notice_reads.confirmed_at·first_confirmed_at, supply_checks.checked_at). 그래서 글마다 '마지막으로
 * 판이 오른 수정'만 정확히 셀 수 있고, 같은 글의 앞선 수정은 earlier_revisions_excluded로만 센다.
 * 수정 시각은 감사 기록(notice.updated·supply.updated)에서 판 번호가 커진 행의 시각이다. 오타 수정은
 * 판 번호가 앞뒤 같고 중요 표시만 바꾼 수정은 판 번호가 없어 저절로 빠진다.
 *
 * - 대상(eligible): 그 수정 전에 이미 확인한(준비물은 챙김 표시를 한) 현재 승인 학생
 * - 재확인: 수정 뒤 새 판을 확인한(준비물은 새 판에 챙김 표시를 한) 학생 — 24시간 안 / 지금까지
 */
export const RECONFIRM_WINDOW_HOURS = 24;
export const RECONFIRM_REPORT_MAX_DAYS = 120;
const DEFAULT_REPORT_DAYS = 30;

export interface ReconfirmCounts {
  revisions: number;
  earlier_revisions_excluded: number;
  eligible: number;
  reconfirmed_within_window: number;
  reconfirmed_total: number;
}

export interface ReconfirmClassRow extends ReconfirmCounts {
  id: string;
  name: string;
  school_name: string;
}

export interface ReconfirmEventRow {
  class_id: string;
  kind: "notice" | "supply";
  item_id: string;
  revision: string;
  revised_at: string;
  eligible: number;
  reconfirmed_within_window: number;
  reconfirmed_total: number;
}

export interface AdminReconfirmReport {
  /** 한국 날짜 YYYY-MM-DD(처음·마지막 날 포함) */
  from: string;
  to: string;
  window_hours: number;
  totals: ReconfirmCounts;
  classes: ReconfirmClassRow[];
  events: ReconfirmEventRow[];
}

interface EventRow {
  class_id: unknown;
  item_id: unknown;
  revision: unknown;
  revised_at: unknown;
  latest: unknown;
  eligible: unknown;
  within_window: unknown;
  total: unknown;
}

/** 형식(YYYY-MM-DD)은 DTO가 본다. 여기서는 달력에 있는 날짜인지, 순서와 길이를 본다. */
function assertReportPeriod(from: string, to: string): void {
  const day = (value: string): number => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
      ? time / 86_400_000
      : Number.NaN;
  };
  const span = day(to) - day(from) + 1;
  if (!(span >= 1 && span <= RECONFIRM_REPORT_MAX_DAYS))
    throw adminError(BadRequestException, "ADMIN_REPORT_PERIOD_INVALID");
}

const EMPTY_COUNTS: ReconfirmCounts = {
  revisions: 0,
  earlier_revisions_excluded: 0,
  eligible: 0,
  reconfirmed_within_window: 0,
  reconfirmed_total: 0,
};

@Injectable()
export class AdminReconfirmReportService {
  private readonly db: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
  ) {
    const engine = config.get("DATABASE_ENGINE", { infer: true }) ?? "postgres";
    if (engine !== "postgres" && engine !== "mariadb")
      throw new Error("Invalid reconfirm report database engine.");
    this.engine = engine;
    this.db = database;
  }

  /** from·to는 검증된 한국 날짜(DTO). 없으면 오늘까지 최근 30일. */
  async report(query: {
    from?: string | undefined;
    to?: string | undefined;
  }): Promise<AdminReconfirmReport> {
    const to = query.to ?? (await readDatabaseKstToday(this.db, this.engine));
    const from = query.from ?? addCalendarDays(to, 1 - DEFAULT_REPORT_DAYS);
    assertReportPeriod(from, to);
    const start = this.kstMidnight(from);
    const end = this.kstMidnight(addCalendarDays(to, 1));
    const [notices, supplies] = await Promise.all([
      this.noticeEvents(start, end),
      this.supplyEvents(start, end),
    ]);
    const events = [
      ...notices.rows.map((row) => this.toEvent("notice", row)),
      ...supplies.rows.map((row) => this.toEvent("supply", row)),
    ];
    const byClass = new Map<string, ReconfirmCounts>();
    const totals = { ...EMPTY_COUNTS };
    for (const event of events) {
      const counts = byClass.get(event.class_id) ?? { ...EMPTY_COUNTS };
      for (const target of [counts, totals]) {
        if (!event.latest) {
          target.earlier_revisions_excluded += 1;
          continue;
        }
        target.revisions += 1;
        target.eligible += event.eligible;
        target.reconfirmed_within_window += event.reconfirmed_within_window;
        target.reconfirmed_total += event.reconfirmed_total;
      }
      byClass.set(event.class_id, counts);
    }
    return {
      from,
      to,
      window_hours: RECONFIRM_WINDOW_HOURS,
      totals,
      classes: await this.classRows(byClass),
      events: events
        .filter((event) => event.latest)
        .map(({ latest: _latest, ...event }) => event)
        .sort((a, b) => a.revised_at.localeCompare(b.revised_at)),
    };
  }

  private noticeEvents(start: RawBuilder<unknown>, end: RawBuilder<unknown>) {
    const windowEnd = this.windowEnd();
    return sql<EventRow>`
      SELECT a.class_id, n.id AS item_id, n.content_revision AS revision, a.created_at AS revised_at,
        CASE WHEN n.deleted_at IS NULL AND ${this.revisionIn("a.after_json")} = n.content_revision
          THEN 1 ELSE 0 END AS latest,
        (SELECT COUNT(*) FROM notice_reads r
          JOIN class_members m ON m.id = r.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE r.notice_id = n.id AND r.first_confirmed_at < a.created_at) AS eligible,
        (SELECT COUNT(*) FROM notice_reads r
          JOIN class_members m ON m.id = r.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE r.notice_id = n.id AND r.first_confirmed_at < a.created_at
            AND r.confirmed_revision = n.content_revision AND r.confirmed_at > a.created_at
            AND r.confirmed_at <= ${windowEnd}) AS within_window,
        (SELECT COUNT(*) FROM notice_reads r
          JOIN class_members m ON m.id = r.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE r.notice_id = n.id AND r.first_confirmed_at < a.created_at
            AND r.confirmed_revision = n.content_revision AND r.confirmed_at > a.created_at) AS total
      FROM audit_logs a
      JOIN notices n ON ${this.targetMatches("n")} AND n.class_id = a.class_id
      WHERE a.action = 'notice.updated' AND a.created_at >= ${start} AND a.created_at < ${end}
        AND ${this.revisionIn("a.after_json")} > ${this.revisionIn("a.before_json")}`.execute(
      this.db,
    );
  }

  private supplyEvents(start: RawBuilder<unknown>, end: RawBuilder<unknown>) {
    const windowEnd = this.windowEnd();
    // 준비물은 '확인' 대신 '챙김 표시'다. 수정 전에 체크 기록을 만든 학생을 대상으로, 새 판에 다시 챙김
    // 표시를 했는지 본다(수정 직전에 해제해 둔 경우는 구별할 자료가 없어 대상에 남는다).
    return sql<EventRow>`
      SELECT a.class_id, s.id AS item_id, s.content_revision AS revision, a.created_at AS revised_at,
        CASE WHEN s.deleted_at IS NULL AND ${this.revisionIn("a.after_json")} = s.content_revision
          THEN 1 ELSE 0 END AS latest,
        (SELECT COUNT(*) FROM supply_checks k
          JOIN class_members m ON m.id = k.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE k.supply_id = s.id AND k.created_at < a.created_at) AS eligible,
        (SELECT COUNT(*) FROM supply_checks k
          JOIN class_members m ON m.id = k.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE k.supply_id = s.id AND k.created_at < a.created_at AND k.is_checked = TRUE
            AND k.confirmed_revision = s.content_revision AND k.checked_at > a.created_at
            AND k.checked_at <= ${windowEnd}) AS within_window,
        (SELECT COUNT(*) FROM supply_checks k
          JOIN class_members m ON m.id = k.member_id AND m.status = 'approved' AND m.role = 'student'
          WHERE k.supply_id = s.id AND k.created_at < a.created_at AND k.is_checked = TRUE
            AND k.confirmed_revision = s.content_revision AND k.checked_at > a.created_at) AS total
      FROM audit_logs a
      JOIN supplies s ON ${this.targetMatches("s")} AND s.class_id = a.class_id
      WHERE a.action = 'supply.updated' AND a.created_at >= ${start} AND a.created_at < ${end}
        AND ${this.revisionIn("a.after_json")} > ${this.revisionIn("a.before_json")}`.execute(
      this.db,
    );
  }

  private async classRows(byClass: Map<string, ReconfirmCounts>): Promise<ReconfirmClassRow[]> {
    if (byClass.size === 0) return [];
    const rows = await this.db
      .selectFrom("classes as c")
      .innerJoin("schools as sc", (join) =>
        join
          .onRef("sc.edu_office_code", "=", "c.edu_office_code")
          .onRef("sc.school_code", "=", "c.school_code"),
      )
      .select(["c.id", "c.name", "sc.school_name"])
      .where("c.id", "in", [...byClass.keys()])
      .orderBy("c.id")
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      school_name: row.school_name,
      ...(byClass.get(String(row.id)) ?? EMPTY_COUNTS),
    }));
  }

  private toEvent(
    kind: "notice" | "supply",
    row: EventRow,
  ): ReconfirmEventRow & { latest: boolean } {
    return {
      class_id: String(row.class_id),
      kind,
      item_id: String(row.item_id),
      revision: String(row.revision),
      // MariaDB 연결은 시각을 시간대 없는 UTC 글자로 준다(dateStrings) — 그대로 Date로 읽으면 PC 시간대로 어긋난다.
      revised_at: (this.engine === "mariadb"
        ? mariaDbDateTime(row.revised_at)
        : new Date(row.revised_at as string | Date)
      ).toISOString(),
      latest: Number(row.latest) === 1,
      eligible: Number(row.eligible),
      reconfirmed_within_window: Number(row.within_window),
      reconfirmed_total: Number(row.total),
    };
  }

  // 감사 JSON의 판 번호. 키가 없으면(중요 표시만 바꾼 수정) NULL이라 비교에서 빠진다.
  private revisionIn(column: "a.after_json" | "a.before_json"): RawBuilder<number> {
    return this.engine === "mariadb"
      ? sql<number>`CAST(JSON_UNQUOTE(JSON_EXTRACT(${sql.raw(column)}, '$.content_revision')) AS UNSIGNED)`
      : sql<number>`CAST(${sql.raw(column)}->>'content_revision' AS BIGINT)`;
  }

  // audit_logs.target_id는 글자형, 글 번호는 정수형이다. MariaDB는 글자 쪽을 숫자로 바꿔야 정렬 규칙
  // (collation)이 섞이지 않고, PostgreSQL은 숫자가 아닌 target_id가 있으면 숫자 변환이 오류라 글자로 맞춘다.
  private targetMatches(alias: "n" | "s"): RawBuilder<boolean> {
    return this.engine === "mariadb"
      ? sql<boolean>`CAST(a.target_id AS UNSIGNED) = ${sql.raw(`${alias}.id`)}`
      : sql<boolean>`CAST(${sql.raw(`${alias}.id`)} AS TEXT) = a.target_id`;
  }

  private windowEnd(): RawBuilder<Date> {
    return this.engine === "mariadb"
      ? sql<Date>`a.created_at + INTERVAL ${sql.lit(RECONFIRM_WINDOW_HOURS)} HOUR`
      : sql<Date>`a.created_at + ${sql.lit(RECONFIRM_WINDOW_HOURS)} * INTERVAL '1 hour'`;
  }

  // 한국 자정을 UTC로 바꿔 감사 기록 시각과 비교한다(admin-activity.service.ts와 같은 방식).
  private kstMidnight(date: string): RawBuilder<Date> {
    return this.engine === "mariadb"
      ? sql<Date>`CAST(${date} AS DATETIME(6)) - INTERVAL 9 HOUR`
      : sql<Date>`(CAST(${date} AS date)::timestamp AT TIME ZONE 'Asia/Seoul')`;
  }
}
