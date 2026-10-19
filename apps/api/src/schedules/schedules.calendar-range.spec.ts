import { describe, expect, it } from "vitest";

import {
  assertScheduleCalendarRange,
  MAX_SCHEDULE_CALENDAR_DAYS,
} from "./schedules.calendar-range.js";
import { InvalidScheduleCalendarRangeException } from "./schedules.errors.js";

describe("schedule calendar range", () => {
  it("accepts an inclusive 42-day range across a leap-day month boundary", () => {
    expect(MAX_SCHEDULE_CALENDAR_DAYS).toBe(42);
    expect(() => assertScheduleCalendarRange("2028-01-30", "2028-03-11")).not.toThrow();
  });

  it.each([
    ["2028-02-30", "2028-03-01"],
    ["2028-03-02", "2028-03-01"],
    ["2028-01-30", "2028-03-12"],
  ])("rejects malformed, reversed, and over-limit ranges (%s to %s)", (startDate, endDate) => {
    expect(() => assertScheduleCalendarRange(startDate, endDate)).toThrow(
      InvalidScheduleCalendarRangeException,
    );
  });
});
