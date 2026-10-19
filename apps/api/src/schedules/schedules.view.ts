import { calendarDayDifference, databaseDate } from "../common/date/kst-date.js";
import type {
  ClassScheduleCalendarItem,
  ScheduleItem,
  ScheduleType,
  SchoolScheduleCalendarItem,
} from "./schedules.types.js";

export interface ScheduleViewRow {
  description: string | null;
  due_date: Date | string;
  id: string;
  row_version: string;
  schedule_type: string;
  subject: string | null;
  title: string;
}

export function scheduleItemView(row: ScheduleViewRow, serverToday: string): ScheduleItem {
  const dueDate = databaseDate(row.due_date);
  const daysUntil = calendarDayDifference(serverToday, dueDate);
  return {
    d_day_label: daysUntil < 0 ? null : daysUntil === 0 ? "D-Day" : `D-${daysUntil}`,
    days_until: daysUntil,
    description: row.description,
    due_date: dueDate,
    id: row.id,
    row_version: row.row_version,
    schedule_type: row.schedule_type as ScheduleType,
    subject: row.subject,
    title: row.title,
  };
}

export function classScheduleCalendarItemView(
  row: ScheduleViewRow,
  serverToday: string,
): ClassScheduleCalendarItem {
  return { ...scheduleItemView(row, serverToday), source: "class" };
}

export interface SchoolScheduleViewRow {
  event_content: string | null;
  event_date: Date | string;
  event_name: string;
  grade_mask: number;
  id: string;
  school_day_type: string;
  source_loaded_on: Date | string;
}

/**
 * 달력에 보일 학사일정. 나이스에서 바로 받은 것이 있으면 그것이 최신이다(학교가 지운 행사도 사라진다).
 * 키가 없거나 나이스가 응답하지 않으면(live 없음) 운영자 명령으로 저장해 둔 일정(이미 학년·기간으로 거름)을
 * 쓴다. 토요일은 원래 학교에 가지 않으므로 '토요휴업일'은 적지 않는다(2026-09-30 사용자 결정).
 */
export function selectSchoolCalendarRows<Row extends SchoolScheduleViewRow>(input: {
  stored: Row[];
  live: SchoolScheduleViewRow[] | undefined;
  grade: number;
  from: string;
  to: string;
}): SchoolScheduleViewRow[] {
  const gradeBit = 1 << (input.grade - 1);
  const rows =
    input.live === undefined
      ? input.stored
      : input.live.filter(
          (row) =>
            (row.grade_mask & gradeBit) !== 0 &&
            String(row.event_date) >= input.from &&
            String(row.event_date) <= input.to,
        );
  return rows.filter((row) => row.event_name.trim() !== "토요휴업일");
}

export function schoolScheduleCalendarItemView(
  row: SchoolScheduleViewRow,
  serverToday: string,
): SchoolScheduleCalendarItem {
  const dueDate = databaseDate(row.event_date);
  const daysUntil = calendarDayDifference(serverToday, dueDate);
  const targetGrades: number[] = [];
  for (let grade = 1; grade <= 6; grade += 1) {
    if ((row.grade_mask & (1 << (grade - 1))) !== 0) targetGrades.push(grade);
  }
  return {
    d_day_label: daysUntil < 0 ? null : daysUntil === 0 ? "D-Day" : `D-${daysUntil}`,
    days_until: daysUntil,
    description: row.event_content,
    due_date: dueDate,
    id: row.id,
    school_day_type: row.school_day_type,
    source: "school",
    source_loaded_on: databaseDate(row.source_loaded_on),
    target_grades: targetGrades,
    title: row.event_name,
  };
}
