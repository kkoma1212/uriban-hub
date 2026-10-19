import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import { addCalendarDays, databaseDate, startOfKstWeek } from "../common/date/kst-date.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import type { AppEnvironment } from "../config/environment.js";
import { mealDateSql, mealsDatabase } from "./mariadb/meals-database.js";
import { MealsAccessService } from "./meals-access.service.js";
import { parseMealMenu } from "./meals.menu.js";
import { NeisMealsService } from "./neis-meals.service.js";
import type {
  MealItem,
  MonthMealDay,
  MonthMealsResult,
  TodayMealResult,
  WeekMealDay,
  WeekMealsResult,
} from "./meals.types.js";

export interface MealRow {
  calorie_kcal_tenths: number | null;
  id: string;
  meal_date: Date | string;
  menu_json: unknown;
  source: string;
  source_loaded_on: Date | string | null;
  source_updated_at: Date;
}

function mealView(row: MealRow): MealItem {
  return {
    calorie_kcal: row.calorie_kcal_tenths === null ? null : row.calorie_kcal_tenths / 10,
    id: row.id,
    meal_date: databaseDate(row.meal_date),
    menu: parseMealMenu(row.menu_json),
    source: row.source as MealItem["source"],
    source_loaded_on: row.source_loaded_on === null ? null : databaseDate(row.source_loaded_on),
    source_updated_at: row.source_updated_at.toISOString(),
  };
}

const MEAL_COLUMNS = [
  "calorie_kcal_tenths",
  "id",
  "meal_date",
  "menu_json",
  "source",
  "source_loaded_on",
  "source_updated_at",
] as const;

function startOfNextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber === 12
    ? `${String(year + 1).padStart(4, "0")}-01-01`
    : `${String(year).padStart(4, "0")}-${String(monthNumber + 1).padStart(2, "0")}-01`;
}

@Injectable()
export class MealsService {
  private readonly engine: "postgres" | "mariadb";

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    private readonly access: MealsAccessService,
    @Optional() @Inject(ConfigService) config?: ConfigService<AppEnvironment, true>,
    @Optional() private readonly neis?: NeisMealsService,
  ) {
    ({ database: this.database, engine: this.engine } = mealsDatabase(database, config));
  }

  async today(actorUserId: string): Promise<TodayMealResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCurrentSchool(actorUserId);
    const row = await this.database
      .selectFrom("meals")
      .select(MEAL_COLUMNS)
      .where("edu_office_code", "=", context.eduOfficeCode)
      .where("school_code", "=", context.schoolCode)
      .where("meal_date", "=", mealDateSql(serverToday, this.engine))
      .where("meal_type", "=", "lunch")
      .executeTakeFirst();

    const [meal] = await this.resolveMeals(
      row === undefined ? [] : [row],
      context,
      serverToday,
      serverToday,
    );
    return meal === undefined
      ? { data: null, server_today: serverToday, status: "empty" }
      : { data: meal, server_today: serverToday, status: "ok" };
  }

  async week(actorUserId: string): Promise<WeekMealsResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCurrentSchool(actorUserId);
    const monday = startOfKstWeek(serverToday);
    const friday = addCalendarDays(monday, 4);
    const rows = await this.database
      .selectFrom("meals")
      .select(MEAL_COLUMNS)
      .where("edu_office_code", "=", context.eduOfficeCode)
      .where("school_code", "=", context.schoolCode)
      .where("meal_date", ">=", mealDateSql(monday, this.engine))
      .where("meal_date", "<=", mealDateSql(friday, this.engine))
      .where("meal_type", "=", "lunch")
      .orderBy("meal_date", "asc")
      .execute();
    const meals = await this.resolveMeals(rows, context, monday, friday);
    const byDate = new Map(meals.map((meal) => [meal.meal_date, meal]));
    const items: WeekMealDay[] = Array.from({ length: 5 }, (_, offset) => {
      const date = addCalendarDays(monday, offset);
      const row = byDate.get(date);
      return row === undefined
        ? { data: null, date, status: "empty" as const }
        : { data: row, date, status: "ok" as const };
    });

    return { items, server_today: serverToday };
  }

  async month(actorUserId: string, month: string): Promise<MonthMealsResult> {
    const serverToday = await readDatabaseKstToday(this.database, this.engine);
    const context = await this.access.getCurrentSchool(actorUserId);
    const firstDate = `${month}-01`;
    const nextMonthFirstDate = startOfNextMonth(month);
    const rows = await this.database
      .selectFrom("meals")
      .select(MEAL_COLUMNS)
      .where("edu_office_code", "=", context.eduOfficeCode)
      .where("school_code", "=", context.schoolCode)
      .where("meal_date", ">=", mealDateSql(firstDate, this.engine))
      .where("meal_date", "<", mealDateSql(nextMonthFirstDate, this.engine))
      .where("meal_type", "=", "lunch")
      .orderBy("meal_date", "asc")
      .execute();
    const lastDate = addCalendarDays(nextMonthFirstDate, -1);
    const meals = await this.resolveMeals(rows, context, firstDate, lastDate);
    const byDate = new Map(meals.map((meal) => [meal.meal_date, meal]));
    const dayCount = Number(lastDate.slice(8, 10));
    const items: MonthMealDay[] = Array.from({ length: dayCount }, (_, offset) => {
      const date = addCalendarDays(firstDate, offset);
      const row = byDate.get(date);
      return row === undefined
        ? { data: null, date, status: "empty" as const }
        : { data: row, date, status: "ok" as const };
    });

    return { items, month, server_today: serverToday };
  }

  /**
   * 홈 '오늘 급식' 카드용(2026-10-03 총검수 A1-01). 홈이 이미 읽은 그날 점심 저장본에 급식 탭과
   * 같은 규칙(나이스 실시간 → 장애면 저장본, 둘 다 없으면 오류)을 적용해 두 화면이 어긋나지 않게 한다.
   */
  async resolveSchoolLunch(
    row: MealRow | undefined,
    school: { eduOfficeCode: string; schoolCode: string },
    date: string,
  ): Promise<MealItem | null> {
    const [meal] = await this.resolveMeals(row === undefined ? [] : [row], school, date, date);
    return meal ?? null;
  }

  private async resolveMeals(
    rows: MealRow[],
    school: { eduOfficeCode: string; schoolCode: string },
    from: string,
    to: string,
  ): Promise<MealItem[]> {
    try {
      const current = await this.neis?.range(school, from, to);
      if (current !== undefined) return current;
    } catch (error) {
      // Preserve imported menus during an upstream outage, but never report an outage as no meal.
      if (rows.length === 0) throw error;
    }
    return rows.map(mealView);
  }
}
