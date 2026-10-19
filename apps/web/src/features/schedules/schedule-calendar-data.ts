import type { AttendanceHistoryItem } from "../../api/attendance-notifications";
import type { ScheduleCalendarItem, ScheduleCalendarResponse } from "../../api/schedules";
import { addScheduleCalendarDays } from "./schedule-calendar-date";

/** 선택한 날짜가 들어 있는 월요일~일요일 7일. 호스트 timezone에 기대지 않는다. */
export function weekDatesFor(date: string): string[] {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return [date];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const monday = addScheduleCalendarDays(date, -((weekday + 6) % 7));
  return Array.from({ length: 7 }, (_unused, index) => addScheduleCalendarDays(monday, index));
}

/** 서버 응답의 날짜(`YYYY-MM-DD`) → 법정공휴일 이름. */
export function holidayNamesByDate(
  holidays: ScheduleCalendarResponse["holidays"] | undefined,
): ReadonlyMap<string, string> {
  return new Map((holidays ?? []).map((holiday) => [holiday.date, holiday.name]));
}

export function itemsByDate(items: ScheduleCalendarItem[]): Map<string, ScheduleCalendarItem[]> {
  const result = new Map<string, ScheduleCalendarItem[]>();
  for (const item of items) {
    const current = result.get(item.due_date);
    if (current === undefined) result.set(item.due_date, [item]);
    else current.push(item);
  }
  return result;
}

interface ScheduleCalendarRange {
  endDate: string;
  startDate: string;
}

export function supplementalWeekRange(
  gridStartDate: string,
  gridEndDate: string,
  weekStartDate: string,
  weekEndDate: string,
): ScheduleCalendarRange | undefined {
  if (weekStartDate < gridStartDate) {
    return {
      endDate: addScheduleCalendarDays(gridStartDate, -1),
      startDate: weekStartDate,
    };
  }
  if (weekEndDate > gridEndDate) {
    return {
      endDate: weekEndDate,
      startDate: addScheduleCalendarDays(gridEndDate, 1),
    };
  }
  return undefined;
}

export function mergeScheduleCalendarResponses(
  primary: ScheduleCalendarResponse,
  supplemental: ScheduleCalendarResponse,
): ScheduleCalendarResponse {
  const holidays = new Map(
    [...(primary.holidays ?? []), ...(supplemental.holidays ?? [])].map((holiday) => [
      holiday.date,
      holiday,
    ]),
  );
  return {
    ...primary,
    end_date: primary.end_date > supplemental.end_date ? primary.end_date : supplemental.end_date,
    holidays: [...holidays.values()].sort((left, right) => left.date.localeCompare(right.date)),
    items: [...primary.items, ...supplemental.items].sort(
      (left, right) =>
        left.due_date.localeCompare(right.due_date) ||
        left.id.localeCompare(right.id, undefined, { numeric: true }),
    ),
    start_date:
      primary.start_date < supplemental.start_date ? primary.start_date : supplemental.start_date,
  };
}

export function eventCountLabel(count: number): string {
  return count === 0 ? "일정 없음" : `일정 ${count}개`;
}

export function dateStatusLabel(count: number, busy: boolean, failed: boolean): string {
  if (busy) return "일정 확인 중";
  if (failed) return "일정 확인 불가";
  return eventCountLabel(count);
}

export function historyByDate(items: AttendanceHistoryItem[]): Map<string, AttendanceHistoryItem> {
  return new Map(items.map((item) => [item.notification_date, item]));
}
