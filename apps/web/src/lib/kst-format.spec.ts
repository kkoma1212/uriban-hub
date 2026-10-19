import { describe, expect, it } from "vitest";

import {
  formatKstCalendarDate,
  formatKstCurrentMonth,
  formatKstDateTime,
  formatKstDateTimeOrNull,
  formatKstDateTimeWithShortWeekday,
  formatKstDateTimeWithWeekday,
  formatKstDateTimeWithYear,
  formatKstDateTimeWithYearAndShortWeekday,
  formatKstTimeOfDay,
} from "./kst-format";

const TIMESTAMP = "2026-07-25T14:05:00+09:00";

describe("kst format", () => {
  // 이 문자열들은 화면에 승인되어 노출 중인 형식이다. 형식을 바꾸는 결정은
  // 이 spec을 함께 바꾸는 명시적 변경이어야 한다.
  it("keeps every approved on-screen format exactly", () => {
    expect(formatKstCalendarDate("2026-07-25")).toBe("7월 25일 토요일");
    expect(formatKstDateTime(TIMESTAMP)).toBe("7월 25일 오후 2:05");
    expect(formatKstDateTimeOrNull(TIMESTAMP)).toBe("7월 25일 오후 2:05");
    expect(formatKstDateTimeWithWeekday(TIMESTAMP)).toBe("7월 25일 토요일 오후 2:05");
    expect(formatKstDateTimeWithShortWeekday(TIMESTAMP)).toBe("7월 25일 (토) 오후 2:05");
    expect(formatKstDateTimeWithYearAndShortWeekday(TIMESTAMP)).toBe(
      "2026년 7월 25일 토 오후 2:05",
    );
    expect(formatKstDateTimeWithYear(TIMESTAMP)).toBe("2026년 7월 25일 오후 2:05");
    expect(formatKstTimeOfDay(TIMESTAMP)).toBe("오후 2:05");
    expect(formatKstCurrentMonth(new Date(TIMESTAMP))).toBe("7월");
  });

  it("renders KST regardless of the viewer timezone input", () => {
    // 같은 순간을 UTC로 표기해도 화면은 KST 기준이어야 한다.
    expect(formatKstDateTime("2026-07-25T05:05:00.000Z")).toBe("7월 25일 오후 2:05");
    expect(formatKstTimeOfDay("2026-07-24T15:30:00.000Z")).toBe("오전 12:30");
  });

  it("falls back safely on invalid or null input", () => {
    expect(formatKstCalendarDate("2026-7-25")).toBe("2026-7-25");
    expect(formatKstCalendarDate("not-a-date")).toBe("not-a-date");
    expect(formatKstDateTime("broken")).toBe("broken");
    expect(formatKstDateTimeOrNull("broken")).toBeNull();
    expect(formatKstDateTimeWithWeekday("broken")).toBe("broken");
    expect(formatKstDateTimeWithShortWeekday("broken")).toBe("broken");
    expect(formatKstDateTimeWithYearAndShortWeekday("broken")).toBe("broken");
    expect(formatKstDateTimeWithYear("broken")).toBe("broken");
    expect(formatKstTimeOfDay(null)).toBeNull();
    expect(formatKstTimeOfDay("broken")).toBe("broken");
  });
});
