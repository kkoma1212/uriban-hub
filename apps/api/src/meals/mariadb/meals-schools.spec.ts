import { createMariaDbDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { Kysely, PostgresDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ClassRoleInsufficientException } from "../../classes/classes.errors.js";
import { SchoolsService } from "../../schools/schools.service.js";
import { MealsAccessService } from "../meals-access.service.js";
import { MealsService } from "../meals.service.js";
import { NeisMealsService } from "../neis-meals.service.js";
import type { MealItem } from "../meals.types.js";
import {
  MealClassSuspendedException,
  MealNotFoundException,
  MealRoleInsufficientException,
} from "../meals.errors.js";

type Step = { rows?: Record<string, unknown>[]; error?: unknown };
const actorId = "9007199254740993",
  mealId = "9007199254740995";
const databases: Kysely<DB>[] = [];
const menu: MealItem["menu"] = [
  { name: "잡곡밥", allergens: ["5", "6"] },
  { name: "사과", allergens: [] },
];
const account = (overrides: Record<string, unknown> = {}) => ({
  deleted_at: null,
  is_active: 1,
  profile_status: "active",
  temporary_password_must_change: 0,
  ...overrides,
});
const context = (overrides: Record<string, unknown> = {}) => ({
  ...account(),
  edu_office_code: "B10",
  school_code: "7010001",
  class_status: "active",
  role: "teacher",
  ...overrides,
});
const meal = (overrides: Record<string, unknown> = {}) => ({
  id: mealId,
  calorie_kcal_tenths: 6732,
  meal_date: "2026-09-08",
  menu_json: JSON.stringify(menu),
  source: "neis",
  source_loaded_on: "2026-09-07",
  source_updated_at: "2026-09-07 15:00:00.123456",
  ...overrides,
});
const clock = (today = "2026-09-08") => ({ rows: [{ server_today: today }] });

function boundary(
  steps: Step[],
  engine: "mariadb" | "postgres" = "mariadb",
  neis?: NeisMealsService,
) {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const release = vi.fn(),
    destroy = vi.fn();
  function response(statement: string, parameters: readonly unknown[]): Step {
    statements.push({ sql: statement, parameters });
    if (/^\s*select\b/iu.test(statement))
      return steps.shift() ?? { error: new Error("Unexpected synthetic query") };
    if (
      /^(ROLLBACK|SET SESSION |SET NAMES |SET time_zone|SET sql_mode|SET autocommit)/iu.test(
        statement,
      )
    )
      return {};
    return { error: new Error("Read-only feature attempted an unexpected SQL command") };
  }
  const database =
    engine === "mariadb"
      ? createMariaDbDatabase<DB>(
          () => ({
            getConnection: (callback) =>
              callback(null, {
                query(statement, parameters, callback) {
                  const result = response(statement, parameters);
                  callback(result.error, result.rows ?? { affectedRows: 0, insertId: 0 });
                },
                release,
                destroy,
              }),
            end: (callback) => callback(null),
          }),
          {
            host: "read-only.test.invalid",
            database: "synthetic",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
          },
        )
      : new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: {
              connect: async () => ({
                query: async (statement: string, parameters: readonly unknown[] = []) => {
                  const result = response(statement, parameters);
                  if (result.error) throw result.error;
                  return {
                    rows: result.rows ?? [],
                    command: "SELECT",
                    rowCount: result.rows?.length ?? 0,
                  };
                },
                release,
              }),
              end: async () => undefined,
            } as never,
          }),
        });
  databases.push(database);
  const config =
    engine === "mariadb"
      ? new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine })
      : undefined;
  const access = new MealsAccessService(database, config);
  return {
    database,
    steps,
    release,
    destroy,
    statements,
    access,
    meals: new MealsService(database, access, config, neis),
    schools: new SchoolsService(database, config),
    queries: () => statements.filter(({ sql }) => /^\s*select\b/iu.test(sql)),
  };
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("MariaDB meal cache reads with the product compiler and guarded driver", () => {
  it("shows live school menus when the imported table is empty", async () => {
    const neis = new NeisMealsService(new ConfigService<AppEnvironment, true>({}));
    const liveMeal = {
      id: "42",
      calorie_kcal: 673.2,
      meal_date: "2026-09-08",
      menu,
      source: "neis" as const,
      source_loaded_on: "2026-09-08",
      source_updated_at: "2026-09-08T00:00:00.000Z",
    };
    const range = vi.spyOn(neis, "range").mockResolvedValue([liveMeal]);
    const target = boundary([clock(), { rows: [context()] }, { rows: [] }], "mariadb", neis);
    await expect(target.meals.today(actorId)).resolves.toEqual({
      status: "ok",
      server_today: "2026-09-08",
      data: liveMeal,
    });
    expect(range).toHaveBeenCalledWith(
      { eduOfficeCode: "B10", schoolCode: "7010001" },
      "2026-09-08",
      "2026-09-08",
    );
  });

  it("honors an official empty menu instead of showing stale imported data", async () => {
    const neis = new NeisMealsService(new ConfigService<AppEnvironment, true>({}));
    vi.spyOn(neis, "range").mockResolvedValue([]);
    const target = boundary([clock(), { rows: [context()] }, { rows: [meal()] }], "mariadb", neis);
    await expect(target.meals.today(actorId)).resolves.toMatchObject({
      status: "empty",
      data: null,
    });
  });

  it("keeps imported menus available during a provider outage", async () => {
    const neis = new NeisMealsService(new ConfigService<AppEnvironment, true>({}));
    vi.spyOn(neis, "range").mockRejectedValue(new ServiceUnavailableException());
    const target = boundary([clock(), { rows: [context()] }, { rows: [meal()] }], "mariadb", neis);
    await expect(target.meals.today(actorId)).resolves.toMatchObject({
      status: "ok",
      data: { id: mealId, menu },
    });
  });

  it("reports an outage when there is no imported menu to fall back to", async () => {
    const neis = new NeisMealsService(new ConfigService<AppEnvironment, true>({}));
    vi.spyOn(neis, "range").mockRejectedValue(new ServiceUnavailableException());
    const target = boundary([clock(), { rows: [context()] }, { rows: [] }], "mariadb", neis);
    await expect(target.meals.today(actorId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("checks class access before calling the provider", async () => {
    const neis = new NeisMealsService(new ConfigService<AppEnvironment, true>({}));
    const range = vi.spyOn(neis, "range");
    const target = boundary(
      [clock(), { rows: [context({ class_status: "archived" })] }],
      "mariadb",
      neis,
    );
    await expect(target.meals.today(actorId)).rejects.toBeInstanceOf(MealNotFoundException);
    expect(range).not.toHaveBeenCalled();
  });

  it("uses DB KST today, strict DATE/DB6, exact BIGINT and wire JSON without changing menu policy", async () => {
    const target = boundary([clock(), { rows: [context()] }, { rows: [meal()] }]);
    await expect(target.meals.today(actorId)).resolves.toEqual({
      status: "ok",
      server_today: "2026-09-08",
      data: {
        id: mealId,
        calorie_kcal: 673.2,
        meal_date: "2026-09-08",
        menu,
        source: "neis",
        source_loaded_on: "2026-09-07",
        source_updated_at: "2026-09-07T15:00:00.123Z",
      },
    });
    const queries = target.queries();
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("UTC_TIMESTAMP(6)");
    expect(queries[0]?.sql).toContain("INTERVAL 9 HOUR");
    expect(queries[1]?.parameters).toEqual([actorId, "approved"]);
    expect(queries[2]?.sql).toContain("`meal_date` = CAST(? AS DATE)");
    expect(queries[2]?.parameters).toEqual(["B10", "7010001", "2026-09-08", "lunch"]);
    expect(queries.map((query) => query.sql).join("\n")).not.toMatch(
      /::|AT TIME ZONE|\b(?:RETURNING|INSERT|UPDATE|DELETE)\b/iu,
    );
    expect(target.steps).toHaveLength(0);
  });

  it("returns empty cache data without an external refresh or a cache write", async () => {
    const target = boundary([
      clock(),
      {
        rows: [
          context({ role: "student", profile_status: null, temporary_password_must_change: null }),
        ],
      },
      { rows: [] },
    ]);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External NEIS call forbidden"));
    try {
      await expect(target.meals.today(actorId)).resolves.toEqual({
        data: null,
        server_today: "2026-09-08",
        status: "empty",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(target.queries()).toHaveLength(3);
      expect(target.steps).toHaveLength(0);
    } finally {
      fetch.mockRestore();
    }
  });

  it("fills exactly Monday-Friday across a year boundary", async () => {
    const row = meal({
      meal_date: "2026-12-30",
      source: "seed",
      source_loaded_on: null,
      calorie_kcal_tenths: null,
    });
    const target = boundary([clock("2027-01-03"), { rows: [context()] }, { rows: [row] }]);
    const result = await target.meals.week(actorId);
    expect(result.server_today).toBe("2027-01-03");
    expect(result.items.map((item) => item.date)).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(result.items.map((item) => item.status)).toEqual([
      "empty",
      "empty",
      "ok",
      "empty",
      "empty",
    ]);
    expect(result.items[2]?.data).toMatchObject({
      calorie_kcal: null,
      source_loaded_on: null,
      id: mealId,
    });
    expect(
      result.items.filter((item) => item.status === "empty").every((item) => item.data === null),
    ).toBe(true);
    expect(target.queries()[2]?.parameters).toEqual([
      "B10",
      "7010001",
      "2026-12-28",
      "2027-01-01",
      "lunch",
    ]);
    expect(target.queries()[2]?.sql).toContain("order by `meal_date` asc");
  });

  it.each([
    ["2028-02", "2028-03-01", 29],
    ["2027-02", "2027-03-01", 28],
    ["2100-12", "2101-01-01", 31],
  ] as const)("fills every day of %s and excludes the next month", async (month, next, days) => {
    const target = boundary([clock(), { rows: [context()] }, { rows: [] }]);
    const result = await target.meals.month(actorId, month);
    expect(result).toMatchObject({ month, server_today: "2026-09-08" });
    expect(result.items).toHaveLength(days);
    expect(result.items[0]).toEqual({ date: `${month}-01`, data: null, status: "empty" });
    expect(result.items.at(-1)).toEqual({ date: `${month}-${days}`, data: null, status: "empty" });
    expect(target.queries()[2]?.parameters).toEqual([
      "B10",
      "7010001",
      `${month}-01`,
      next,
      "lunch",
    ]);
    expect(target.queries()[2]?.sql).toContain("`meal_date` < CAST(? AS DATE)");
  });

  it("keeps the PostgreSQL constructor default, date casts and decoded menu values", async () => {
    const row = meal({
      meal_date: new Date(2026, 8, 8),
      source_loaded_on: new Date(2026, 8, 7),
      source_updated_at: new Date("2026-09-07T15:00:00.123Z"),
      menu_json: menu,
    });
    const target = boundary(
      [
        clock(),
        { rows: [context({ is_active: true, temporary_password_must_change: false })] },
        { rows: [row] },
      ],
      "postgres",
    );
    const result = await target.meals.today(actorId);
    expect(result.data).toMatchObject({
      id: mealId,
      meal_date: "2026-09-08",
      menu,
      source_updated_at: "2026-09-07T15:00:00.123Z",
    });
    expect(target.queries()[0]?.sql).toContain("AT TIME ZONE");
    expect(target.queries()[2]?.sql).toMatch(/\$3::date/u);
  });

  it.each([
    [{ is_active: 0 }, MealNotFoundException],
    [{ deleted_at: "2026-09-07 15:00:00.123456" }, MealNotFoundException],
    [{ class_status: "archived" }, MealNotFoundException],
    [{ class_status: "suspended" }, MealClassSuspendedException],
    [{ role: "guardian" }, MealRoleInsufficientException],
    [{ profile_status: "inactive" }, MealRoleInsufficientException],
    [{ temporary_password_must_change: 1 }, MealRoleInsufficientException],
  ] as const)(
    "denies invalid current school context %j before reading meals",
    async (overrides, error) => {
      const target = boundary([clock(), { rows: [context(overrides)] }]);
      await expect(target.meals.today(actorId)).rejects.toBeInstanceOf(error);
      expect(target.queries()).toHaveLength(2);
      expect(target.steps).toHaveLength(0);
    },
  );

  it("does not invent school context when no approved membership exists", async () => {
    const target = boundary([{ rows: [] }]);
    await expect(target.access.getCurrentSchool(actorId)).rejects.toBeInstanceOf(
      MealNotFoundException,
    );
    expect(target.queries()).toHaveLength(1);
  });

  it.each([{ is_active: "1" }, { temporary_password_must_change: 2 }])(
    "fails closed on malformed MariaDB authorization scalars %j",
    async (overrides) => {
      const target = boundary([{ rows: [context(overrides)] }]);
      await expect(target.access.getCurrentSchool(actorId)).rejects.toThrow(
        "Invalid MariaDB application value.",
      );
      expect(target.queries()).toHaveLength(1);
    },
  );

  it.each([
    { meal_date: "2026-02-30" },
    { source_loaded_on: "2026-13-01" },
    { source_updated_at: "2026-09-07 25:00:00.123456" },
    { id: 9007199254740996 },
    { calorie_kcal_tenths: -1 },
  ])("rejects malformed cache scalars %j", async (overrides) => {
    const target = boundary([clock(), { rows: [context()] }, { rows: [meal(overrides)] }]);
    await expect(target.meals.today(actorId)).rejects.toThrow("Invalid MariaDB application value.");
    expect(target.queries()).toHaveLength(3);
  });

  it("does not expose malformed wire JSON in its error", async () => {
    const target = boundary([
      clock(),
      { rows: [context()] },
      { rows: [meal({ menu_json: "private malformed JSON" })] },
    ]);
    await expect(target.meals.today(actorId)).rejects.toThrow(/^Invalid MariaDB meal JSON\.$/u);
  });

  it("applies the original allergen validation after JSON decoding", async () => {
    const target = boundary([
      clock(),
      { rows: [context()] },
      { rows: [meal({ menu_json: '[{"name":"합성 메뉴","allergens":["20"]}]' })] },
    ]);
    await expect(target.meals.today(actorId)).rejects.toThrow("알레르기 코드가 올바르지 않습니다.");
  });

  it("does not retry a native MariaDB cache read error", async () => {
    const failure = Object.assign(new Error("Synthetic read failure"), {
      errno: 1213,
      sqlState: "40001",
    });
    const target = boundary([clock(), { rows: [context()] }, { error: failure }]);
    await expect(target.meals.today(actorId)).rejects.toBe(failure);
    expect(target.queries()).toHaveLength(3);
  });
});

describe("MariaDB teacher school search", () => {
  it("binds literal search text, excludes elementary schools and preserves prefix/name/code order", async () => {
    const school = {
      edu_office_code: "B10",
      school_code: "7010001",
      school_kind: "middle",
      school_name: "A%_\\중학교",
      region_name: "서울",
      edu_office_name: "서울교육청",
    };
    const target = boundary([{ rows: [account()] }, { rows: [school] }]);
    await expect(target.schools.search(actorId, "  A%_\\  ")).resolves.toEqual({
      schools: [school],
    });
    const [authorization, search] = target.queries();
    expect(authorization?.parameters).toEqual([actorId]);
    expect(search?.parameters).toEqual(["A%_\\", "elementary", "A%_\\", "A%_\\", 20]);
    expect(search?.sql).toContain("LOCATE(LOWER(?), LOWER(school_name)) > 0");
    expect(search?.sql).not.toMatch(/\bLIKE\b|::|position\(/iu);
    expect(search?.sql).toContain(
      "CASE WHEN left(lower(school_name), char_length(?)) = lower(?) THEN 0 ELSE 1 END",
    );
    expect(search?.sql).toContain("`school_name`, `school_code` limit ?");
    expect(target.steps).toHaveLength(0);
  });

  it("retains PostgreSQL literal POSITION search by default", async () => {
    const target = boundary(
      [
        { rows: [account({ is_active: true, temporary_password_must_change: false })] },
        { rows: [] },
      ],
      "postgres",
    );
    await expect(target.schools.search(actorId, "  %_  ")).resolves.toEqual({ schools: [] });
    expect(target.queries()[1]?.sql).toContain("position(lower($1) in lower(school_name)) > 0");
    expect(target.queries()[1]?.parameters).toEqual(["%_", "elementary", "%_", "%_", 20]);
  });

  it.each([
    [{ is_active: 0 }, UnauthenticatedException],
    [{ deleted_at: "2026-09-07 15:00:00.123456" }, UnauthenticatedException],
    [
      { profile_status: null, temporary_password_must_change: null },
      ClassRoleInsufficientException,
    ],
    [{ profile_status: "inactive" }, ClassRoleInsufficientException],
    [{ temporary_password_must_change: 1 }, ClassRoleInsufficientException],
  ] as const)("authorizes before exposing school results for %j", async (overrides, error) => {
    const target = boundary([{ rows: [account(overrides)] }]);
    await expect(target.schools.search(actorId, "학교")).rejects.toBeInstanceOf(error);
    expect(target.queries()).toHaveLength(1);
  });

  it("rejects malformed authorization booleans instead of treating string zero as active", async () => {
    const target = boundary([{ rows: [account({ is_active: "0" })] }]);
    await expect(target.schools.search(actorId, "학교")).rejects.toThrow(
      "Invalid MariaDB application value.",
    );
    expect(target.queries()).toHaveLength(1);
  });

  it("rejects unsupported engines for all three services before querying", () => {
    const target = boundary([]);
    const invalid = new ConfigService({ DATABASE_ENGINE: "other" }) as unknown as ConfigService<
      AppEnvironment,
      true
    >;
    expect(() => new MealsService(target.database, target.access, invalid)).toThrow(
      "Unsupported meals database engine.",
    );
    expect(() => new MealsAccessService(target.database, invalid)).toThrow(
      "Unsupported meals database engine.",
    );
    expect(() => new SchoolsService(target.database, invalid)).toThrow(
      "Unsupported schools database engine.",
    );
    expect(target.statements).toHaveLength(0);
  });
});
