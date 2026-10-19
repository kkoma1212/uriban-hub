import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays, kstDate } from "../src/common/date/kst-date.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

type ScheduleType = "assignment" | "exam" | "other" | "performance";

interface ScheduleItem {
  d_day_label: string | null;
  days_until: number;
  description: string | null;
  due_date: string;
  id: string;
  row_version: string;
  schedule_type: ScheduleType;
  subject: string | null;
  title: string;
}

interface ScheduleList {
  items: ScheduleItem[];
  next_cursor: string | null;
  server_today: string;
}

interface ClassScheduleCalendarItem extends ScheduleItem {
  source: "class";
}

interface SchoolScheduleCalendarItem {
  d_day_label: string | null;
  days_until: number;
  description: string | null;
  due_date: string;
  id: string;
  school_day_type: string;
  source: "school";
  source_loaded_on: string;
  target_grades: number[];
  title: string;
}

interface ScheduleCalendarHoliday {
  date: string;
  name: string;
}

interface ScheduleCalendar {
  end_date: string;
  holidays: ScheduleCalendarHoliday[];
  items: Array<ClassScheduleCalendarItem | SchoolScheduleCalendarItem>;
  oldest_visible_date: string;
  server_today: string;
  start_date: string;
}

let fixture: ClassFixture;
let scheduleSequence = 0;
const DAY_MS = 24 * 60 * 60 * 1_000;

function expectError(
  response: {
    json(): { error: { code: string; details?: Record<string, unknown> } };
    statusCode: number;
  },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function seedSchedule(
  target: ClassFixture,
  values: Partial<{
    description: string | null;
    dueDate: string;
    scheduleType: ScheduleType;
    subject: string | null;
    title: string;
  }> = {},
) {
  const sequence = ++scheduleSequence;
  return database
    .insertInto("schedules")
    .values({
      class_id: target.classId,
      created_by_member_id: target.teacher.memberId!,
      description: values.description ?? null,
      due_date: values.dueDate ?? addCalendarDays(kstDate(new Date()), 1),
      schedule_type: values.scheduleType ?? "other",
      subject: values.subject ?? null,
      title: values.title ?? `일정 ${sequence}`,
    })
    .returning([
      "description",
      "due_date",
      "id",
      "row_version",
      "schedule_type",
      "subject",
      "title",
      "updated_at",
    ])
    .executeTakeFirstOrThrow();
}

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});
afterEach(() => vi.useRealTimers());

afterAll(teardownSuppliesHarness, 120_000);

describe("schedules HTTP contract", () => {
  it("enforces authentication, current class, teacher mutations, hiding, and suspension", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/schedules?scope=upcoming" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        method: "POST",
        url: "/api/v1/schedules",
        headers: { ...fixture.students[0].headers, "idempotency-key": randomUUID() },
        payload: {
          due_date: kstDate(new Date()),
          schedule_type: "exam",
          title: "학생 등록 시도",
        },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/schedules?scope=upcoming",
        headers: fixture.outsider.headers,
      }),
      404,
      "NOT_FOUND",
    );

    const other = await createClassFixture();
    const otherSchedule = await seedSchedule(other);
    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      expectError(
        await app.inject({
          method,
          url: `/api/v1/schedules/${otherSchedule.id}`,
          headers: fixture.teacher.headers,
          ...(method === "PATCH"
            ? { payload: { title: "타 반 수정 시도" } }
            : method === "DELETE"
              ? { payload: { reason: null } }
              : {}),
        }),
        404,
        "NOT_FOUND",
      );
    }

    const ownSchedule = await seedSchedule(fixture);
    const beforeStudentDelete = await database
      .selectFrom("schedules")
      .selectAll()
      .where("id", "=", ownSchedule.id)
      .executeTakeFirstOrThrow();
    expectError(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/schedules/${ownSchedule.id}`,
        headers: fixture.students[0].headers,
        payload: { title: "학생 수정 시도" },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: `/api/v1/schedules/${ownSchedule.id}`,
        headers: { ...fixture.students[0].headers, "if-match": '"1"' },
        payload: { reason: null },
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expect(
      await database
        .selectFrom("schedules")
        .selectAll()
        .where("id", "=", ownSchedule.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeStudentDelete);
    expect(
      await database
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("action", "=", "schedule.deleted")
        .where("target_id", "=", ownSchedule.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const tooOld = await seedSchedule(fixture, {
      dueDate: addCalendarDays(kstDate(new Date()), -91),
      title: "조회 기간 밖 일정",
    });
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/schedules/${tooOld.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );

    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: new Date(),
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "통합 테스트 정지",
      })
      .where("id", "=", fixture.classId)
      .execute();
    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/schedules/${ownSchedule.id}`,
        headers: fixture.teacher.headers,
      }),
      423,
      "CLASS_SUSPENDED",
    );
  });

  it("creates once with canonical optional values and a create-shaped audit record", async () => {
    const key = randomUUID();
    const payload = {
      due_date: addCalendarDays(kstDate(new Date()), 2),
      schedule_type: "performance",
      title: "국어 발표 평가",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"1"');
    const item = first.json() as ScheduleItem;
    expect(item).toMatchObject({
      d_day_label: "D-2",
      days_until: 2,
      description: null,
      due_date: payload.due_date,
      row_version: "1",
      schedule_type: "performance",
      subject: null,
      title: payload.title,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { ...fixture.teacher.headers, "idempotency-key": key },
      payload: { ...payload, description: null, subject: null },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(item);

    const rows = await database
      .selectFrom("schedules")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("class_id", "=", fixture.classId)
      .where("title", "=", payload.title)
      .executeTakeFirstOrThrow();
    expect(rows.count).toBe("1");
    const audit = await database
      .selectFrom("audit_logs")
      .select(["action", "after_json", "before_json", "target_snapshot"])
      .where("target_type", "=", "schedule")
      .where("target_id", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: "schedule.created",
      before_json: null,
      target_snapshot: null,
    });
    expect(audit.after_json).toEqual({
      deleted_at: null,
      due_date: payload.due_date,
      schedule_id: item.id,
      schedule_type: "performance",
      subject: null,
      title: payload.title,
    });
    expect(JSON.stringify(audit.after_json)).not.toContain("description");
  });

  it("separates upcoming and recent past lists with stable cursors and server D-day values", async () => {
    const today = kstDate(new Date());
    const pastBoundary = addCalendarDays(today, -90);
    const hiddenPast = addCalendarDays(today, -91);
    await seedSchedule(fixture, { dueDate: pastBoundary, title: "90일 전 일정" });
    await seedSchedule(fixture, { dueDate: hiddenPast, title: "91일 전 일정" });
    await seedSchedule(fixture, { dueDate: addCalendarDays(today, -1), title: "어제 일정" });

    const seededUpcoming = [];
    for (let index = 0; index < 21; index += 1) {
      seededUpcoming.push(
        await seedSchedule(fixture, {
          dueDate: index < 2 ? today : addCalendarDays(today, 1),
          scheduleType: index === 0 ? "exam" : "other",
          title: `다가오는 일정 ${String(index).padStart(2, "0")}`,
        }),
      );
    }

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/schedules?scope=upcoming",
      headers: fixture.students[0].headers,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as ScheduleList;
    expect(firstPage.server_today).toBe(today);
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.next_cursor).not.toBeNull();
    expect(firstPage.items[0]).toMatchObject({ d_day_label: "D-Day", days_until: 0 });
    expect(firstPage.items[0]!.id).toBe(seededUpcoming[0]!.id);
    expect(firstPage.items[1]!.id).toBe(seededUpcoming[1]!.id);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/schedules?scope=upcoming&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
      headers: fixture.students[0].headers,
    });
    const secondPage = second.json() as ScheduleList;
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(21);

    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/schedules?scope=past&cursor=${encodeURIComponent(firstPage.next_cursor!)}`,
        headers: fixture.students[0].headers,
      }),
      400,
      "INVALID_CURSOR",
    );
    const past = await app.inject({
      method: "GET",
      url: "/api/v1/schedules?scope=past",
      headers: fixture.students[0].headers,
    });
    const pastList = past.json() as ScheduleList;
    expect(pastList.items.map((item) => item.title)).toEqual(["어제 일정", "90일 전 일정"]);
    expect(pastList.items[0]).toMatchObject({ d_day_label: null, days_until: -1 });
    expect(pastList.items.some((item) => item.title === "91일 전 일정")).toBe(false);
  });

  it("fills an inclusive 42-day calendar range across leap-day and month boundaries", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const other = await createClassFixture();
    const leapDayFirst = await seedSchedule(fixture, {
      dueDate: "2028-02-29",
      scheduleType: "exam",
      title: "윤년 첫 일정",
    });
    const leapDaySecond = await seedSchedule(fixture, {
      dueDate: "2028-02-29",
      scheduleType: "performance",
      title: "윤년 둘째 일정",
    });
    const nextMonth = await seedSchedule(fixture, {
      dueDate: "2028-03-01",
      scheduleType: "assignment",
      title: "다음 달 일정",
    });
    await seedSchedule(fixture, { dueDate: "2028-03-12", title: "범위 밖 일정" });
    await seedSchedule(other, { dueDate: "2028-02-29", title: "다른 반 일정" });
    const currentClass = await database
      .selectFrom("classes")
      .select(["academic_year", "edu_office_code", "grade", "school_code"])
      .where("id", "=", fixture.classId)
      .executeTakeFirstOrThrow();
    const schoolEvent = await database
      .insertInto("school_schedule_events")
      .values({
        academic_year: currentClass.academic_year,
        edu_office_code: currentClass.edu_office_code,
        event_content: "전 학년 정상 등교",
        event_date: "2028-02-29",
        event_name: "학교 공식 행사",
        grade_mask: 1 << (currentClass.grade - 1),
        school_code: currentClass.school_code,
        school_day_type: "수업일",
        source_loaded_on: "2026-07-30",
        source_updated_at: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("school_schedule_events")
      .values({
        academic_year: currentClass.academic_year,
        edu_office_code: currentClass.edu_office_code,
        event_content: null,
        event_date: "2028-02-29",
        event_name: "다른 학년 행사",
        grade_mask: 1 << currentClass.grade,
        school_code: currentClass.school_code,
        school_day_type: "수업일",
        source_loaded_on: "2026-07-30",
        source_updated_at: new Date(),
      })
      .execute();
    const otherClass = await database
      .selectFrom("classes")
      .select(["academic_year", "edu_office_code", "grade", "school_code"])
      .where("id", "=", other.classId)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("school_schedule_events")
      .values({
        academic_year: otherClass.academic_year,
        edu_office_code: otherClass.edu_office_code,
        event_content: null,
        event_date: "2028-02-29",
        event_name: "다른 학교 행사",
        grade_mask: 1 << (otherClass.grade - 1),
        school_code: otherClass.school_code,
        school_day_type: "수업일",
        source_loaded_on: "2026-07-30",
        source_updated_at: new Date(),
      })
      .execute();
    const deleted = await seedSchedule(fixture, {
      dueDate: "2028-03-02",
      title: "삭제한 일정",
    });
    await database
      .updateTable("schedules")
      .set({
        deleted_at: new Date(),
        deleted_by_member_id: fixture.teacher.memberId!,
      })
      .where("id", "=", deleted.id)
      .execute();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/schedules/calendar?start_date=2028-01-30&end_date=2028-03-11",
      headers: fixture.students[0].headers,
    });
    expect(response.statusCode).toBe(200);
    const calendar = response.json() as ScheduleCalendar;
    expect(calendar).toMatchObject({
      end_date: "2028-03-11",
      oldest_visible_date: addCalendarDays(serverToday, -90),
      server_today: serverToday,
      start_date: "2028-01-30",
    });
    expect(calendar.items.map((item) => item.id)).toEqual([
      leapDayFirst.id,
      leapDaySecond.id,
      schoolEvent.id,
      nextMonth.id,
    ]);
    expect(calendar.items.map((item) => item.due_date)).toEqual([
      "2028-02-29",
      "2028-02-29",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(calendar.items.every((item) => item.days_until > 0)).toBe(true);
    expect(calendar.items[0]).toMatchObject({ source: "class" });
    expect(calendar.items[2]).toEqual(
      expect.objectContaining({
        description: "전 학년 정상 등교",
        school_day_type: "수업일",
        source: "school",
        source_loaded_on: "2026-07-30",
        target_grades: [currentClass.grade],
        title: "학교 공식 행사",
      }),
    );

    const empty = await app.inject({
      method: "GET",
      url: "/api/v1/schedules/calendar?start_date=2028-04-01&end_date=2028-04-30",
      headers: fixture.teacher.headers,
    });
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as ScheduleCalendar).items).toEqual([]);
  });

  it("keeps student task schedules off the teacher Home while preserving the student view", async () => {
    const today = await readDatabaseKstToday(database);
    const dueDate = addCalendarDays(today, 1);
    const assignment = await seedSchedule(fixture, {
      dueDate,
      scheduleType: "assignment",
      title: "학생 과제",
    });
    const performance = await seedSchedule(fixture, {
      dueDate,
      scheduleType: "performance",
      title: "학생 수행평가",
    });
    const exam = await seedSchedule(fixture, {
      dueDate,
      scheduleType: "exam",
      title: "시험 기간",
    });

    const [teacherHome, studentHome] = await Promise.all([
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/home",
      }),
      app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: "/api/v1/home",
      }),
    ]);
    expect(teacherHome.statusCode).toBe(200);
    expect(studentHome.statusCode).toBe(200);

    const teacherIds = (teacherHome.json().schedules.data as Array<{ id: string }>).map(
      (item) => item.id,
    );
    const studentIds = (studentHome.json().schedules.data as Array<{ id: string }>).map(
      (item) => item.id,
    );
    expect(teacherIds).toEqual([exam.id]);
    expect(new Set(studentIds)).toEqual(new Set([assignment.id, performance.id, exam.id]));
  });

  it("returns public holidays for the whole range, unclamped by the 90 day schedule cutoff", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const oldestVisibleDate = addCalendarDays(serverToday, -90);
    /*
     * 90일 경계를 걸치는 범위를 고른다. 일정은 경계 밖이 잘리지만 공휴일은 잘리면 안 된다 —
     * 잘리면 지난달 달력에서 빨간 날만 사라져 화면이 고장난 것처럼 보인다.
     */
    const startDate = addCalendarDays(oldestVisibleDate, -5);
    const endDate = addCalendarDays(startDate, 41);
    const beforeCutoff = addCalendarDays(oldestVisibleDate, -3);
    const afterCutoff = addCalendarDays(oldestVisibleDate, 3);
    const outsideRange = addCalendarDays(endDate, 1);
    const seeded = [beforeCutoff, afterCutoff, outsideRange];

    await database
      .insertInto("public_holidays")
      .values(
        seeded.map((date, index) => ({
          holiday_date: date,
          name: `검수 공휴일 ${index + 1}`,
          source: "kasi",
          source_loaded_on: serverToday,
        })),
      )
      .execute();

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/schedules/calendar?start_date=${startDate}&end_date=${endDate}`,
        headers: fixture.students[0].headers,
      });
      expect(response.statusCode).toBe(200);
      const calendar = response.json() as ScheduleCalendar;
      expect(calendar.oldest_visible_date).toBe(oldestVisibleDate);
      /* 경계 앞 공휴일이 살아 있어야 하고, 범위 밖은 오면 안 되며, 날짜순이어야 한다. */
      expect(calendar.holidays).toEqual([
        { date: beforeCutoff, name: "검수 공휴일 1" },
        { date: afterCutoff, name: "검수 공휴일 2" },
      ]);

      const emptyYear = await app.inject({
        method: "GET",
        url: "/api/v1/schedules/calendar?start_date=2099-01-01&end_date=2099-02-11",
        headers: fixture.teacher.headers,
      });
      expect(emptyYear.statusCode).toBe(200);
      /* 아직 동기화하지 않은 해는 빈 배열이다. 없는 것을 지어내지 않는다. */
      expect((emptyYear.json() as ScheduleCalendar).holidays).toEqual([]);
    } finally {
      await database
        .deleteFrom("public_holidays")
        .where(
          "holiday_date",
          "in",
          seeded.map((date) => sql<Date>`${date}::date`),
        )
        .execute();
    }
  });

  it("fails closed for unauthenticated, malformed, reversed, and over-42-day calendar ranges", async () => {
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/schedules/calendar?start_date=2028-01-30&end_date=2028-03-11",
      }),
      401,
      "UNAUTHENTICATED",
    );

    for (const query of [
      "start_date=2028-02-30&end_date=2028-03-01",
      "start_date=2028-03-02&end_date=2028-03-01",
      "start_date=2028-01-30&end_date=2028-03-12",
      "start_date=2028-01-30",
    ]) {
      expectError(
        await app.inject({
          method: "GET",
          url: `/api/v1/schedules/calendar?${query}`,
          headers: fixture.teacher.headers,
        }),
        400,
        "VALIDATION_FAILED",
      );
    }

    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/schedules/calendar?start_date=2028-01-30&end_date=2028-03-11",
        headers: fixture.outsider.headers,
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("preserves no-op state, enforces ETags, and re-exposes a past schedule after moving it", async () => {
    const today = kstDate(new Date());
    const schedule = await seedSchedule(fixture, {
      description: "준비 범위",
      dueDate: addCalendarDays(today, -1),
      scheduleType: "exam",
      subject: "수학",
      title: "지난 시험",
    });
    const beforeAudit = await database
      .selectFrom("audit_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("target_type", "=", "schedule")
      .where("target_id", "=", schedule.id)
      .executeTakeFirstOrThrow();

    const noOp = await app.inject({
      method: "PATCH",
      url: `/api/v1/schedules/${schedule.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: {
        description: "준비 범위",
        due_date: addCalendarDays(today, -1),
        schedule_type: "exam",
        subject: "수학",
        title: "지난 시험",
      },
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.headers.etag).toBe('"1"');
    const unchanged = await database
      .selectFrom("schedules")
      .select(["row_version", "updated_at"])
      .where("id", "=", schedule.id)
      .executeTakeFirstOrThrow();
    expect(unchanged.row_version).toBe("1");
    expect(unchanged.updated_at.toISOString()).toBe(schedule.updated_at.toISOString());

    const futureDate = addCalendarDays(today, 3);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/schedules/${schedule.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { due_date: futureDate, title: "다가오는 시험" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).toBe('"2"');
    expect(changed.json()).toMatchObject({
      d_day_label: "D-3",
      days_until: 3,
      due_date: futureDate,
      row_version: "2",
    });

    const home = await app.inject({
      method: "GET",
      url: "/api/v1/home",
      headers: fixture.teacher.headers,
    });
    expect(home.statusCode).toBe(200);
    expect(
      (home.json().schedules.data as Array<{ id: string }>).some((item) => item.id === schedule.id),
    ).toBe(true);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/schedules/${schedule.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { title: "낡은 수정" },
    });
    expectError(stale, 409, "RESOURCE_VERSION_CHANGED");
    expect(stale.json().error.details).toEqual({ current_row_version: "2" });

    const afterAudit = await database
      .selectFrom("audit_logs")
      .select(["after_json", "before_json"])
      .where("action", "=", "schedule.updated")
      .where("target_id", "=", schedule.id)
      .executeTakeFirstOrThrow();
    expect(afterAudit.before_json).toMatchObject({ due_date: addCalendarDays(today, -1) });
    expect(afterAudit.after_json).toMatchObject({ due_date: futureDate, title: "다가오는 시험" });
    expect(Number(beforeAudit.count)).toBe(0);
  });

  it("keeps create, update, list, calendar, and detail D-day on one DB KST date across Node clock drift", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const realNow = Date.now();
    const dueDate = addCalendarDays(serverToday, 1);
    await database
      .updateTable("sessions")
      .set({ expires_at: new Date(realNow + 3 * DAY_MS) })
      .where("user_id", "=", fixture.teacher.userId)
      .execute();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(realNow + DAY_MS));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: {
        ...fixture.teacher.headers,
        "idempotency-key": randomUUID(),
      },
      payload: {
        due_date: dueDate,
        schedule_type: "assignment",
        title: "DB 날짜 기준 일정",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.json()).toMatchObject({
      d_day_label: "D-1",
      days_until: 1,
      due_date: dueDate,
      row_version: "1",
    });

    vi.setSystemTime(new Date(realNow - DAY_MS));
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/schedules/${created.json().id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { subject: "창의적 체험활동" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      d_day_label: "D-1",
      days_until: 1,
      due_date: dueDate,
      row_version: "2",
      subject: "창의적 체험활동",
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/schedules?scope=upcoming",
      headers: fixture.teacher.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().server_today).toBe(serverToday);
    const listed = list.json().items.find((item: ScheduleItem) => item.id === created.json().id);
    expect(listed).toMatchObject({ d_day_label: "D-1", days_until: 1 });

    const calendar = await app.inject({
      method: "GET",
      url: `/api/v1/schedules/calendar?start_date=${dueDate}&end_date=${dueDate}`,
      headers: fixture.teacher.headers,
    });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json().server_today).toBe(serverToday);
    expect(calendar.json().items).toEqual([
      expect.objectContaining({
        d_day_label: "D-1",
        days_until: 1,
        id: created.json().id,
      }),
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/schedules/${created.json().id}`,
      headers: fixture.teacher.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      d_day_label: "D-1",
      days_until: 1,
    });
  });

  it("allows only one concurrent update for the same row version", async () => {
    const schedule = await seedSchedule(fixture, { title: "동시 수정 일정" });
    const responses = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/schedules/${schedule.id}`,
        headers: { ...fixture.teacher.headers, "if-match": '"1"' },
        payload: { title: "동시 수정 A" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/schedules/${schedule.id}`,
        headers: { ...fixture.teacher.headers, "if-match": '"1"' },
        payload: { title: "동시 수정 B" },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const audits = await database
      .selectFrom("audit_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("action", "=", "schedule.updated")
      .where("target_id", "=", schedule.id)
      .executeTakeFirstOrThrow();
    expect(audits.count).toBe("1");
  });

  it("soft deletes with a delete-shaped audit record and hides the resource", async () => {
    const schedule = await seedSchedule(fixture, {
      description: "감사 로그에는 제외되는 설명",
      scheduleType: "assignment",
      subject: "영어",
      title: "영어 과제",
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/schedules/${schedule.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { reason: "일정 취소" },
    });
    expect(deleted.statusCode).toBe(204);

    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/schedules/${schedule.id}`,
        headers: fixture.teacher.headers,
      }),
      404,
      "NOT_FOUND",
    );
    const row = await database
      .selectFrom("schedules")
      .select(["delete_reason", "deleted_at", "row_version"])
      .where("id", "=", schedule.id)
      .executeTakeFirstOrThrow();
    expect(row.delete_reason).toBe("일정 취소");
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.row_version).toBe("2");

    const audit = await database
      .selectFrom("audit_logs")
      .select(["action", "after_json", "before_json", "reason", "target_snapshot"])
      .where("action", "=", "schedule.deleted")
      .where("target_id", "=", schedule.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: "schedule.deleted",
      after_json: null,
      before_json: null,
      reason: "일정 취소",
    });
    expect(audit.target_snapshot).toMatchObject({
      deleted_at: null,
      schedule_id: schedule.id,
      schedule_type: "assignment",
      subject: "영어",
      title: "영어 과제",
    });
    expect(JSON.stringify(audit.target_snapshot)).not.toContain("description");
  });
});
