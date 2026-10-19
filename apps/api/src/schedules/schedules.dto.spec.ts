import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  CreateScheduleDto,
  DeleteScheduleDto,
  ListSchedulesQueryDto,
  ScheduleCalendarQueryDto,
  UpdateScheduleDto,
  UpdateScheduleLinksDto,
} from "./schedules.dto.js";

function instanceAndErrors<T extends object>(
  type: new () => T,
  values: Record<string, unknown>,
): { errors: ReturnType<typeof validateSync>; instance: T } {
  const instance = plainToInstance(type, values);
  return { errors: validateSync(instance), instance };
}

const validCreate = {
  description: "교과서 3단원까지 준비해 주세요.",
  due_date: "2026-07-15",
  schedule_type: "exam",
  subject: "수학",
  title: "수학 단원평가",
};

describe("schedule DTO validation", () => {
  it("accepts the four documented list periods with lookup conditions", () => {
    for (const scope of ["upcoming", "today", "this_week", "past"]) {
      expect(
        instanceAndErrors(ListSchedulesQueryDto, { scope, schedule_type: "assignment", q: "수학" })
          .errors,
      ).toHaveLength(0);
    }
    for (const scope of ["week", "TODAY", null, ["today", "past"]]) {
      expect(instanceAndErrors(ListSchedulesQueryDto, { scope }).errors).not.toHaveLength(0);
    }
  });

  it("accepts optional type and Unicode search while rejecting ambiguous query values", () => {
    for (const schedule_type of ["assignment", "performance", "exam", "other"]) {
      expect(
        instanceAndErrors(ListSchedulesQueryDto, {
          scope: "past",
          schedule_type,
          q: "😀".repeat(50),
        }).errors,
      ).toHaveLength(0);
    }
    for (const schedule_type of ["all", "EXAM", "", null, ["exam", "other"]]) {
      expect(
        instanceAndErrors(ListSchedulesQueryDto, { scope: "past", schedule_type }).errors,
      ).not.toHaveLength(0);
    }
    for (const q of ["", "가".repeat(51), null, 1, ["수학", "영어"]]) {
      expect(
        instanceAndErrors(ListSchedulesQueryDto, { scope: "upcoming", q }).errors,
      ).not.toHaveLength(0);
    }
  });

  it("trims text and counts Unicode code points", () => {
    const valid = instanceAndErrors(CreateScheduleDto, {
      ...validCreate,
      description: "  일정 설명  ",
      subject: "  수학  ",
      title: `  ${"😀".repeat(100)}  `,
    });
    expect(valid.errors).toHaveLength(0);
    expect(valid.instance.title).toBe("😀".repeat(100));
    expect(valid.instance.subject).toBe("수학");
    expect(valid.instance.description).toBe("일정 설명");

    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, subject: "가".repeat(31) }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, title: "😀".repeat(101) }).errors,
    ).not.toHaveLength(0);
  });

  it("rejects HTML and control characters while allowing LF only in descriptions", () => {
    expect(instanceAndErrors(CreateScheduleDto, validCreate).errors).toHaveLength(0);
    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, title: "<b>시험</b>" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, subject: "수학\n심화" }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, description: "첫째 줄\n둘째 줄" })
        .errors,
    ).toHaveLength(0);
    expect(
      instanceAndErrors(CreateScheduleDto, { ...validCreate, description: "설명\t내용" }).errors,
    ).not.toHaveLength(0);
  });

  it("accepts only real dates and documented schedule types", () => {
    for (const dueDate of ["2026-02-30", "2026-7-15", "2026-07-15T00:00:00Z"]) {
      expect(
        instanceAndErrors(CreateScheduleDto, { ...validCreate, due_date: dueDate }).errors,
      ).not.toHaveLength(0);
    }
    for (const scheduleType of ["quiz", "EXAM", ""]) {
      expect(
        instanceAndErrors(CreateScheduleDto, {
          ...validCreate,
          schedule_type: scheduleType,
        }).errors,
      ).not.toHaveLength(0);
    }
  });

  it("normalizes optional values and accepts partial no-op updates", () => {
    const update = instanceAndErrors(UpdateScheduleDto, {
      description: "  ",
      subject: "  ",
    });
    expect(update.errors).toHaveLength(0);
    expect(update.instance.description).toBeNull();
    expect(update.instance.subject).toBeNull();
    expect(instanceAndErrors(UpdateScheduleDto, {}).errors).toHaveLength(0);
  });

  it("requires a nullable plain-text delete reason and valid list scope", () => {
    expect(instanceAndErrors(DeleteScheduleDto, {}).errors).not.toHaveLength(0);
    expect(instanceAndErrors(DeleteScheduleDto, { reason: null }).errors).toHaveLength(0);
    expect(instanceAndErrors(DeleteScheduleDto, { reason: "<b>삭제</b>" }).errors).not.toHaveLength(
      0,
    );
    expect(instanceAndErrors(ListSchedulesQueryDto, { scope: "upcoming" }).errors).toHaveLength(0);
    expect(instanceAndErrors(ListSchedulesQueryDto, { scope: "future" }).errors).not.toHaveLength(
      0,
    );
  });

  it("accepts only real calendar range dates", () => {
    expect(
      instanceAndErrors(ScheduleCalendarQueryDto, {
        end_date: "2028-03-11",
        start_date: "2028-01-30",
      }).errors,
    ).toHaveLength(0);
    expect(
      instanceAndErrors(ScheduleCalendarQueryDto, {
        end_date: "2028-03-11",
        start_date: "2028-02-30",
      }).errors,
    ).not.toHaveLength(0);
    expect(
      instanceAndErrors(ScheduleCalendarQueryDto, { start_date: "2028-01-30" }).errors,
    ).not.toHaveLength(0);
  });
});

describe("UpdateScheduleLinksDto", () => {
  const errors = (values: Record<string, unknown>) =>
    instanceAndErrors(UpdateScheduleLinksDto, values).errors.map((error) => error.property);

  it("accepts empty lists and up to ten unique positive ids each", () => {
    expect(errors({ notice_ids: [], supply_ids: [] })).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, index) => String(index + 1));
    expect(errors({ notice_ids: ten, supply_ids: ten })).toEqual([]);
  });

  it("rejects missing, oversized, duplicate or malformed id lists", () => {
    expect(errors({ supply_ids: [] })).toEqual(["notice_ids"]);
    const eleven = Array.from({ length: 11 }, (_, index) => String(index + 1));
    expect(errors({ notice_ids: eleven, supply_ids: [] })).toEqual(["notice_ids"]);
    expect(errors({ notice_ids: ["1", "1"], supply_ids: [] })).toEqual(["notice_ids"]);
    for (const bad of ["0", "-1", "1.5", "01", "12345678901234567890", 7])
      expect(errors({ notice_ids: [], supply_ids: [bad] })).toEqual(["supply_ids"]);
  });
});
