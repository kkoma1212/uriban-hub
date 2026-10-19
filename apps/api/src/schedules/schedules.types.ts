export type ScheduleType = "assignment" | "exam" | "other" | "performance";
export type ScheduleListScope = "past" | "upcoming" | "today" | "this_week";

export interface ScheduleDateRange {
  start_date: string;
  end_date: string;
}

export interface ScheduleItem {
  d_day_label: string | null;
  days_until: number;
  description: string | null;
  due_date: string;
  id: string;
  row_version: string;
  schedule_type: ScheduleType;
  subject: string | null;
  title: string;
}

export interface ClassScheduleCalendarItem extends ScheduleItem {
  source: "class";
}

export interface SchoolScheduleCalendarItem {
  d_day_label: string | null;
  days_until: number;
  description: string | null;
  due_date: string;
  id: string;
  school_day_type: string;
  source: "school";
  source_loaded_on: string;
  target_grades: number[];
  title: string;
}

export type ScheduleCalendarItem = ClassScheduleCalendarItem | SchoolScheduleCalendarItem;

export interface ListSchedulesResult {
  date_range?: ScheduleDateRange;
  items: ScheduleItem[];
  next_cursor: string | null;
  server_today: string;
}

export interface ScheduleCalendarHoliday {
  date: string;
  name: string;
}

export interface ScheduleCalendarResult {
  end_date: string;
  holidays: ScheduleCalendarHoliday[];
  items: ScheduleCalendarItem[];
  oldest_visible_date: string;
  server_today: string;
  start_date: string;
}

export interface ListSchedulesQuery {
  actorUserId: string;
  cursor?: string;
  scheduleType?: ScheduleType;
  search?: string;
  scope: ScheduleListScope;
}

export interface GetScheduleCalendarQuery {
  actorUserId: string;
  endDate: string;
  startDate: string;
}

export interface GetScheduleQuery {
  actorUserId: string;
  scheduleId: string;
}

export interface CreateScheduleCommand {
  actorUserId: string;
  description: string | null;
  dueDate: string;
  idempotencyKey: string | string[] | undefined;
  requestId: string;
  scheduleType: ScheduleType;
  subject: string | null;
  title: string;
}

export interface UpdateScheduleCommand {
  actorUserId: string;
  description: string | null | undefined;
  dueDate: string | undefined;
  ifMatch: string | string[] | undefined;
  requestId: string;
  scheduleId: string;
  scheduleType: ScheduleType | undefined;
  subject: string | null | undefined;
  title: string | undefined;
}

export interface DeleteScheduleCommand {
  actorUserId: string;
  ifMatch: string | string[] | undefined;
  reason: string | null;
  requestId: string;
  scheduleId: string;
}

export interface ScheduleLinkedNotice {
  id: string;
  is_important: boolean;
  title: string;
}

export interface ScheduleLinkedSupply {
  category: string;
  id: string;
  needed_on: string;
  title: string;
}

/** 학생에게는 자기에게 공개된 항목만 담긴다(공지·준비물 대상·게시·조회 기간 규칙과 같음). */
export interface ScheduleLinksResult {
  notices: ScheduleLinkedNotice[];
  supplies: ScheduleLinkedSupply[];
}

export interface GetScheduleLinksQuery {
  actorUserId: string;
  scheduleId: string;
}

export interface UpdateScheduleLinksCommand {
  actorUserId: string;
  noticeIds: string[];
  requestId: string;
  scheduleId: string;
  supplyIds: string[];
}
