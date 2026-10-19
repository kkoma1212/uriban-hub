import { fetchNeisMeals, type NeisMeal } from "@classhub/neis";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { NeisMealsService } from "./neis-meals.service.js";

vi.mock("@classhub/neis", () => ({ fetchNeisMeals: vi.fn() }));
const school = { eduOfficeCode: "J10", schoolCode: "7530063" };
const meal: NeisMeal = {
  ...school,
  mealDate: "2026-09-10",
  sourceLoadedOn: "2026-09-01",
  calorieKcalTenths: 6321,
  menuJson: [{ name: "현미밥", allergens: [] }],
};
const fetchMeals = vi.mocked(fetchNeisMeals);
function service(key: string | undefined = "synthetic-neis-key") {
  return new NeisMealsService(
    new ConfigService({ NEIS_API_KEY: key }) as ConfigService<AppEnvironment, true>,
  );
}

describe("NEIS menu lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("preserves database-only operation when no key is configured", async () => {
    const reader = new NeisMealsService(new ConfigService({}));
    expect(await reader.range(school, "2026-09-10", "2026-09-10")).toBeUndefined();
    expect(fetchMeals).not.toHaveBeenCalled();
  });

  it("shares a monthly request across the home, week and month views", async () => {
    fetchMeals.mockResolvedValue([meal]);
    const reader = service();
    const [today, week, month] = await Promise.all([
      reader.range(school, "2026-09-10", "2026-09-10"),
      reader.range(school, "2026-09-07", "2026-09-11"),
      reader.range(school, "2026-09-01", "2026-09-30"),
    ]);
    expect(fetchMeals).toHaveBeenCalledTimes(1);
    expect(fetchMeals).toHaveBeenCalledWith(
      expect.objectContaining({ from: "2026-09-01", to: "2026-09-30", ...school }),
      expect.objectContaining({ timeoutMs: 3000 }),
    );
    expect(today).toEqual(week);
    expect(today).toEqual(month);
    expect(today?.[0]).toMatchObject({ calorie_kcal: 632.1, source: "neis", menu: meal.menuJson });
    expect(today?.[0]?.id).toMatch(/^[1-9][0-9]*$/u);
    expect(await reader.range(school, "2026-09-12", "2026-09-12")).toEqual([]);
  });

  it("reads both months when a school week crosses the month boundary", async () => {
    fetchMeals.mockImplementation(async (query) => [{ ...meal, mealDate: query.from }]);
    const items = await service().range(school, "2026-08-31", "2026-09-04");
    expect(fetchMeals).toHaveBeenCalledTimes(2);
    expect(items?.map((item) => item.meal_date)).toEqual(["2026-09-01"]);
  });

  it("refreshes cached menus after ten minutes and keeps provider IDs stable", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    fetchMeals.mockResolvedValue([meal]);
    const reader = service();
    const before = await reader.range(school, meal.mealDate, meal.mealDate);
    clock.mockReturnValue(now + 10 * 60_000);
    fetchMeals.mockResolvedValue([{ ...meal, menuJson: [{ name: "수정된 식단", allergens: [] }] }]);
    const after = await reader.range(school, meal.mealDate, meal.mealDate);
    expect(fetchMeals).toHaveBeenCalledTimes(2);
    expect(after?.[0]?.id).toBe(before?.[0]?.id);
    expect(after?.[0]?.menu[0]?.name).toBe("수정된 식단");
  });

  it("keeps schools separate and retries after a sanitized upstream failure", async () => {
    fetchMeals.mockRejectedValueOnce(new Error("secret-key-in-upstream-url"));
    const reader = service();
    await expect(reader.range(school, meal.mealDate, meal.mealDate)).rejects.toThrow(
      "학교 급식 정보를 불러오지 못했어요.",
    );
    fetchMeals.mockImplementation(async (query) => [{ ...meal, schoolCode: query.schoolCode }]);
    const first = await reader.range(school, meal.mealDate, meal.mealDate);
    const second = await reader.range(
      { ...school, schoolCode: "7530064" },
      meal.mealDate,
      meal.mealDate,
    );
    expect(first?.[0]?.id).not.toBe(second?.[0]?.id);
    expect(fetchMeals).toHaveBeenCalledTimes(3);
  });
});
