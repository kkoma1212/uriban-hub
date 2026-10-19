import { describe, expect, it } from "vitest";

import { scheduleItemView, selectSchoolCalendarRows } from "./schedules.view.js";

const row = {
  description: "3단원까지",
  id: "10",
  row_version: "2",
  schedule_type: "exam",
  subject: "수학",
  title: "수학 단원평가",
};

describe("schedule response views", () => {
  it("derives KST calendar D-day labels for today and future dates", () => {
    expect(scheduleItemView({ ...row, due_date: "2026-07-14" }, "2026-07-14")).toMatchObject({
      d_day_label: "D-Day",
      days_until: 0,
    });
    expect(scheduleItemView({ ...row, due_date: "2026-07-16" }, "2026-07-14")).toMatchObject({
      d_day_label: "D-2",
      days_until: 2,
    });
  });

  it("returns a negative day count and no D+ label for past dates", () => {
    expect(scheduleItemView({ ...row, due_date: "2026-07-13" }, "2026-07-14")).toEqual({
      ...row,
      d_day_label: null,
      days_until: -1,
      due_date: "2026-07-13",
      schedule_type: "exam",
    });
  });
});

describe("selectSchoolCalendarRows", () => {
  const event = (event_date: string, event_name: string, grade_mask: number, id: string) => ({
    event_content: null,
    event_date,
    event_name,
    grade_mask,
    id,
    school_day_type: "해당없음",
    source_loaded_on: "2026-07-30",
  });
  const stored = [event("2026-04-23", "저장된 시험", 0b111, "1")];

  it("prefers live NEIS rows for the class grade and range and drops Saturday closures", () => {
    const live = [
      event("2026-04-23", "1차 정기시험", 0b111, "11"),
      event("2026-04-25", "토요휴업일", 0b111, "12"),
      event("2026-06-04", "대수능 모의평가", 0b100, "13"),
      event("2026-06-05", "2학년 행사", 0b010, "14"),
      event("2026-09-01", "기간 밖", 0b111, "15"),
    ];
    const rows = selectSchoolCalendarRows({
      stored,
      live,
      grade: 2,
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(rows.map((row) => row.event_name)).toEqual(["1차 정기시험", "2학년 행사"]);
  });

  it("falls back to stored rows without NEIS and still drops Saturday closures", () => {
    const rows = selectSchoolCalendarRows({
      stored: [...stored, event("2026-04-25", " 토요휴업일 ", 0b111, "2")],
      live: undefined,
      grade: 1,
      from: "2026-04-01",
      to: "2026-04-30",
    });
    expect(rows.map((row) => row.id)).toEqual(["1"]);
  });
});
