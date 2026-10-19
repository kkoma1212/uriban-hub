import { createHash } from "node:crypto";

import { fetchNeisMeals } from "@classhub/neis";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { addCalendarDays } from "../common/date/kst-date.js";
import type { AppEnvironment } from "../config/environment.js";
import { parseMealMenu } from "./meals.menu.js";
import type { MealItem } from "./meals.types.js";

interface School {
  eduOfficeCode: string;
  schoolCode: string;
}

interface CachedMonth {
  expiresAt: number;
  items: MealItem[];
}

/** School menus are public data. Credentials stay on the server; no account data is sent to NEIS. */
@Injectable()
export class NeisMealsService {
  private readonly cache = new Map<string, CachedMonth>();
  private readonly pending = new Map<string, Promise<MealItem[]>>();

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  async range(school: School, from: string, to: string): Promise<MealItem[] | undefined> {
    const apiKey = this.config.get("NEIS_API_KEY", { infer: true });
    if (apiKey === undefined) return undefined;
    const months = new Set([from.slice(0, 7), to.slice(0, 7)]);
    const results = await Promise.all(
      [...months].map((month) => this.month(school, month, apiKey)),
    );
    return results.flat().filter((meal) => meal.meal_date >= from && meal.meal_date <= to);
  }

  private async month(school: School, month: string, apiKey: string): Promise<MealItem[]> {
    const key = `${school.eduOfficeCode}:${school.schoolCode}:${month}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.items;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const request = this.loadMonth(school, month, apiKey).then((items) => {
      this.cache.delete(key);
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {
        expiresAt: Date.now() + (items.length === 0 ? 5 : 10) * 60_000,
        items,
      });
      return items;
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }

  private async loadMonth(school: School, month: string, apiKey: string): Promise<MealItem[]> {
    const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
      .toISOString()
      .slice(0, 10);
    try {
      const meals = await fetchNeisMeals(
        { ...school, apiKey, from: `${month}-01`, to: addCalendarDays(nextMonth, -1) },
        { timeoutMs: 3_000, retryDelayMs: 100 },
      );
      const fetchedAt = new Date().toISOString();
      return meals.map((meal) => ({
        // These read-only provider IDs are stable across dates, schools and app instances.
        id: String(
          (createHash("sha256")
            .update(`neis:${meal.eduOfficeCode}:${meal.schoolCode}:${meal.mealDate}`)
            .digest()
            .readBigUInt64BE(0) >>
            1n) +
            1n,
        ),
        calorie_kcal: meal.calorieKcalTenths === null ? null : meal.calorieKcalTenths / 10,
        meal_date: meal.mealDate,
        menu: parseMealMenu(meal.menuJson),
        source: "neis",
        source_loaded_on: meal.sourceLoadedOn,
        source_updated_at: fetchedAt,
      }));
    } catch {
      throw new ServiceUnavailableException({
        code: "MEAL_SOURCE_UNAVAILABLE",
        message: "학교 급식 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
      });
    }
  }
}
