import { describe, expect, it, vi } from "vitest";

import { MealsService, type MealRow } from "./meals.service.js";
import type { NeisMealsService } from "./neis-meals.service.js";

// 홈 카드가 쓰는 resolveSchoolLunch는 급식 탭과 같은 규칙이어야 한다(2026-10-03 총검수 A1-01).
const school = { eduOfficeCode: "J10", schoolCode: "7530000" };
const date = "2026-10-05";
const storedRow: MealRow = {
  calorie_kcal_tenths: 6500,
  id: "1",
  meal_date: date,
  menu_json: [{ allergens: [], name: "저장된 메뉴" }],
  source: "neis",
  source_loaded_on: date,
  source_updated_at: new Date("2026-10-01T00:00:00.000Z"),
};
const liveLunch = {
  calorie_kcal: 700,
  id: "neis:J10:7530000:2026-10-05",
  meal_date: date,
  menu: [{ allergens: [], name: "나이스 메뉴" }],
  source: "neis" as const,
  source_loaded_on: null,
  source_updated_at: "2026-10-05T00:00:00.000Z",
};
const service = (neis?: Partial<NeisMealsService>) =>
  new MealsService({} as never, {} as never, undefined, neis as NeisMealsService | undefined);

describe("MealsService.resolveSchoolLunch", () => {
  it("prefers the live NEIS lunch over the stored row, like the meals tab", async () => {
    const range = vi.fn().mockResolvedValue([liveLunch]);
    await expect(service({ range }).resolveSchoolLunch(storedRow, school, date)).resolves.toEqual(
      liveLunch,
    );
    expect(range).toHaveBeenCalledWith(school, date, date);
  });

  it("uses the stored row without a NEIS key and keeps it during an outage", async () => {
    const stored = await service({
      range: vi.fn().mockResolvedValue(undefined),
    }).resolveSchoolLunch(storedRow, school, date);
    expect(stored?.menu[0]?.name).toBe("저장된 메뉴");
    const outage = vi.fn().mockRejectedValue(new Error("synthetic outage"));
    const kept = await service({ range: outage }).resolveSchoolLunch(storedRow, school, date);
    expect(kept?.menu[0]?.name).toBe("저장된 메뉴");
  });

  it("reports an outage with nothing stored as an error, not as no lunch", async () => {
    const outage = vi.fn().mockRejectedValue(new Error("synthetic outage"));
    await expect(
      service({ range: outage }).resolveSchoolLunch(undefined, school, date),
    ).rejects.toThrow("synthetic outage");
    await expect(
      service({ range: vi.fn().mockResolvedValue([]) }).resolveSchoolLunch(undefined, school, date),
    ).resolves.toBeNull();
  });
});
