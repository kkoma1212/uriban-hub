import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays, startOfKstWeek } from "../src/common/date/kst-date.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface SchoolIdentity {
  eduOfficeCode: string;
  schoolCode: string;
}

let fixture: ClassFixture;
const DAY_MS = 24 * 60 * 60 * 1_000;

async function schoolFor(target: ClassFixture): Promise<SchoolIdentity> {
  const row = await database
    .selectFrom("classes")
    .select(["edu_office_code", "school_code"])
    .where("id", "=", target.classId)
    .executeTakeFirstOrThrow();
  return { eduOfficeCode: row.edu_office_code, schoolCode: row.school_code };
}

async function seedMeal(
  school: SchoolIdentity,
  date: string,
  menu: Array<{ allergens: string[]; name: string }> = [{ allergens: [], name: "현미밥" }],
  calorieKcalTenths: number | null = null,
) {
  const sourceUpdatedAt = new Date();
  const row = await database
    .insertInto("meals")
    .values({
      calorie_kcal_tenths: calorieKcalTenths,
      edu_office_code: school.eduOfficeCode,
      meal_date: date,
      meal_type: "lunch",
      menu_json: sql`${JSON.stringify(menu)}::jsonb`,
      school_code: school.schoolCode,
      source: "seed",
      source_updated_at: sourceUpdatedAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { ...row, sourceUpdatedAt };
}

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

beforeAll(setupSuppliesHarness, 120_000);
beforeEach(async () => {
  fixture = await createClassFixture();
});
afterEach(() => vi.useRealTimers());
afterAll(teardownSuppliesHarness, 120_000);

describe("meals HTTP contract", () => {
  it("requires an approved current class and blocks a suspended class", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/meals/today" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/meals/week",
        headers: fixture.outsider.headers,
      }),
      404,
      "NOT_FOUND",
    );

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/meals/today",
          headers: fixture.students[0].headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/meals/week",
          headers: fixture.teacher.headers,
        })
      ).statusCode,
    ).toBe(200);

    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: new Date(),
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "급식 통합 테스트",
      })
      .where("id", "=", fixture.classId)
      .execute();
    expectError(
      await app.inject({
        method: "GET",
        url: "/api/v1/meals/today",
        headers: fixture.teacher.headers,
      }),
      423,
      "CLASS_SUSPENDED",
    );
  });

  it("shares one school meal row across different classes without accepting a school input", async () => {
    const databaseToday = await readDatabaseKstToday(database);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - DAY_MS));
    const school = await schoolFor(fixture);
    const other = await createClassFixture();
    await database
      .updateTable("classes")
      .set({ edu_office_code: school.eduOfficeCode, school_code: school.schoolCode })
      .where("id", "=", other.classId)
      .execute();
    const seeded = await seedMeal(school, databaseToday, [
      { allergens: ["1", "2"], name: "달걀국" },
    ]);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/meals/today",
      headers: fixture.students[0].headers,
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/v1/meals/today",
      headers: other.teacher.headers,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({
      data: {
        calorie_kcal: null,
        id: seeded.id,
        meal_date: databaseToday,
        menu: [{ allergens: ["1", "2"], name: "달걀국" }],
        source: "seed",
        source_loaded_on: null,
        source_updated_at: seeded.sourceUpdatedAt.toISOString(),
      },
      server_today: databaseToday,
      status: "ok",
    });
    expect(second.json()).toEqual(first.json());
  });

  it("exposes NEIS provenance with its date-only upstream load precision", async () => {
    const databaseToday = await readDatabaseKstToday(database);
    const school = await schoolFor(fixture);
    const seeded = await seedMeal(school, databaseToday, [
      { allergens: ["1"], name: "NEIS 검증 급식" },
    ]);
    await database
      .updateTable("meals")
      .set({
        calorie_kcal_tenths: 14_522,
        source: "neis",
        source_loaded_on: "2026-07-29",
      })
      .where("id", "=", seeded.id)
      .execute();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/meals/today",
      headers: fixture.students[0].headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        calorie_kcal: 1452.2,
        source: "neis",
        source_loaded_on: "2026-07-29",
        source_updated_at: seeded.sourceUpdatedAt.toISOString(),
      },
      status: "ok",
    });
  });

  it("uses one DB KST date for fixed Monday-to-Friday and today views despite Node clock drift", async () => {
    const databaseToday = await readDatabaseKstToday(database);
    await database
      .updateTable("sessions")
      .set({ expires_at: sql<Date>`CURRENT_TIMESTAMP + INTERVAL '48 hours'` })
      .where("user_id", "=", fixture.students[0].userId)
      .execute();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + DAY_MS));
    const school = await schoolFor(fixture);
    const monday = startOfKstWeek(databaseToday);
    const weekDates = Array.from({ length: 5 }, (_, offset) => addCalendarDays(monday, offset));
    const mealNames = new Map<string, string>([
      [monday, "월요일밥"],
      [addCalendarDays(monday, 4), "금요일밥"],
      [databaseToday, "오늘밥"],
    ]);
    for (const [date, name] of mealNames) {
      await seedMeal(school, date, [{ allergens: [], name }]);
    }

    const weekly = await app.inject({
      method: "GET",
      url: "/api/v1/meals/week",
      headers: fixture.students[0].headers,
    });
    const today = await app.inject({
      method: "GET",
      url: "/api/v1/meals/today",
      headers: fixture.students[0].headers,
    });

    expect(weekly.statusCode).toBe(200);
    const weeklyBody = weekly.json() as {
      items: Array<{
        data: null | { menu: Array<{ name: string }> };
        date: string;
        status: string;
      }>;
      server_today: string;
    };
    expect(weeklyBody.server_today).toBe(databaseToday);
    expect(weeklyBody.items.map((item) => item.date)).toEqual(weekDates);
    expect(weeklyBody.items.map((item) => item.status)).toEqual(
      weekDates.map((date) => (mealNames.has(date) ? "ok" : "empty")),
    );
    expect(JSON.stringify(weeklyBody).includes("오늘밥")).toBe(weekDates.includes(databaseToday));
    expect(today.json()).toMatchObject({
      data: {
        meal_date: databaseToday,
        menu: [{ name: "오늘밥" }],
        source: "seed",
        source_loaded_on: null,
        source_updated_at: expect.any(String),
      },
      server_today: databaseToday,
      status: "ok",
    });
    expect(today.json().server_today).toBe(weeklyBody.server_today);
  });

  it("returns every date in a requested leap month with nullable meals and calories", async () => {
    const school = await schoolFor(fixture);
    await seedMeal(school, "2028-02-01", [{ allergens: ["1"], name: "2월 첫 급식" }], 8_034);
    await seedMeal(school, "2028-02-29", [{ allergens: [], name: "윤년 마지막 급식" }]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/meals/month?month=2028-02",
      headers: fixture.students[0].headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{
        data: null | { calorie_kcal: number | null; menu: Array<{ name: string }> };
        date: string;
        status: "empty" | "ok";
      }>;
      month: string;
      server_today: string;
    };
    expect(body.month).toBe("2028-02");
    expect(body.items).toHaveLength(29);
    expect(body.items[0]).toMatchObject({
      data: { calorie_kcal: 803.4, menu: [{ name: "2월 첫 급식" }] },
      date: "2028-02-01",
      status: "ok",
    });
    expect(body.items[1]).toEqual({ data: null, date: "2028-02-02", status: "empty" });
    expect(body.items[28]).toMatchObject({
      data: { calorie_kcal: null, menu: [{ name: "윤년 마지막 급식" }] },
      date: "2028-02-29",
      status: "ok",
    });
    expect(body.server_today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("rejects an invalid month before querying meals", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/meals/month?month=2028-13",
      headers: fixture.students[0].headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});
