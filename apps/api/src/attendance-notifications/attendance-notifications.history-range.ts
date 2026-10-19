import { calendarDayDifference } from "../common/date/kst-date.js";
import { InvalidAttendanceHistoryRangeException } from "./attendance-notifications.history-errors.js";

export const MAX_ATTENDANCE_HISTORY_DAYS = 366;

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertAttendanceHistoryRange(from: string, to: string, serverToday: string): void {
  if (!isCalendarDate(from) || !isCalendarDate(to) || !isCalendarDate(serverToday)) {
    throw new InvalidAttendanceHistoryRangeException();
  }

  const inclusiveDays = calendarDayDifference(from, to) + 1;
  if (
    inclusiveDays < 1 ||
    inclusiveDays > MAX_ATTENDANCE_HISTORY_DAYS ||
    calendarDayDifference(to, serverToday) < 0
  ) {
    throw new InvalidAttendanceHistoryRangeException();
  }
}
