import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";

export type ScheduleScope = "past" | "upcoming" | "today" | "this_week";
export type ScheduleType = "assignment" | "exam" | "other" | "performance";

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

export interface ScheduleListResponse {
  date_range?: { start_date: string; end_date: string };
  items: ScheduleItem[];
  next_cursor: string | null;
  server_today: string;
}

export interface ScheduleCalendarHoliday {
  date: string;
  name: string;
}

export interface ScheduleCalendarResponse {
  end_date: string;
  /** 요청 범위의 법정공휴일. 공급 계약이 채워지지 않은 해는 빈 배열이다. */
  holidays: ScheduleCalendarHoliday[];
  items: ScheduleCalendarItem[];
  oldest_visible_date: string;
  server_today: string;
  start_date: string;
}

export interface ScheduleWriteRequest {
  description: string | null;
  due_date: string;
  schedule_type: ScheduleType;
  subject: string | null;
  title: string;
}

export interface ScheduleEntityResponse {
  etag: string;
  item: ScheduleItem;
}

export interface ScheduleLinks {
  notices: { id: string; is_important: boolean; title: string }[];
  supplies: { category: string; id: string; needed_on: string; title: string }[];
}

function queryPath(path: string, values: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) search.set(key, value);
  }
  return `${path}?${search.toString()}`;
}

function strongEtag(response: Response, item: ScheduleItem): string {
  return entityEtag(item.row_version, response.headers.get("ETag"));
}

async function parseScheduleEntity(response: Response): Promise<ScheduleEntityResponse> {
  const item = await parseResponse<ScheduleItem>(response);
  return { etag: strongEtag(response, item), item };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function listSchedules(
  scope: ScheduleScope,
  cursor?: string,
  scheduleType?: ScheduleType,
  search?: string,
): Promise<ScheduleListResponse> {
  const response = await apiFetch(
    queryPath("/api/v1/schedules", { scope, cursor, schedule_type: scheduleType, q: search }),
    {
      credentials: "include",
    },
  );
  return parseResponse<ScheduleListResponse>(response);
}

export async function listScheduleCalendar(
  startDate: string,
  endDate: string,
): Promise<ScheduleCalendarResponse> {
  const response = await apiFetch(
    queryPath("/api/v1/schedules/calendar", {
      end_date: endDate,
      start_date: startDate,
    }),
    { credentials: "include" },
  );
  return parseResponse<ScheduleCalendarResponse>(response);
}

export async function getSchedule(scheduleId: string): Promise<ScheduleEntityResponse> {
  const response = await apiFetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, {
    credentials: "include",
  });
  return parseScheduleEntity(response);
}

export async function createSchedule(
  request: ScheduleWriteRequest,
  idempotencyKey: string,
): Promise<ScheduleEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/schedules", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseScheduleEntity,
  );
}

export async function updateSchedule(
  scheduleId: string,
  request: ScheduleWriteRequest,
  etag: string,
): Promise<ScheduleEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseScheduleEntity,
  );
}

/** 학생에게는 서버가 자기에게 공개된 공지·준비물만 돌려준다. */
export async function getScheduleLinks(scheduleId: string): Promise<ScheduleLinks> {
  const response = await apiFetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}/links`, {
    credentials: "include",
  });
  return parseResponse<ScheduleLinks>(response);
}

/** 연결 전체를 교체한다. 같은 요청을 반복해도 결과가 같아 재시도해도 안전하다. */
export async function replaceScheduleLinks(
  scheduleId: string,
  noticeIds: string[],
  supplyIds: string[],
): Promise<ScheduleLinks> {
  const body = JSON.stringify({ notice_ids: noticeIds, supply_ids: supplyIds });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}/links`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body,
      }),
    parseResponse<ScheduleLinks>,
  );
}

export async function deleteSchedule(
  scheduleId: string,
  reason: string | null,
  etag: string,
): Promise<void> {
  const body = JSON.stringify({ reason });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseEmptyResponse,
  );
}
