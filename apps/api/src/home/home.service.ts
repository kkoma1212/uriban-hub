import { HttpException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";

import {
  emptyAttendanceCounts,
  readAttendanceTodayCounts,
  readStudentAttendanceToday,
} from "../attendance-notifications/attendance-notifications.read.js";
import type {
  AttendanceCounts,
  AttendanceNotificationItem,
} from "../attendance-notifications/attendance-notifications.types.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays, calendarDayDifference, databaseDate } from "../common/date/kst-date.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { parseMealMenu } from "../meals/meals.menu.js";
import { MealsService } from "../meals/meals.service.js";
import { UpdatesService } from "../updates/updates.service.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  homeDatabaseEngine,
  homeDate,
  homeBigint,
  homeCurrentTimestamp,
  homeNoticeVisibleSince,
  homeMariaDbRowCodec,
  type HomeDatabaseEngine,
} from "./home.database.js";
import { readHomeReminders } from "./home-reminders.read.js";
import { readHomeBirthdays } from "./home-birthdays.read.js";
import { readHomeTeacherFollowups } from "./home-followups.read.js";
import {
  HomeClassSuspendedException,
  HomeNotFoundException,
  HomeRoleInsufficientException,
  HomeUnavailableException,
} from "./home.errors.js";
import type {
  CheckState,
  ConfirmationState,
  HomeCard,
  HomeMeal,
  HomeMealMenuItem,
  HomeNotice,
  HomePoll,
  HomeResult,
  HomeSchedule,
  HomeSupply,
  TeacherHomeFollowup,
} from "./home.types.js";

interface HomeContext {
  classId: string;
  classStatus: string;
  eduOfficeCode: string;
  memberId: string;
  role: "student" | "teacher";
  schoolCode: string;
}

export const HOME_ATTENDANCE_NOTIFICATIONS_ENABLED = Symbol(
  "HOME_ATTENDANCE_NOTIFICATIONS_ENABLED",
);
export const HOME_POLLS_ENABLED = Symbol("HOME_POLLS_ENABLED");
export const HOME_ELECTIONS_ENABLED = Symbol("HOME_ELECTIONS_ENABLED");

function confirmationState(
  confirmedRevision: string | null,
  contentRevision: string,
): ConfirmationState {
  if (confirmedRevision === null) return "unread";
  return confirmedRevision === contentRevision ? "confirmed" : "modified_unconfirmed";
}

function checkState(
  isChecked: boolean | null,
  confirmedRevision: string | null,
  contentRevision: string,
): CheckState {
  if (isChecked !== true || confirmedRevision === null) return "unchecked";
  return confirmedRevision === contentRevision ? "checked" : "modified_unconfirmed";
}

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);
  private readonly dialect: HomeDatabaseEngine;
  private readonly birthDatesInstalled: boolean;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    @Inject(HOME_ATTENDANCE_NOTIFICATIONS_ENABLED)
    private readonly attendanceNotificationsEnabled: boolean,
    @Inject(HOME_POLLS_ENABLED)
    private readonly pollsEnabled = false,
    @Inject(HOME_ELECTIONS_ENABLED)
    private readonly electionsEnabled = false,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
    @Optional() private readonly meals?: MealsService,
    @Optional() private readonly updates?: UpdatesService,
  ) {
    this.dialect = homeDatabaseEngine(config);
    this.birthDatesInstalled =
      config?.get("USER_BIRTH_DATES_DATABASE_INSTALLED", { infer: true }) === true;
    if (this.dialect === "mariadb") this.database = database.withPlugin(homeMariaDbRowCodec);
  }

  async getForUser(userId: string): Promise<HomeResult> {
    // A dashboard must not fan out into many guarded MariaDB pool leases.
    // Keep the verified lease for this request only; queries and row visibility
    // remain unchanged, and the driver still cleans up before returning it.
    let read: { home: HomeResult; student: boolean };
    if (this.dialect === "mariadb") {
      try {
        read = await this.database
          .connection()
          .execute((database) => this.readForUser(userId, database));
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw new HomeUnavailableException();
      }
    } else read = await this.readForUser(userId, this.database);
    if (!read.student) return read.home;
    // 학생의 '아직 안 본 것'은 소식 탭과 같은 기준으로 센다(2026-10-03 총검수 B2-01). 홈 연결을
    // 돌려준 뒤에 세어 한 요청이 연결을 둘 쥐지 않게 한다. 못 세면 null — 화면은 숫자를 지어내지 않는다.
    return { ...read.home, unresolved_count: await this.unresolvedCount(userId) };
  }

  private async unresolvedCount(userId: string): Promise<number | null> {
    if (this.updates === undefined) return null;
    try {
      const result = await this.updates.list({ actorUserId: userId, filter: "unresolved" });
      return result.unresolved_count ?? null;
    } catch {
      return null;
    }
  }

  private async readForUser(
    userId: string,
    database: ClassHubDatabase,
  ): Promise<{ home: HomeResult; student: boolean }> {
    const context = await this.getContext(userId, database);
    let serverToday: string;
    try {
      serverToday = await readDatabaseKstToday(database, this.dialect);
    } catch {
      throw new HomeUnavailableException();
    }
    const tomorrow = addCalendarDays(serverToday, 1);
    const teacherFollowupsPromise =
      context.role === "teacher"
        ? this.card<TeacherHomeFollowup[]>(
            [],
            (data) => data.length === 0,
            "FOLLOWUP_QUERY_FAILED",
            "후속 처리 현황을 불러오지 못했어요.",
            () =>
              readHomeTeacherFollowups(
                database,
                context.classId,
                serverToday,
                tomorrow,
                this.dialect,
              ),
          )
        : Promise.resolve(null);
    const attendancePromise = this.attendanceNotificationsEnabled
      ? context.role === "student"
        ? this.card<AttendanceNotificationItem | null>(
            null,
            (data) => data === null,
            "ATTENDANCE_QUERY_FAILED",
            "출결 연락을 불러오지 못했어요.",
            () =>
              readStudentAttendanceToday(
                database,
                {
                  classId: context.classId,
                  memberId: context.memberId,
                  serverToday,
                },
                this.dialect,
              ),
          )
        : this.card<AttendanceCounts>(
            emptyAttendanceCounts(),
            (data) => data.total === 0,
            "ATTENDANCE_QUERY_FAILED",
            "출결 현황을 불러오지 못했어요.",
            () =>
              readAttendanceTodayCounts(
                database,
                {
                  classId: context.classId,
                  serverToday,
                },
                this.dialect,
              ),
          )
      : Promise.resolve(undefined);
    /* 이 칸은 투표와 선거를 함께 싣는다 — 둘 중 하나만 켜져 있어도 칸을 낸다. */
    const pollsPromise =
      this.pollsEnabled || this.electionsEnabled
        ? this.card(
            [],
            (data) => data.length === 0,
            "POLL_QUERY_FAILED",
            "진행 중인 투표를 불러오지 못했어요.",
            () => this.getPolls(context, database),
          )
        : Promise.resolve(undefined);
    const birthdaysPromise = this.birthDatesInstalled
      ? this.card(
          [],
          (data) => data.length === 0,
          "BIRTHDAY_QUERY_FAILED",
          "오늘 생일을 불러오지 못했어요.",
          () => readHomeBirthdays(database, context.classId, serverToday, this.dialect),
        )
      : Promise.resolve(undefined);
    const [
      meal,
      supplies,
      notices,
      reminders,
      attendance,
      schedules,
      teacherFollowups,
      polls,
      birthdays,
    ] = await Promise.all([
      this.card(
        null,
        (data) => data === null,
        "MEAL_QUERY_FAILED",
        "급식을 불러오지 못했어요.",
        () => this.getMeal(context, serverToday, database),
      ),
      this.card(
        [],
        (data) => data.length === 0,
        "SUPPLY_QUERY_FAILED",
        "준비물을 불러오지 못했어요.",
        () => this.getSupplies(context, serverToday, tomorrow, database),
      ),
      this.card(
        [],
        (data) => data.length === 0,
        "NOTICE_QUERY_FAILED",
        "공지를 불러오지 못했어요.",
        () => this.getNotices(context, database),
      ),
      this.card(
        [],
        (data) => data.length === 0,
        "REMINDER_QUERY_FAILED",
        "재알림을 불러오지 못했습니다.",
        () => readHomeReminders(database, context, serverToday, this.dialect),
      ),
      attendancePromise,
      this.card(
        [],
        (data) => data.length === 0,
        "SCHEDULE_QUERY_FAILED",
        "일정을 불러오지 못했어요.",
        () => this.getSchedules(context, serverToday, database),
      ),
      teacherFollowupsPromise,
      pollsPromise,
      birthdaysPromise,
    ]);

    if (
      meal.status === "error" &&
      supplies.status === "error" &&
      notices.status === "error" &&
      schedules.status === "error" &&
      (teacherFollowups === null || teacherFollowups.status === "error") &&
      (attendance === undefined || attendance.status === "error")
    ) {
      throw new HomeUnavailableException();
    }

    let pendingMemberCount: number | null = null;
    let activeStudentCount: number | undefined;
    if (context.role === "teacher") {
      try {
        // 승인 학생 수는 반 관리(classes.service)와 같은 기준이다. 빈 반 교사 홈에 학생 초대 안내를
        // 보이려고 함께 센다(2026-10-21 첫 사용 점검). 상태별로 묶어 한 번만 조회한다.
        const counts = await database
          .selectFrom("class_members as member")
          .innerJoin("users as account", "account.id", "member.user_id")
          .select((expression) => ["member.status", expression.fn.countAll<string>().as("count")])
          .where("member.class_id", "=", context.classId)
          .where("member.role", "=", "student")
          .where("member.status", "in", ["pending", "approved"])
          .where("account.is_active", "=", true)
          .where("account.deleted_at", "is", null)
          .groupBy("member.status")
          .execute();
        const countFor = (status: string) =>
          Number(counts.find((row) => row.status === status)?.count ?? 0);
        pendingMemberCount = countFor("pending");
        activeStudentCount = countFor("approved");
      } catch {
        throw new HomeUnavailableException();
      }
    }

    const home: HomeResult = {
      ...(activeStudentCount === undefined ? {} : { active_student_count: activeStudentCount }),
      ...(attendance === undefined ? {} : { attendance }),
      ...(birthdays === undefined ? {} : { birthdays }),
      meal,
      notices,
      pending_member_count: pendingMemberCount,
      ...(polls === undefined ? {} : { polls }),
      reminders,
      schedules,
      server_today: serverToday,
      supplies,
      teacher_followups: teacherFollowups,
    };
    return { home, student: context.role === "student" };
  }

  private async getContext(userId: string, database: ClassHubDatabase): Promise<HomeContext> {
    let context;
    try {
      context = await database
        .selectFrom("class_members as member")
        .innerJoin("classes as class", "class.id", "member.class_id")
        .innerJoin("users as account", "account.id", "member.user_id")
        .leftJoin("teacher_profiles as profile", "profile.user_id", "member.user_id")
        .select([
          "account.deleted_at",
          "account.is_active",
          "class.edu_office_code",
          "class.id as class_id",
          "class.school_code",
          "class.status as class_status",
          "member.id as member_id",
          "member.role",
          "profile.status as profile_status",
          "profile.temporary_password_must_change",
        ])
        .where("member.user_id", "=", userId)
        .where("member.status", "=", "approved")
        .executeTakeFirst();
    } catch {
      throw new HomeUnavailableException();
    }
    if (context === undefined || !context.is_active || context.deleted_at !== null) {
      throw new HomeNotFoundException();
    }
    if (context.class_status === "suspended") throw new HomeClassSuspendedException();
    if (context.class_status !== "active") throw new HomeNotFoundException();
    if (
      context.role === "teacher" &&
      (context.profile_status !== "active" || context.temporary_password_must_change !== false)
    ) {
      throw new HomeRoleInsufficientException();
    }
    if (context.role !== "student" && context.role !== "teacher") {
      throw new HomeRoleInsufficientException();
    }
    return {
      classId: context.class_id,
      classStatus: context.class_status,
      eduOfficeCode: context.edu_office_code,
      memberId: context.member_id,
      role: context.role,
      schoolCode: context.school_code,
    };
  }

  private async getMeal(
    context: HomeContext,
    today: string,
    database: ClassHubDatabase,
  ): Promise<HomeMeal | null> {
    const row = await database
      .selectFrom("meals")
      .select([
        "calorie_kcal_tenths",
        "id",
        "meal_date",
        "menu_json",
        "source",
        "source_loaded_on",
        "source_updated_at",
      ])
      .where("edu_office_code", "=", context.eduOfficeCode)
      .where("school_code", "=", context.schoolCode)
      .where("meal_date", "=", homeDate(today, this.dialect))
      .where("meal_type", "=", "lunch")
      .executeTakeFirst();
    // 급식 탭과 같은 규칙(나이스 실시간 우선)을 쓴다. 급식 모듈이 없을 때(단위 시험)만 저장본 그대로.
    if (this.meals !== undefined)
      return (await this.meals.resolveSchoolLunch(
        row,
        { eduOfficeCode: context.eduOfficeCode, schoolCode: context.schoolCode },
        today,
      )) as HomeMeal | null;
    return row === undefined
      ? null
      : {
          calorie_kcal: row.calorie_kcal_tenths === null ? null : row.calorie_kcal_tenths / 10,
          id: row.id,
          meal_date: databaseDate(row.meal_date),
          menu: parseMealMenu(row.menu_json) as HomeMealMenuItem[],
          source: row.source as HomeMeal["source"],
          source_loaded_on:
            row.source_loaded_on === null ? null : databaseDate(row.source_loaded_on),
          source_updated_at: row.source_updated_at.toISOString(),
        };
  }

  private async getSupplies(
    context: HomeContext,
    today: string,
    tomorrow: string,
    database: ClassHubDatabase,
  ): Promise<HomeSupply[]> {
    let builder = database
      .selectFrom("supplies as supply")
      .leftJoin("supply_checks as check", (join) =>
        join
          .onRef("check.supply_id", "=", "supply.id")
          .on("check.member_id", "=", context.memberId),
      )
      .select([
        "check.confirmed_revision",
        "check.is_checked",
        "supply.category",
        "supply.content_revision",
        "supply.created_at",
        "supply.description",
        "supply.id",
        "supply.needed_on",
        "supply.title",
      ])
      .where("supply.class_id", "=", context.classId)
      .where("supply.deleted_at", "is", null)
      /*
       * 준비물과 숙제는 미리 알아야 하는 기간이 다르다. 준비물은 "내일 가져올 것"이라
       * 하루 전에 알면 되지만, 숙제는 미리 알아야 계획해서 한다 — 오늘·내일만
       * 보여주면 학생이 홈만 보고는 마감 하루 전에야 알게 된다(2026-08-10 Hex 지적).
       *
       * 숙제에는 **날짜 상한을 두지 않는다.** 처음엔 7일로 잘랐다가, 방학 중에 개학
       * 다음 날 숙제를 올리는 실제 사용을 못 덮는 것을 보고 걷어냈다 — 어떤 숫자를
       * 골라도 언젠가 빗나간다. 홈이 답할 질문은 "7일 안에 뭐가 있지"가 아니라
       * "다음에 해야 할 숙제가 뭐지"다. 아래 orderBy + limit 이 가까운 것부터 몇 건만
       * 실으므로 목록이 넘치지 않는다. 공지·투표·일정도 원래 이 방식이다.
       *
       * 준비물은 그대로 둔다. 여기까지 넓히면 "내일 가져올 것"의 급한 느낌이 흐려진다.
       */
      .where(
        sql<boolean>`(
          (supply.category = 'homework' AND supply.needed_on >= ${homeDate(today, this.dialect)})
          OR (supply.category <> 'homework'
            AND supply.needed_on IN (${homeDate(today, this.dialect)}, ${homeDate(tomorrow, this.dialect)}))
        )`,
      );
    if (context.role === "student") {
      builder = builder.where(sql<boolean>`(
        supply.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM supply_recipients AS audience_recipient
          WHERE audience_recipient.supply_id = supply.id
            AND audience_recipient.class_id = supply.class_id
            AND audience_recipient.member_id = ${homeBigint(context.memberId, this.dialect)}
        )
      )`);
    }
    // 각각 가까운3개를 고르되 최종 정렬은 DB가 DATETIME(6) 정밀도로 수행한다.
    const rows =
      context.role === "student"
        ? await database
            .selectFrom(
              builder
                .select(
                  sql<number>`ROW_NUMBER() OVER (
            PARTITION BY supply.category
            ORDER BY supply.needed_on ASC, supply.created_at DESC, supply.id DESC
          )`.as("category_rank"),
                )
                .as("ranked_supply"),
            )
            .selectAll()
            .where("ranked_supply.category_rank", "<=", 3)
            .orderBy("ranked_supply.needed_on", "asc")
            .orderBy("ranked_supply.created_at", "desc")
            .orderBy("ranked_supply.id", "desc")
            .execute()
        : await builder
            .orderBy("supply.needed_on", "asc")
            .orderBy("supply.created_at", "desc")
            .orderBy("supply.id", "desc")
            .limit(3)
            .execute();
    return rows.map((row) => ({
      ...(context.role === "student"
        ? {
            check_state: checkState(row.is_checked, row.confirmed_revision, row.content_revision),
          }
        : {}),
      category: row.category as HomeSupply["category"],
      content_revision: row.content_revision,
      description: row.description,
      id: row.id,
      needed_on: databaseDate(row.needed_on),
      title: row.title,
    }));
  }

  private async getNotices(
    context: HomeContext,
    database: ClassHubDatabase,
  ): Promise<HomeNotice[]> {
    const [important, regular] = await Promise.all([
      this.getNoticeGroup(context, true, 2, database),
      this.getNoticeGroup(context, false, 3, database),
    ]);
    return [...important, ...regular];
  }

  /*
   * 진행 중인 선거. 선거는 마감 시각이 없어 열린 순서대로 싣는다.
   * has_voted 는 이미 참여자 표에 있는 사실이고(중복 투표를 막는 근거),
   * 누구를 골랐는지는 어디에도 들어가지 않는다 — 비밀투표는 유지된다.
   */
  private async getElections(
    context: HomeContext,
    database: ClassHubDatabase,
  ): Promise<HomePoll[]> {
    const rows = await database
      .selectFrom("elections as election")
      .leftJoin("election_participants as participant", (join) =>
        join
          .onRef("participant.election_id", "=", "election.id")
          .on("participant.member_id", "=", context.memberId),
      )
      .select([
        "election.id",
        "election.title",
        sql<boolean>`participant.member_id IS NOT NULL`.as("has_voted"),
      ])
      .where("election.class_id", "=", context.classId)
      .where("election.status", "=", "open")
      .$if(context.role === "student", (query) =>
        query.orderBy(sql`participant.member_id IS NULL`, "desc"),
      )
      /*
       * 투표는 마감이 가까운 것부터 싣지만 선거에는 마감이 없다. 그래서 최근에 연
       * 것부터 싣는다 — 칸은 두 건만 실으므로, 오래된 것부터 실으면 방금 연 선거가
       * 밀려 화면에 나타나지 않는다(2026-08-12 통합 시험이 잡았다).
       */
      .orderBy("election.opened_at", "desc")
      .orderBy("election.id", "desc")
      .limit(2)
      .execute();
    return rows.map((row) => ({
      closes_at: null,
      has_voted: row.has_voted,
      id: row.id,
      kind: "election" as const,
      title: row.title,
    }));
  }

  private async getPolls(context: HomeContext, database: ClassHubDatabase): Promise<HomePoll[]> {
    const [polls, elections] = await Promise.all([
      this.pollsEnabled ? this.getOpenPolls(context, database) : Promise.resolve([]),
      this.electionsEnabled ? this.getElections(context, database) : Promise.resolve([]),
    ]);
    /* 선거가 먼저다 — 반의 대표를 뽑는 일이 그날의 간식 투표보다 무겁다. */
    return [...elections, ...polls];
  }

  private async getOpenPolls(
    context: HomeContext,
    database: ClassHubDatabase,
  ): Promise<HomePoll[]> {
    const rows = await database
      .selectFrom("polls as poll")
      .leftJoin("poll_votes as vote", (join) =>
        join.onRef("vote.poll_id", "=", "poll.id").on("vote.member_id", "=", context.memberId),
      )
      .select([
        "poll.closes_at",
        "poll.id",
        "poll.title",
        sql<boolean>`vote.id IS NOT NULL`.as("has_voted"),
      ])
      .where("poll.class_id", "=", context.classId)
      .where("poll.closed_at", "is", null)
      .where("poll.closes_at", ">", homeCurrentTimestamp(this.dialect))
      .$if(context.role === "student", (query) => query.orderBy(sql`vote.id IS NULL`, "desc"))
      .orderBy("poll.closes_at", "asc")
      .orderBy("poll.id", "asc")
      .limit(2)
      .execute();
    return rows.map((row) => ({
      closes_at: row.closes_at.toISOString(),
      has_voted: row.has_voted,
      id: row.id,
      kind: "poll" as const,
      title: row.title,
    }));
  }

  private async getNoticeGroup(
    context: HomeContext,
    important: boolean,
    limit: number,
    database: ClassHubDatabase,
  ): Promise<HomeNotice[]> {
    let builder = database
      .selectFrom("notices as notice")
      .leftJoin("notice_reads as read", (join) =>
        join.onRef("read.notice_id", "=", "notice.id").on("read.member_id", "=", context.memberId),
      )
      .select([
        "notice.content_revision",
        "notice.id",
        "notice.is_important",
        "notice.published_at",
        "notice.title",
        "read.confirmed_revision",
      ])
      .where("notice.class_id", "=", context.classId)
      .where("notice.deleted_at", "is", null)
      .where("notice.published_at", "<=", homeCurrentTimestamp(this.dialect))
      .where("notice.is_important", "=", important);
    // 학생이 확인한 뒤 고쳐진 공지(다시 확인할 공지)는 올린 지 7일이 지나도 홈·칠판에 남긴다
    // (총검수 A1-03, 2026-10-03 사용자 결정). 나머지는 7일 규칙 그대로다.
    const changedAfterConfirm = sql<boolean>`(read.confirmed_revision IS NOT NULL AND read.confirmed_revision < notice.content_revision)`;
    builder =
      context.role === "student"
        ? builder.where((expression) =>
            expression.or([
              expression("notice.published_at", ">=", homeNoticeVisibleSince(this.dialect)),
              changedAfterConfirm,
            ]),
          )
        : builder.where("notice.published_at", ">=", homeNoticeVisibleSince(this.dialect));
    if (context.role === "student") {
      builder = builder.where(sql<boolean>`(
        notice.audience_mode = 'legacy_class'
        OR EXISTS (
          SELECT 1
          FROM notice_recipients AS audience_recipient
          WHERE audience_recipient.notice_id = notice.id
            AND audience_recipient.class_id = notice.class_id
            AND audience_recipient.member_id = ${homeBigint(context.memberId, this.dialect)}
        )
      )`);
    }
    const rows = await builder
      // 다시 확인할 공지가 개수 제한에 밀려나지 않게 먼저 둔다.
      .$if(context.role === "student", (query) => query.orderBy(changedAfterConfirm, "desc"))
      .orderBy("notice.published_at", "desc")
      .orderBy("notice.id", "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      ...(context.role === "student"
        ? {
            confirmation_state: confirmationState(row.confirmed_revision, row.content_revision),
          }
        : {}),
      content_revision: row.content_revision,
      id: row.id,
      is_important: row.is_important,
      published_at: row.published_at.toISOString(),
      title: row.title,
    }));
  }

  private async getSchedules(
    context: HomeContext,
    today: string,
    database: ClassHubDatabase,
  ): Promise<HomeSchedule[]> {
    const rows = await database
      .selectFrom("schedules as schedule")
      .select([
        "schedule.created_at",
        "schedule.due_date",
        "schedule.id",
        "schedule.schedule_type",
        "schedule.subject",
        "schedule.title",
      ])
      .where("schedule.class_id", "=", context.classId)
      .where("schedule.deleted_at", "is", null)
      .where("schedule.due_date", ">=", homeDate(today, this.dialect))
      .$if(context.role === "teacher", (query) =>
        query.where("schedule.schedule_type", "not in", ["assignment", "performance"]),
      )
      .orderBy("schedule.due_date", "asc")
      .orderBy("schedule.created_at", "desc")
      .orderBy("schedule.id", "desc")
      .limit(3)
      .execute();
    return rows.map((row) => {
      const dueDate = databaseDate(row.due_date);
      const daysUntil = calendarDayDifference(today, dueDate);
      return {
        d_day_label: daysUntil === 0 ? "D-Day" : `D-${daysUntil}`,
        days_until: daysUntil,
        due_date: dueDate,
        id: row.id,
        schedule_type: row.schedule_type as HomeSchedule["schedule_type"],
        subject: row.subject,
        title: row.title,
      };
    });
  }

  private async card<T>(
    errorData: T,
    isEmpty: (data: T) => boolean,
    errorCode: string,
    message: string,
    load: () => Promise<T>,
  ): Promise<HomeCard<T>> {
    try {
      const data = await load();
      return { data, status: isEmpty(data) ? "empty" : "ok" };
    } catch (error) {
      /*
       * 카드 하나가 실패해도 홈 전체를 못 쓰게 하지 않는 것이 이 설계의 의도다.
       * 그런데 예외를 아무 기록 없이 버리면 응답은 200이고 지표도 정상이라,
       * DB 열화나 커넥션 고갈이 조용히 진행된다(2026-08-01 감사 P1-03).
       * 동작은 그대로 두고 흔적만 남긴다. 카드 데이터는 싣지 않는다 — 학생·학급
       * 정보가 로그로 새면 안 된다.
       */
      this.logger.error({
        action: "home.card_failed",
        exception_name: error instanceof Error ? error.name : typeof error,
        failure_code: errorCode,
      });
      return { data: errorData, error_code: errorCode, message, status: "error" };
    }
  }
}
