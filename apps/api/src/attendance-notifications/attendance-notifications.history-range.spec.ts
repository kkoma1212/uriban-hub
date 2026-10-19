import { describe, expect, it } from "vitest";

import { InvalidAttendanceHistoryRangeException } from "./attendance-notifications.history-errors.js";
import {
  assertAttendanceHistoryRange,
  MAX_ATTENDANCE_HISTORY_DAYS,
} from "./attendance-notifications.history-range.js";

describe("assertAttendanceHistoryRange", () => {
  it("accepts a 366-day inclusive range ending today", () => {
    expect(() =>
      assertAttendanceHistoryRange("2025-08-01", "2026-07-31", "2026-07-31"),
    ).not.toThrow();
    expect(MAX_ATTENDANCE_HISTORY_DAYS).toBe(366);
  });

  it.each([
    ["2026-02-30", "2026-07-31", "2026-07-31"],
    ["2026-07-31", "2026-07-30", "2026-07-31"],
    ["2025-07-30", "2026-07-31", "2026-07-31"],
    ["2026-07-01", "2026-08-01", "2026-07-31"],
  ])("rejects an invalid range from %s to %s", (from, to, serverToday) => {
    expect(() => assertAttendanceHistoryRange(from, to, serverToday)).toThrow(
      InvalidAttendanceHistoryRangeException,
    );
  });
});
