import { calendarDayDifference } from "../common/date/kst-date.js";
import { InvalidScheduleCalendarRangeException } from "./schedules.errors.js";

export const MAX_SCHEDULE_CALENDAR_DAYS = 42;

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertScheduleCalendarRange(startDate: string, endDate: string): void {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    throw new InvalidScheduleCalendarRangeException();
  }
  const inclusiveDays = calendarDayDifference(startDate, endDate) + 1;
  if (inclusiveDays < 1 || inclusiveDays > MAX_SCHEDULE_CALENDAR_DAYS) {
    throw new InvalidScheduleCalendarRangeException();
  }
}
