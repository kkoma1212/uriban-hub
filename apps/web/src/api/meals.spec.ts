import { afterEach, describe, expect, it, vi } from "vitest";

import { getMonthMeals, getTodayMeal, getWeekMeals } from "./meals";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("meals API client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the three read-only current-class meal endpoints", async () => {
    const today = { data: null, server_today: "2026-07-14", status: "empty" as const };
    const week = { items: [], server_today: "2026-07-14" };
    const month = { items: [], month: "2026-07", server_today: "2026-07-14" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(today))
      .mockResolvedValueOnce(jsonResponse(week))
      .mockResolvedValueOnce(jsonResponse(month));

    await expect(getTodayMeal()).resolves.toEqual(today);
    await expect(getWeekMeals()).resolves.toEqual(week);
    await expect(getMonthMeals("2026-07")).resolves.toEqual(month);
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
      "/api/v1/meals/today",
      "/api/v1/meals/week",
      "/api/v1/meals/month?month=2026-07",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual({
        credentials: "include",
        signal: expect.any(AbortSignal),
      });
    }
  });
});
