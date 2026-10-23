import { createMariaDbDatabase, type DB } from "@classhub/db";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import { homeDatabaseEngine } from "./home.database.js";
import { HomeService } from "./home.service.js";

const actor = "9007199254741001",
  classId = "9007199254741002",
  member = "9007199254741003";
const today = "2026-09-07",
  tomorrow = "2026-09-08",
  clock = "2026-09-07 14:59:59.123456";
const publicClock = "2026-09-07T14:59:59.123Z";
const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
type Call = { sql: string; parameters: readonly unknown[] };
type Rows = Record<string, unknown>[];
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];

// Use the production guarded driver, actual MysqlQueryCompiler and row plugin.
// Only physical wire responses are scripted; no SQL state engine or real connection.
function boundary(
  role: "student" | "teacher",
  options: {
    attendance?: boolean;
    polls?: boolean;
    elections?: boolean;
    failAcquire?: boolean;
    reply?: (call: Call, fallback: Rows) => Rows;
    meals?: ConstructorParameters<typeof HomeService>[5];
    updates?: ConstructorParameters<typeof HomeService>[6];
  } = {},
) {
  const calls: Call[] = [];
  const leases = { acquired: 0, released: 0 };
  const context = {
    deleted_at: null,
    is_active: 1,
    class_id: classId,
    class_status: "active",
    edu_office_code: "J10",
    school_code: "7530000",
    member_id: member,
    role,
    profile_status: role === "teacher" ? "active" : null,
    temporary_password_must_change: role === "teacher" ? 0 : null,
  };
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection: (callback) => {
        leases.acquired++;
        if (options.failAcquire) throw new Error("synthetic acquisition failure");
        callback(null, {
          query: (statement, parameters, reply) => {
            const call = { sql: statement, parameters };
            calls.push(call);
            if (!/^\s*select\b/iu.test(statement))
              return reply(null, { affectedRows: 0, insertId: 0 });
            try {
              const fallback = fixtureRows(call, context);
              reply(null, options.reply ? options.reply(call, fallback) : fallback);
            } catch (error) {
              reply(error, undefined);
            }
          },
          release: () => {
            leases.released++;
          },
          destroy: vi.fn(),
        });
      },
      end: (callback) => callback(null),
    }),
    {
      host: "home.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  return {
    database,
    calls,
    leases,
    context,
    service: new HomeService(
      database,
      options.attendance ?? false,
      options.polls ?? false,
      options.elections ?? false,
      config,
      options.meals,
      options.updates,
    ),
  };
}
function fixtureRows(call: Call, context: Record<string, unknown>): Rows {
  const { sql: statement, parameters } = call;
  if (statement.includes("`profile`.`temporary_password_must_change`")) return [context];
  if (statement.includes("as `server_today`")) return [{ server_today: today }];
  // 교사 홈의 학생 수는 상태별로 묶어 한 번에 센다(대기 2명·승인 5명).
  if (statement.includes("group by `member`.`status`"))
    return [
      { status: "pending", count: "2" },
      { status: "approved", count: "5" },
    ];
  if (statement.includes("as `count`")) return [{ count: "2" }];
  if (statement.includes("from `notices` as `followup_notice`"))
    return [
      {
        id: "51",
        content_revision: "3",
        is_important: 1,
        published_at: clock,
        title: "중요 공지",
        confirmed: "1",
        unread: "2",
        modified_unconfirmed: "1",
        excluded_member_count: "3",
        last_reminder_requested_at: clock,
      },
      {
        id: "52",
        content_revision: "2",
        is_important: 0,
        published_at: clock,
        title: "일반 공지",
        confirmed: "1",
        unread: "1",
        modified_unconfirmed: "0",
        excluded_member_count: "0",
        last_reminder_requested_at: null,
      },
    ];
  if (statement.includes("from `supplies` as `followup_supply`"))
    return [
      {
        id: "61",
        category: "general",
        content_revision: "2",
        created_at: clock,
        needed_on: today,
        title: "오늘 준비물",
        checked: "1",
        unchecked: "1",
        modified_unconfirmed: "1",
        excluded_member_count: "3",
        last_reminder_requested_at: null,
      },
      {
        id: "62",
        category: "homework",
        content_revision: "1",
        created_at: clock,
        needed_on: tomorrow,
        title: "내일 숙제",
        checked: "0",
        unchecked: "2",
        modified_unconfirmed: "0",
        excluded_member_count: "0",
        last_reminder_requested_at: clock,
      },
    ];
  if (statement.includes("from `meals`"))
    return [
      {
        id: "71",
        meal_date: today,
        calorie_kcal_tenths: 12345,
        menu_json: JSON.stringify([
          { name: "현미밥", allergens: [] },
          { name: "우유", allergens: ["2"] },
        ]),
        source: "neis",
        source_loaded_on: today,
        source_updated_at: clock,
      },
    ];
  if (statement.includes("from `supplies` as `supply`"))
    return [
      {
        id: "61",
        category: "homework",
        description: null,
        content_revision: "2",
        confirmed_revision: "1",
        is_checked: 1,
        created_at: clock,
        needed_on: tomorrow,
        title: "숙제",
      },
    ];
  if (statement.includes("from `notices` as `notice`")) {
    const important = parameters.find((value) => typeof value === "boolean");
    return [
      {
        id: important ? "51" : "52",
        content_revision: "3",
        confirmed_revision: important ? "3" : null,
        is_important: important ? 1 : 0,
        published_at: clock,
        title: important ? "중요 공지" : "일반 공지",
      },
    ];
  }
  if (statement.includes("active_reminder.reminder_type"))
    return [
      {
        resource_id: "51",
        reminder_type: "notice",
        category: null,
        requested_at: clock,
        title: "공지 재알림",
      },
      {
        resource_id: "61",
        reminder_type: "supply",
        category: "homework",
        requested_at: clock,
        title: "숙제 재알림",
      },
    ];
  if (statement.includes("from `schedules`"))
    return [
      {
        id: "81",
        created_at: clock,
        due_date: today,
        schedule_type: "exam",
        subject: "국어",
        title: "오늘 일정",
      },
      {
        id: "82",
        created_at: clock,
        due_date: tomorrow,
        schedule_type: "other",
        subject: null,
        title: "내일 일정",
      },
    ];
  if (statement.includes("from `polls`"))
    return [{ id: "91", closes_at: clock, has_voted: 0, title: "설문" }];
  if (statement.includes("from `elections`"))
    return [{ id: "92", has_voted: 1, title: "대표 선거" }];
  if (statement.includes("from `attendance_notifications`"))
    return context.role === "teacher"
      ? [{ total: "3", late: "1", absent: "1", early: "1", pending: "2", acknowledged: "1" }]
      : [
          {
            id: "93",
            row_version: "2",
            acknowledged_at: null,
            expected_time: "09:05:00",
            notification_type: "late",
            status: "pending",
            submitted_at: clock,
            updated_at: clock,
          },
        ];
  throw new Error("Unexpected synthetic home SELECT");
}
function selects(h: ReturnType<typeof boundary>) {
  return h.calls.filter((call) => /^\s*select\b/iu.test(call.sql));
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  vi.restoreAllMocks();
});

describe("HomeService native MariaDB facade", () => {
  it("reports unavailable when the dashboard cannot acquire its database lease", async () => {
    const h = boundary("student", { failAcquire: true });
    await expect(h.service.getForUser(actor)).rejects.toMatchObject({ status: 503 });
    expect(h.leases).toEqual({ acquired: 1, released: 0 });
  });

  it("keeps one guarded lease per dashboard and releases overlapping requests independently", async () => {
    const h = boundary("student", { attendance: true, polls: true, elections: true });
    await Promise.all([h.service.getForUser(actor), h.service.getForUser("9007199254741004")]);
    expect(h.leases).toEqual({ acquired: 2, released: 2 });
    const contexts = selects(h).filter((call) =>
      call.sql.includes("`profile`.`temporary_password_must_change`"),
    );
    expect(contexts.map((call) => call.parameters[0]).sort()).toEqual(
      [actor, "9007199254741004"].sort(),
    );
  });

  it("returns the dashboard lease when membership lookup rejects access", async () => {
    const h = boundary("student", {
      reply: (call, fallback) =>
        call.sql.includes("`profile`.`temporary_password_must_change`") ? [] : fallback,
    });
    await expect(h.service.getForUser(actor)).rejects.toMatchObject({ status: 404 });
    expect(h.leases).toEqual({ acquired: 1, released: 1 });
  });

  it("shows the lunch the meals tab would show, from the row the dashboard read", async () => {
    const neisLunch = {
      calorie_kcal: 700,
      id: "neis:J10:7530000:2026-09-07",
      meal_date: today,
      menu: [{ allergens: [], name: "나이스 메뉴" }],
      source: "neis",
      source_loaded_on: null,
      source_updated_at: publicClock,
    };
    const resolveSchoolLunch = vi.fn().mockResolvedValue(neisLunch);
    const h = boundary("student", { meals: { resolveSchoolLunch } as never });
    const result = await h.service.getForUser(actor);
    expect(result.meal).toEqual({ data: neisLunch, status: "ok" });
    expect(resolveSchoolLunch).toHaveBeenCalledWith(
      expect.objectContaining({ meal_date: today }),
      { eduOfficeCode: "J10", schoolCode: "7530000" },
      today,
    );
  });

  it("counts a student's unresolved items with the updates rule after returning the lease", async () => {
    let leasesWhenCounted: unknown;
    const h = boundary("student", {
      updates: {
        list: vi.fn(async () => {
          leasesWhenCounted = { ...h.leases };
          return { unresolved_count: 4 };
        }),
      } as never,
    });
    const result = await h.service.getForUser(actor);
    expect(result.unresolved_count).toBe(4);
    // 홈 연결을 돌려준 뒤에 센다(한 요청이 연결을 둘 쥐지 않는다).
    expect(leasesWhenCounted).toEqual({ acquired: 1, released: 1 });

    const failing = boundary("student", {
      updates: { list: vi.fn().mockRejectedValue(new Error("synthetic")) } as never,
    });
    expect((await failing.service.getForUser(actor)).unresolved_count).toBeNull();

    const teacherList = vi.fn();
    const teacher = boundary("teacher", { updates: { list: teacherList } as never });
    expect(await teacher.service.getForUser(actor)).not.toHaveProperty("unresolved_count");
    expect(teacherList).not.toHaveBeenCalled();
  });

  it("defaults to PG and rejects unsupported configuration before SQL", () => {
    expect(homeDatabaseEngine()).toBe("postgres");
    const h = boundary("student");
    expect(
      () =>
        new HomeService(
          h.database,
          false,
          false,
          false,
          new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<AppEnvironment, true>,
        ),
    ).toThrow("Invalid home database engine");
    expect(h.calls).toHaveLength(0);
  });
  it("returns all student cards through the guarded driver with lossless identities and public ISO3", async () => {
    const h = boundary("student", { attendance: true, polls: true, elections: true });
    const result = await h.service.getForUser(actor);
    expect(result.server_today).toBe(today);
    expect(result.pending_member_count).toBeNull();
    expect(result.teacher_followups).toBeNull();
    expect(result).not.toHaveProperty("active_student_count");
    expect(result.meal).toEqual({
      status: "ok",
      data: {
        id: "71",
        calorie_kcal: 1234.5,
        meal_date: today,
        menu: [
          { name: "현미밥", allergens: [] },
          { name: "우유", allergens: ["2"] },
        ],
        source: "neis",
        source_loaded_on: today,
        source_updated_at: publicClock,
      },
    });
    expect(result.notices.data).toEqual([
      {
        id: "51",
        title: "중요 공지",
        content_revision: "3",
        is_important: true,
        published_at: publicClock,
        confirmation_state: "confirmed",
      },
      {
        id: "52",
        title: "일반 공지",
        content_revision: "3",
        is_important: false,
        published_at: publicClock,
        confirmation_state: "unread",
      },
    ]);
    expect(result.supplies.data[0]).toMatchObject({
      check_state: "modified_unconfirmed",
      needed_on: tomorrow,
    });
    expect(result.reminders.data).toEqual([
      {
        resource_id: "51",
        reminder_type: "notice",
        requested_at: publicClock,
        title: "공지 재알림",
      },
      {
        resource_id: "61",
        reminder_type: "supply",
        category: "homework",
        requested_at: publicClock,
        title: "숙제 재알림",
      },
    ]);
    expect(
      result.schedules.data.map((row) => [row.due_date, row.days_until, row.d_day_label]),
    ).toEqual([
      [today, 0, "D-Day"],
      [tomorrow, 1, "D-1"],
    ]);
    expect(result.polls).toEqual({
      status: "ok",
      data: [
        { id: "92", kind: "election", has_voted: true, closes_at: null, title: "대표 선거" },
        { id: "91", kind: "poll", has_voted: false, closes_at: publicClock, title: "설문" },
      ],
    });
    expect(result.attendance).toEqual({
      status: "ok",
      data: {
        id: "93",
        row_version: "2",
        acknowledged_at: null,
        expected_time: "09:05",
        notification_type: "late",
        status: "pending",
        submitted_at: publicClock,
        updated_at: publicClock,
      },
    });
    const sql = selects(h)
      .map((call) => call.sql)
      .join("\n");
    expect(sql).not.toMatch(
      /::|DISTINCT ON|FILTER\s*\(|CURRENT_TIMESTAMP|clock_timestamp|RETURNING/iu,
    );
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/iu);
    expect(h.calls.some((call) => call.sql.includes("SET NAMES utf8mb4 COLLATE utf8mb4_bin"))).toBe(
      true,
    );
    expect(selects(h)[0]!.parameters).toEqual([actor, "approved"]);
  });
  it("keeps a student's changed-after-confirm notices past the 7-day window, teachers keep the window (A1-03)", async () => {
    const noticeSql = async (role: "student" | "teacher") => {
      const h = boundary(role, { attendance: true });
      await h.service.getForUser(actor);
      return selects(h)
        .map((call) => call.sql)
        .filter((sql) => sql.includes("from `notices` as `notice`"));
    };
    const student = await noticeSql("student");
    expect(student.length).toBeGreaterThan(0);
    for (const sql of student) {
      expect(sql).toMatch(
        /or \(read\.confirmed_revision IS NOT NULL AND read\.confirmed_revision < notice\.content_revision\)/u,
      );
      expect(sql).toMatch(/order by \(read\.confirmed_revision IS NOT NULL[^)]*\) desc/u);
    }
    for (const sql of await noticeSql("teacher")) {
      expect(sql).not.toContain("read.confirmed_revision IS NOT NULL");
      expect(sql).toContain("INTERVAL 7 DAY");
    }
  });
  it("counts zero pending and zero approved students for a class without student rows", async () => {
    const h = boundary("teacher", {
      reply: (call, fallback) => (call.sql.includes("group by `member`.`status`") ? [] : fallback),
    });
    const result = await h.service.getForUser(actor);
    expect(result.pending_member_count).toBe(0);
    expect(result.active_student_count).toBe(0);
    const counted = selects(h).find((call) => call.sql.includes("group by `member`.`status`"));
    expect(counted?.sql).toContain("`member`.`status` in (?, ?)");
    expect(counted?.parameters).toEqual(expect.arrayContaining(["pending", "approved"]));
  });
  it("preserves teacher pending counts and prioritized followups including excluded audiences", async () => {
    const h = boundary("teacher", { attendance: true });
    const result = await h.service.getForUser(actor);
    expect(result.pending_member_count).toBe(2);
    expect(result.active_student_count).toBe(5);
    expect(result.teacher_followups).toEqual({
      status: "ok",
      data: [
        {
          content_revision: "3",
          counts: { confirmed: 1, unread: 2, modified_unconfirmed: 1, excluded_member_count: 3 },
          is_important: true,
          last_reminder_requested_at: publicClock,
          published_at: publicClock,
          resource_id: "51",
          resource_type: "notice",
          title: "중요 공지",
        },
        {
          category: "general",
          content_revision: "2",
          counts: { checked: 1, unchecked: 1, modified_unconfirmed: 1, excluded_member_count: 3 },
          last_reminder_requested_at: null,
          needed_on: today,
          resource_id: "61",
          resource_type: "supply",
          title: "오늘 준비물",
        },
        {
          category: "homework",
          content_revision: "1",
          counts: { checked: 0, unchecked: 2, modified_unconfirmed: 0, excluded_member_count: 0 },
          last_reminder_requested_at: publicClock,
          needed_on: tomorrow,
          resource_id: "62",
          resource_type: "supply",
          title: "내일 숙제",
        },
      ],
    });
    expect(result.reminders).toEqual({ status: "empty", data: [] });
    expect(result.notices.data.every((row) => !Object.hasOwn(row, "confirmation_state"))).toBe(
      true,
    );
    expect(result.supplies.data.every((row) => !Object.hasOwn(row, "check_state"))).toBe(true);
    expect(result.attendance).toEqual({
      status: "ok",
      data: { total: 3, late: 1, absent: 1, early: 1, pending: 2, acknowledged: 1 },
    });
    const followup = selects(h).filter(
      (call) =>
        call.sql.includes("as `followup_notice`") || call.sql.includes("as `followup_supply`"),
    );
    expect(followup).toHaveLength(2);
    for (const call of followup) {
      expect(call.sql.match(/COUNT\(CASE WHEN/gu)).toHaveLength(5);
      expect(call.sql).toContain("having COUNT(CASE WHEN");
      expect(call.sql).toContain("NOT (");
      expect(call.sql).not.toContain("FILTER");
      expect(call.parameters.at(-1)).toBe(3);
    }
    expect(followup[1]!.sql).toContain("`followup_supply`.`category`");
    expect(followup[1]!.parameters).toContain(today);
    expect(followup[1]!.parameters).toContain(tomorrow);
    expect(selects(h).find((call) => call.sql.includes("from `schedules`"))!.parameters).toContain(
      "assignment",
    );
    expect(selects(h).some((call) => call.sql.includes("active_reminder"))).toBe(false);
  });
  it("uses per-resource row ranking and canonical UUID text tie-break without changing reminder visibility", async () => {
    const h = boundary("student");
    await h.service.getForUser(actor);
    const query = selects(h).find((call) => call.sql.includes("active_reminder"))!;
    expect(query.sql.match(/ROW_NUMBER\(\) OVER/gu)).toHaveLength(2);
    expect(query.sql.match(/CAST\(batch.id AS CHAR\) COLLATE utf8mb4_bin DESC/gu)).toHaveLength(2);
    expect(query.sql).toContain("WHERE active_reminder.reminder_rank = 1");
    expect(query.sql).toContain("CAST(notice.id AS CHAR) COLLATE utf8mb4_bin");
    expect(query.sql).toContain("CAST(supply.id AS CHAR) COLLATE utf8mb4_bin");
    // 필요한 날이 지난 준비물 재알림은 빼므로 기준일은 오늘이다(2026-10-01 결정, 예전에는 90일 전).
    expect(query.parameters).toEqual([classId, member, classId, member, "2026-09-07"]);
    for (const condition of [
      "recipient.resolved_at IS NULL",
      "batch.content_revision = notice.content_revision",
      "batch.content_revision = supply.content_revision",
      "notice.published_at <= UTC_TIMESTAMP(6)",
      "notice.published_at >= UTC_TIMESTAMP(6) - INTERVAL 7 DAY",
      "supply.needed_on >= ?",
      "account.deleted_at IS NULL",
      "member.status = 'approved'",
      "supply_check.confirmed_revision IS NULL",
    ])
      expect(query.sql).toContain(condition);
  });
  it("retains homework's unlimited future horizon, normal supplies today/tomorrow and student audiences", async () => {
    const h = boundary("student");
    await h.service.getForUser(actor);
    const supplies = selects(h).filter((call) => call.sql.includes("from `supplies` as `supply`"));
    expect(supplies).toHaveLength(1);
    const supply = supplies[0]!;
    expect(supply.sql).toContain("ROW_NUMBER() OVER");
    expect(supply.sql).toContain("PARTITION BY supply.category");
    expect(supply.sql).toContain("supply.category = 'homework' AND supply.needed_on >= ?");
    expect(supply.sql).toContain("supply.needed_on IN (?, ?)");
    expect(supply.parameters).toEqual([member, classId, today, today, tomorrow, member, 3]);
    expect(supply.sql).toContain("`ranked_supply`.`category_rank` <= ?");
    expect(supply.sql).toContain(
      "order by `ranked_supply`.`needed_on` asc, `ranked_supply`.`created_at` desc, `ranked_supply`.`id` desc",
    );
    const noticeQueries = selects(h).filter((call) =>
      call.sql.includes("from `notices` as `notice`"),
    );
    expect(noticeQueries.map((call) => call.parameters.at(-1))).toEqual([2, 3]);
    for (const call of [...supplies, ...noticeQueries])
      expect(call.sql).toContain("audience_recipient.member_id = ?");
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("respects independent poll=%s election=%s flags", async (polls, elections) => {
    const h = boundary("student", { polls, elections });
    const result = await h.service.getForUser(actor);
    expect(Object.hasOwn(result, "polls")).toBe(polls || elections);
    expect(Object.hasOwn(result, "attendance")).toBe(false);
    const statements = selects(h)
      .map((call) => call.sql)
      .join("\n");
    expect(statements.includes("from `polls`")).toBe(polls);
    expect(statements.includes("from `elections`")).toBe(elections);
    expect(statements.includes("attendance_notifications")).toBe(false);
    if (polls) {
      expect(statements).toContain("vote.id IS NULL desc");
      expect(statements).toContain("`poll`.`closes_at` > UTC_TIMESTAMP(6)");
    }
    if (elections) expect(statements).toContain("participant.member_id IS NULL desc");
  });
});

describe("HomeService unchanged authorization and failure-card policy", () => {
  it.each([
    [{ is_active: 0 }, 404],
    [{ deleted_at: clock }, 404],
    [{ class_status: "suspended" }, 423],
    [{ class_status: "archived" }, 404],
    [{ role: "other" }, 403],
    [{ temporary_password_must_change: 1 }, 403],
    [{ profile_status: "blocked" }, 403],
  ] as const)("rejects context %j with %s before any card query", async (change, status) => {
    const h = boundary("teacher");
    Object.assign(h.context, change);
    await expect(h.service.getForUser(actor)).rejects.toMatchObject({ status });
    expect(selects(h)).toHaveLength(1);
  });
  it("rejects missing context and invalid native context separately", async () => {
    const missing = boundary("student", { reply: () => [] });
    await expect(missing.service.getForUser(actor)).rejects.toMatchObject({ status: 404 });
    const invalid = boundary("student");
    Object.assign(invalid.context, { is_active: "0" });
    await expect(invalid.service.getForUser(actor)).rejects.toMatchObject({ status: 503 });
  });
  it.each(["clock", "pending"])("fails the whole home for %s query failure", async (target) => {
    const h = boundary("teacher", {
      reply: (call, fallback) => {
        if (call.sql.includes(target === "clock" ? "as `server_today`" : "as `count`"))
          throw new Error("private SQL error");
        return fallback;
      },
    });
    await expect(h.service.getForUser(actor)).rejects.toMatchObject({ status: 503 });
  });
  it.each(["meal", "supply", "notice", "schedule", "reminder", "poll", "attendance", "followup"])(
    "keeps the home available after only the %s card fails",
    async (target) => {
      const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const patterns: Record<string, string> = {
        meal: "from `meals`",
        supply: "from `supplies` as `supply`",
        notice: "from `notices` as `notice`",
        schedule: "from `schedules`",
        reminder: "active_reminder",
        poll: "from `polls`",
        attendance: "from `attendance_notifications`",
        followup: "from `notices` as `followup_notice`",
      };
      const h = boundary(target === "followup" ? "teacher" : "student", {
        attendance: true,
        polls: true,
        reply: (call, fallback) => {
          if (call.sql.includes(patterns[target]!))
            throw new Error("private SQL/PII must not appear");
          return fallback;
        },
      });
      const result = await h.service.getForUser(actor);
      const key = {
        meal: "meal",
        supply: "supplies",
        notice: "notices",
        schedule: "schedules",
        reminder: "reminders",
        poll: "polls",
        attendance: "attendance",
        followup: "teacher_followups",
      }[target] as keyof typeof result;
      expect(result[key]).toMatchObject({
        status: "error",
        error_code: `${target.toUpperCase()}_QUERY_FAILED`,
      });
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify([result, log.mock.calls])).not.toContain("private");
    },
  );
  it("preserves the original all-primary-cards failure rule even when optional polls succeed", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    const h = boundary("student", {
      polls: true,
      reply: (call, fallback) => {
        if (
          [
            "from `meals`",
            "from `supplies` as `supply`",
            "from `notices` as `notice`",
            "from `schedules`",
          ].some((part) => call.sql.includes(part))
        )
          throw new Error("synthetic");
        return fallback;
      },
    });
    await expect(h.service.getForUser(actor)).rejects.toMatchObject({ status: 503 });
  });
  it.each(["not JSON", "{}", JSON.stringify([{ name: "우유", allergens: ["99"] }])])(
    "contains invalid stored meal JSON %s within its card",
    async (menu) => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const h = boundary("student", {
        reply: (call, fallback) =>
          call.sql.includes("from `meals`") ? [{ ...fallback[0], menu_json: menu }] : fallback,
      });
      const result = await h.service.getForUser(actor);
      expect(result.meal).toMatchObject({
        status: "error",
        error_code: "MEAL_QUERY_FAILED",
        data: null,
      });
      expect(result.notices.status).toBe("ok");
    },
  );
  it("marks empty cards correctly without querying disabled features", async () => {
    const h = boundary("student", {
      reply: (call, fallback) =>
        call.sql.includes("as `server_today`") ||
        call.sql.includes("`profile`.`temporary_password_must_change`")
          ? fallback
          : [],
    });
    const result = await h.service.getForUser(actor);
    for (const key of ["meal", "notices", "supplies", "schedules", "reminders"] as const)
      expect(result[key].status).toBe("empty");
  });
});

describe("학생 홈 준비물·숙제의 독립된 가까운 항목", () => {
  const supplyRows = (
    category: "general" | "homework",
    count: number,
    neededOn: string,
    start: number,
  ): Rows =>
    Array.from({ length: count }, (_, index) => ({
      id: String(start + count - index),
      category,
      description: null,
      content_revision: "2",
      confirmed_revision: "1",
      is_checked: 1,
      created_at: clock,
      needed_on: neededOn,
      title: category + "-" + index,
    }));
  function replySupplies(rows: Rows) {
    return (call: Call, fallback: Rows): Rows => {
      if (!call.sql.includes("from `supplies` as `supply`")) return fallback;
      // 합성 wire는 DB의6자리 시각 정렬 결과를 준다. 앱의 Date 정렬은 사용하지 않는다.
      const ordered = [...rows].sort(
        (a, b) =>
          String(a.needed_on).localeCompare(String(b.needed_on)) ||
          String(b.created_at).localeCompare(String(a.created_at)) ||
          (BigInt(String(a.id)) < BigInt(String(b.id))
            ? 1
            : BigInt(String(a.id)) > BigInt(String(b.id))
              ? -1
              : 0),
      );
      if (call.sql.includes("ROW_NUMBER() OVER")) {
        expect(call.sql).toContain("PARTITION BY supply.category");
        expect(call.sql).toContain(
          "ORDER BY supply.needed_on ASC, supply.created_at DESC, supply.id DESC",
        );
        expect(call.sql).toContain(
          "order by `ranked_supply`.`needed_on` asc, `ranked_supply`.`created_at` desc, `ranked_supply`.`id` desc",
        );
        const counts = new Map<string, number>();
        return ordered.flatMap((row) => {
          const category = String(row.category),
            rank = (counts.get(category) ?? 0) + 1;
          counts.set(category, rank);
          return rank <= Number(call.parameters.at(-1))
            ? [{ ...row, category_rank: String(rank) }]
            : [];
        });
      }
      const category = call.parameters.at(-2);
      return (
        category === "general" || category === "homework"
          ? ordered.filter((row) => row.category === category)
          : ordered
      ).slice(0, Number(call.parameters.at(-1)));
    };
  }
  it.each(["general", "homework"] as const)(
    "가까운 %s 3개가 반대 종류의 항목을 없다고 만들지 않는다",
    async (category) => {
      const other = category === "general" ? "homework" : "general";
      const h = boundary("student", {
        reply: replySupplies([
          ...supplyRows(category, 3, today, 70),
          ...supplyRows(other, 1, tomorrow, 90),
        ]),
      });
      const result = await h.service.getForUser(actor);
      expect(result.supplies.status).toBe("ok");
      expect(result.supplies.data.filter((row) => row.category === category)).toHaveLength(3);
      expect(result.supplies.data.filter((row) => row.category === other)).toHaveLength(1);
      expect(result.supplies.data.at(-1)?.needed_on).toBe(tomorrow);
      expect(result.supplies.data.every((row) => row.check_state === "modified_unconfirmed")).toBe(
        true,
      );
      expect(h.leases).toEqual({ acquired: 1, released: 1 });
    },
  );
  it("각 종류는3개까지이며 합친 날짜·생성시각·큰ID 순서를 유지한다", async () => {
    const rows = [
      ...supplyRows("general", 5, today, 70),
      ...supplyRows("homework", 5, tomorrow, 90),
    ];
    // 손실 없는 BIGINT로 서버가 주는 식별자(숫자 변환을 사용하지 않는다).
    for (const [index, row] of rows.slice(0, 5).entries())
      row.id = String(9007199254741005n - BigInt(index));
    const h = boundary("student", { reply: replySupplies(rows) });
    const result = await h.service.getForUser(actor);
    expect(result.supplies.data.map((row) => row.id)).toEqual([
      "9007199254741005",
      "9007199254741004",
      "9007199254741003",
      "95",
      "94",
      "93",
    ]);
    expect(result.supplies.data).toHaveLength(6);
  });
  it("한 종류 조회 실패도 기존 supply 오류 카드로 처리하고 성공한 쪽만 빈 상태로 보여주지 않는다", async () => {
    const h = boundary("student", {
      reply: (call, fallback) => {
        if (
          call.sql.includes("from `supplies` as `supply`") &&
          call.sql.includes("ROW_NUMBER() OVER")
        )
          throw Error("synthetic category failure");
        return fallback;
      },
    });
    const result = await h.service.getForUser(actor);
    expect(result.supplies).toMatchObject({
      status: "error",
      error_code: "SUPPLY_QUERY_FAILED",
      data: [],
    });
    expect(result.notices.status).toBe("ok");
    expect(h.leases).toEqual({ acquired: 1, released: 1 });
  });
  it("교사 응답의 기존 공통3개 조회는 유지한다", async () => {
    const h = boundary("teacher");
    await h.service.getForUser(actor);
    const queries = selects(h).filter((call) => call.sql.includes("from `supplies` as `supply`"));
    expect(queries).toHaveLength(1);
    expect(queries[0]!.parameters.at(-1)).toBe(3);
    expect(queries[0]!.parameters).not.toContain("general");
    expect(queries[0]!.parameters).not.toContain("homework");
  });
  it.each([
    ["같은 밀리초 안의6자리 시각", "2026-09-07 14:59:59.123100", "2026-09-07 14:59:59.123900"],
    ["서로 다른 생성시각", "2026-09-07 14:59:59.122900", "2026-09-07 14:59:59.123100"],
  ])("%s도 공개 배열의 DB 순서를 보존한다", async (_caseName, older, newer) => {
    const rows = [
      { ...supplyRows("general", 1, today, 0)[0], id: "200", created_at: older },
      { ...supplyRows("homework", 1, today, 0)[0], id: "100", created_at: newer },
    ];
    const h = boundary("student", { reply: replySupplies(rows) });
    const result = await h.service.getForUser(actor);
    expect(result.supplies.data.map((row) => row.id)).toEqual(["100", "200"]);
    expect(result.supplies.data.every((row) => !Object.hasOwn(row, "category_rank"))).toBe(true);
    expect(
      selects(h).filter((call) => call.sql.includes("from `supplies` as `supply`")),
    ).toHaveLength(1);
    expect(h.leases).toEqual({ acquired: 1, released: 1 });
  });
});
