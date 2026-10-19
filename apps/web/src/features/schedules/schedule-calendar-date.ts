export type ScheduleCalendarNavigationKey =
  "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "End" | "Home";

/**
 * 달력 한 칸이 무엇으로 읽혀야 하는가. 우선순위는 `holiday > sunday > saturday > weekday`다.
 * 공휴일이 토요일과 겹치면 공휴일이 이긴다 — 그날은 파란 토요일이 아니라 빨간 쉬는 날이다.
 */
export type ScheduleCalendarDayKind = "holiday" | "saturday" | "sunday" | "weekday";

export interface ScheduleCalendarGrid {
  dates: string[];
  endDate: string;
  startDate: string;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/u;

const MONTH_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  weekday: "long",
  year: "numeric",
});

function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function parseDate(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (match === null) throw new Error(`Invalid calendar date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = utcDate(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date;
}

function parseMonth(value: string): Date {
  const match = MONTH_PATTERN.exec(value);
  if (match === null) throw new Error(`Invalid calendar month: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = utcDate(year, month - 1, 1);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) {
    throw new Error(`Invalid calendar month: ${value}`);
  }
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addScheduleCalendarDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

export function calendarGridForMonth(month: string): ScheduleCalendarGrid {
  const firstDay = parseMonth(month);
  const startDate = new Date(firstDay);
  startDate.setUTCDate(firstDay.getUTCDate() - firstDay.getUTCDay());
  const dates = Array.from({ length: 42 }, (_unused, index) => {
    const date = new Date(startDate);
    date.setUTCDate(startDate.getUTCDate() + index);
    return isoDate(date);
  });
  return {
    dates,
    endDate: dates[dates.length - 1]!,
    startDate: dates[0]!,
  };
}

export function formatScheduleCalendarDate(value: string): string {
  return DATE_FORMATTER.format(parseDate(value));
}

export function formatScheduleCalendarMonth(value: string): string {
  return MONTH_FORMATTER.format(parseMonth(value));
}

export function scheduleCalendarDayKind(value: string, holiday: boolean): ScheduleCalendarDayKind {
  if (holiday) return "holiday";
  const weekday = parseDate(value).getUTCDay();
  if (weekday === 0) return "sunday";
  if (weekday === 6) return "saturday";
  return "weekday";
}

export function monthForScheduleCalendarDate(value: string): string {
  parseDate(value);
  return value.slice(0, 7);
}

export function moveScheduleCalendarDate(
  value: string,
  key: ScheduleCalendarNavigationKey,
): string {
  const weekday = parseDate(value).getUTCDay();
  const offset: Record<ScheduleCalendarNavigationKey, number> = {
    ArrowDown: 7,
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -7,
    End: 6 - weekday,
    Home: -weekday,
  };
  return addScheduleCalendarDays(value, offset[key]);
}

export function shiftScheduleCalendarMonth(value: string, months: number): string {
  const date = parseMonth(value);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 7);
}
