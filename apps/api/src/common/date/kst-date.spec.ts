import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  calendarDayDifference,
  databaseDate,
  kstDate,
  startOfKstWeek,
} from "./kst-date.js";

describe("KST calendar helpers", () => {
  it("uses the KST calendar date across the UTC boundary", () => {
    expect(kstDate(new Date("2026-07-10T14:59:59.999Z"))).toBe("2026-07-10");
    expect(kstDate(new Date("2026-07-10T15:00:00.000Z"))).toBe("2026-07-11");
  });

  it("adds and compares calendar days without local-time drift", () => {
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(calendarDayDifference("2026-07-11", "2026-07-14")).toBe(3);
    expect(databaseDate("2026-07-11")).toBe("2026-07-11");
    expect(databaseDate(new Date(2026, 6, 11))).toBe("2026-07-11");
  });

  it("finds the Monday of the KST calendar week, including weekends", () => {
    expect(startOfKstWeek("2026-07-13")).toBe("2026-07-13");
    expect(startOfKstWeek("2026-07-18")).toBe("2026-07-13");
    expect(startOfKstWeek("2026-07-19")).toBe("2026-07-13");
    expect(startOfKstWeek("2026-01-01")).toBe("2025-12-29");
  });
});
