import { describe, expect, it } from "vitest";

import {
  calendarGridForMonth,
  formatScheduleCalendarDate,
  moveScheduleCalendarDate,
  shiftScheduleCalendarMonth,
} from "./schedule-calendar-date";

describe("schedule calendar date helpers", () => {
  it("builds an exact six-week leap-year grid across month boundaries", () => {
    const grid = calendarGridForMonth("2028-02");
    expect(grid.startDate).toBe("2028-01-30");
    expect(grid.endDate).toBe("2028-03-11");
    expect(grid.dates).toHaveLength(42);
    expect(grid.dates).toContain("2028-02-29");
  });

  it("moves by calendar arrows and row boundaries without local timezone drift", () => {
    expect(moveScheduleCalendarDate("2028-02-15", "ArrowRight")).toBe("2028-02-16");
    expect(moveScheduleCalendarDate("2028-02-15", "ArrowDown")).toBe("2028-02-22");
    expect(moveScheduleCalendarDate("2028-02-15", "ArrowUp")).toBe("2028-02-08");
    expect(moveScheduleCalendarDate("2028-02-15", "Home")).toBe("2028-02-13");
    expect(moveScheduleCalendarDate("2028-02-15", "End")).toBe("2028-02-19");
    expect(moveScheduleCalendarDate("2028-03-01", "ArrowLeft")).toBe("2028-02-29");
  });

  it("formats Korean accessible labels and shifts years", () => {
    expect(formatScheduleCalendarDate("2028-02-29")).toContain("2028년 2월 29일");
    expect(shiftScheduleCalendarMonth("2028-01", -1)).toBe("2027-12");
    expect(shiftScheduleCalendarMonth("2028-12", 1)).toBe("2029-01");
  });
});
