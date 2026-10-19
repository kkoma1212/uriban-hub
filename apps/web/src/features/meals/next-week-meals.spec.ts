import { afterEach, describe, expect, it, vi } from "vitest";
import { getMonthMeals, getWeekMeals } from "../../api/meals";
import { getNextWeekMeals } from "./next-week-meals";

vi.mock("../../api/meals", () => ({ getMonthMeals: vi.fn(), getWeekMeals: vi.fn() }));

describe("next week meals", () => {
  afterEach(() => vi.resetAllMocks());

  it.each([
    ["2026-09-27", ["2026-09", "2026-10"], "2026-09-28", "2026-10-02"],
    ["2026-12-27", ["2026-12", "2027-01"], "2026-12-28", "2027-01-01"],
    ["2026-09-06", ["2026-09"], "2026-09-07", "2026-09-11"],
  ])(
    "uses server date %s and merges each required month once",
    async (today, months, first, last) => {
      vi.mocked(getWeekMeals).mockResolvedValue({ server_today: today, items: [] });
      vi.mocked(getMonthMeals).mockImplementation(async (month) => ({
        server_today: today,
        month,
        items: [
          {
            date: month === last.slice(0, 7) ? last : first,
            status: "ok",
            data: {
              id: month,
              meal_date: month === last.slice(0, 7) ? last : first,
              menu: [{ name: month + " 급식", allergens: [] }],
              calorie_kcal: null,
              source: "neis",
              source_loaded_on: today,
              source_updated_at: today + "T00:00:00Z",
            },
          },
        ],
      }));
      const result = await getNextWeekMeals();
      expect(vi.mocked(getMonthMeals).mock.calls.map(([month]) => month)).toEqual(months);
      expect(result.server_today).toBe(today);
      expect(result.items).toHaveLength(5);
      expect(result.items[0]?.date).toBe(first);
      expect(result.items[4]).toMatchObject({
        date: last,
        status: "ok",
        data: { id: last.slice(0, 7) },
      });
      expect(result.items[2]?.status).toBe("empty");
    },
  );

  it("does not disguise a failed month lookup as an empty menu", async () => {
    vi.mocked(getWeekMeals).mockResolvedValue({ server_today: "2026-09-27", items: [] });
    vi.mocked(getMonthMeals).mockRejectedValue(new Error("temporary failure"));
    await expect(getNextWeekMeals()).rejects.toThrow("temporary failure");
  });
});
