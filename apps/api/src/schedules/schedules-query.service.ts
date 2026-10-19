import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays, databaseDate, startOfKstWeek } from "../common/date/kst-date.js";
import { normalizeSearchTerm, toIlikePattern } from "../common/validation/search-term.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { schedulesDatabase, scheduleDateSql, scheduleIdSql } from "./mariadb/schedules-dialect.js";
import { NeisSchoolSchedulesService } from "./neis-school-schedules.service.js";
import { SchedulesAccessService } from "./schedules-access.service.js";
import { assertScheduleCalendarRange } from "./schedules.calendar-range.js";
import { decodeScheduleListCursor, encodeScheduleListCursor } from "./schedules.cursor.js";
import type {
  GetScheduleCalendarQuery,
  GetScheduleQuery,
  ListSchedulesQuery,
  ListSchedulesResult,
  ScheduleCalendarHoliday,
  ScheduleCalendarItem,
  ScheduleCalendarResult,
  ScheduleItem,
} from "./schedules.types.js";
import {
  classScheduleCalendarItemView,
  scheduleItemView,
  schoolScheduleCalendarItemView,
  selectSchoolCalendarRows,
} from "./schedules.view.js";

const PAGE_SIZE = 20;

@Injectable()
export class SchedulesQueryService {
  private readonly database: ClassHubDatabase;
  private readonly engine: "postgres" | "mariadb";
  constructor(
    @Inject(DATABASE) database: ClassHubDatabase,
    private readonly access: SchedulesAccessService,
    @Optional() @Inject(ConfigService) environment?: ConfigService<AppEnvironment, true>,
    @Optional() private readonly neisSchoolSchedules?: NeisSchoolSchedulesService,
  ) {
    ({ database: this.database, engine: this.engine } = schedulesDatabase(database, environment));
  }

  async calendar(query: GetScheduleCalendarQuery): Promise<ScheduleCalendarResult> {
    assertScheduleCalendarRange(query.startDate, query.endDate);
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCollectionContext(query.actorUserId);
    const oldestVisibleDate = addCalendarDays(serverToday, -90);
    const effectiveStartDate =
      query.startDate < oldestVisibleDate ? oldestVisibleDate : query.startDate;
    /*
     * 공휴일은 90일 열람 제한을 적용하지 않는다. 그 제한은 **우리 반의 일정**을 얼마나
     * 거슬러 볼 수 있는가에 대한 정책인데, 법정공휴일은 전국 공개 정보라 가릴 것이 없다.
     * 제한을 걸면 지난달 달력에서 빨간 날만 사라져 화면이 고장난 것처럼 보인다.
     */
    const holidays = await this.readHolidays(query.startDate, query.endDate);
    if (effectiveStartDate > query.endDate) {
      return {
        end_date: query.endDate,
        holidays,
        items: [],
        oldest_visible_date: oldestVisibleDate,
        server_today: serverToday,
        start_date: query.startDate,
      };
    }
    const [classRows, storedSchoolRows, liveSchoolRows] = await Promise.all([
      this.database
        .selectFrom("schedules as schedule")
        .select([
          "schedule.description",
          "schedule.due_date",
          "schedule.id",
          "schedule.row_version",
          "schedule.schedule_type",
          "schedule.subject",
          "schedule.title",
        ])
        .where("schedule.class_id", "=", context.classId)
        .where("schedule.deleted_at", "is", null)
        .where("schedule.due_date", ">=", scheduleDateSql(effectiveStartDate, this.engine))
        .where("schedule.due_date", "<=", scheduleDateSql(query.endDate, this.engine))
        .orderBy("schedule.due_date", "asc")
        .orderBy("schedule.id", "asc")
        .execute(),
      this.database
        .selectFrom("school_schedule_events as event")
        .select([
          "event.event_content",
          "event.event_date",
          "event.event_name",
          "event.grade_mask",
          "event.id",
          "event.school_day_type",
          "event.source_loaded_on",
        ])
        .where("event.edu_office_code", "=", context.eduOfficeCode)
        .where("event.school_code", "=", context.schoolCode)
        .where("event.academic_year", "=", context.academicYear)
        .where(sql<boolean>`(event.grade_mask & ${1 << (context.grade - 1)}) <> 0`)
        .where("event.event_date", ">=", scheduleDateSql(effectiveStartDate, this.engine))
        .where("event.event_date", "<=", scheduleDateSql(query.endDate, this.engine))
        .orderBy("event.event_date", "asc")
        .orderBy("event.id", "asc")
        .execute(),
      this.neisSchoolSchedules?.academicYear(
        { eduOfficeCode: context.eduOfficeCode, schoolCode: context.schoolCode },
        context.academicYear,
      ),
    ]);
    const schoolRows = selectSchoolCalendarRows({
      stored: storedSchoolRows,
      live: liveSchoolRows,
      grade: context.grade,
      from: effectiveStartDate,
      to: query.endDate,
    });
    const items: ScheduleCalendarItem[] = [
      ...classRows.map((row) => classScheduleCalendarItemView(row, serverToday)),
      ...schoolRows.map((row) => schoolScheduleCalendarItemView(row, serverToday)),
    ].sort((left, right) => {
      const textOrder =
        left.due_date.localeCompare(right.due_date) || left.source.localeCompare(right.source);
      if (textOrder !== 0) return textOrder;
      return BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
    });

    return {
      end_date: query.endDate,
      holidays,
      items,
      oldest_visible_date: oldestVisibleDate,
      server_today: serverToday,
      start_date: query.startDate,
    };
  }

  /**
   * 요청한 범위의 법정공휴일. 반·학교와 무관한 전국 공통 값이라 접근 맥락을 보지 않는다.
   * 공급 계약이 아직 채워지지 않은 해는 빈 배열이 돌아가고, 달력은 주말만 구분한다.
   */
  private async readHolidays(
    startDate: string,
    endDate: string,
  ): Promise<ScheduleCalendarHoliday[]> {
    const rows = await this.database
      .selectFrom("public_holidays as holiday")
      .select([
        (this.engine === "mariadb"
          ? sql<string>`DATE_FORMAT(holiday.holiday_date,'%Y-%m-%d')`
          : sql<string>`holiday.holiday_date::text`
        ).as("date"),
        "holiday.name",
      ])
      .where("holiday.holiday_date", ">=", scheduleDateSql(startDate, this.engine))
      .where("holiday.holiday_date", "<=", scheduleDateSql(endDate, this.engine))
      .orderBy("holiday.holiday_date", "asc")
      .execute();
    return rows.map((row) => ({ date: row.date, name: row.name }));
  }

  async list(query: ListSchedulesQuery): Promise<ListSchedulesResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCollectionContext(query.actorUserId);
    const oldestPast = addCalendarDays(serverToday, -90);
    const dateRange =
      query.scope === "today"
        ? { start_date: serverToday, end_date: serverToday }
        : query.scope === "this_week"
          ? {
              start_date: startOfKstWeek(serverToday),
              end_date: addCalendarDays(startOfKstWeek(serverToday), 6),
            }
          : undefined;
    const search = normalizeSearchTerm(query.search);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeScheduleListCursor(
            query.cursor,
            query.scope,
            query.scheduleType,
            search,
            dateRange,
          );

    let builder = this.database
      .selectFrom("schedules as schedule")
      .select([
        "schedule.description",
        "schedule.due_date",
        "schedule.id",
        "schedule.row_version",
        "schedule.schedule_type",
        "schedule.subject",
        "schedule.title",
      ])
      .where("schedule.class_id", "=", context.classId)
      .where("schedule.deleted_at", "is", null);

    if (query.scheduleType !== undefined) {
      builder = builder.where("schedule.schedule_type", "=", query.scheduleType);
    }
    if (search !== undefined) {
      const pattern =
        this.engine === "mariadb"
          ? `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`
          : toIlikePattern(search);
      builder = builder.where(
        this.engine === "mariadb"
          ? sql<boolean>`(
          LOWER(schedule.subject) COLLATE utf8mb4_nopad_bin LIKE LOWER(${pattern}) ESCAPE '!'
          OR LOWER(schedule.title) COLLATE utf8mb4_nopad_bin LIKE LOWER(${pattern}) ESCAPE '!'
          OR LOWER(schedule.description) COLLATE utf8mb4_nopad_bin LIKE LOWER(${pattern}) ESCAPE '!'
        )`
          : sql<boolean>`(
          schedule.subject ILIKE ${pattern} ESCAPE '\\'
          OR schedule.title ILIKE ${pattern} ESCAPE '\\'
          OR schedule.description ILIKE ${pattern} ESCAPE '\\'
        )`,
      );
    }

    if (query.scope !== "past") {
      builder = builder.where(
        "schedule.due_date",
        ">=",
        scheduleDateSql(dateRange?.start_date ?? serverToday, this.engine),
      );
      if (dateRange !== undefined)
        builder = builder.where(
          "schedule.due_date",
          "<=",
          scheduleDateSql(dateRange.end_date, this.engine),
        );
      if (cursor !== undefined) {
        builder = builder.where(sql<boolean>`(
          schedule.due_date > ${scheduleDateSql(cursor.dueDate, this.engine)}
          OR (schedule.due_date = ${scheduleDateSql(cursor.dueDate, this.engine)} AND schedule.id > ${scheduleIdSql(cursor.id, this.engine)})
        )`);
      }
      builder = builder.orderBy("schedule.due_date", "asc").orderBy("schedule.id", "asc");
    } else {
      builder = builder
        .where("schedule.due_date", ">=", scheduleDateSql(oldestPast, this.engine))
        .where("schedule.due_date", "<", scheduleDateSql(serverToday, this.engine));
      if (cursor !== undefined) {
        builder = builder.where(sql<boolean>`(
          schedule.due_date < ${scheduleDateSql(cursor.dueDate, this.engine)}
          OR (schedule.due_date = ${scheduleDateSql(cursor.dueDate, this.engine)} AND schedule.id < ${scheduleIdSql(cursor.id, this.engine)})
        )`);
      }
      builder = builder.orderBy("schedule.due_date", "desc").orderBy("schedule.id", "desc");
    }

    const rows = await builder.limit(PAGE_SIZE + 1).execute();
    const pageRows = rows.slice(0, PAGE_SIZE);
    const items = pageRows.map((row): ScheduleItem => scheduleItemView(row, serverToday));
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > PAGE_SIZE && last !== undefined
        ? encodeScheduleListCursor({
            dueDate: databaseDate(last.due_date),
            id: last.id,
            scope: query.scope,
            ...(query.scheduleType === undefined ? {} : { scheduleType: query.scheduleType }),
            ...(search === undefined ? {} : { search }),
            ...(dateRange === undefined ? {} : { dateRange }),
          })
        : null;

    return {
      items,
      next_cursor: nextCursor,
      server_today: serverToday,
      ...(dateRange === undefined ? {} : { date_range: dateRange }),
    };
  }

  async get(query: GetScheduleQuery): Promise<ScheduleItem> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const { schedule } = await this.access.getResourceContext(
      query.actorUserId,
      query.scheduleId,
      serverToday,
    );
    return scheduleItemView(schedule, serverToday);
  }
}
