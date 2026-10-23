import { adminFetch as apiFetch } from "./admin-request";
import { parseAdminResponse as parseResponse } from "./admin-auth";

interface DirectoryRequestContext {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export type AdminClassStatus = "active" | "suspended" | "archived";

/** 반 한 줄 — 반 정보·담임 이름·인원 수만 온다(학생 이름·메일·활동 내용 없음). */
export interface AdminClassRow {
  academic_year: number;
  created_at: string;
  grade: number;
  id: string;
  name: string;
  pending_members: number;
  region_name: string;
  school_name: string;
  status: string;
  students: number;
  teacher_name: string | null;
}

export interface AdminClassList {
  classes: AdminClassRow[];
  page: number;
  page_size: number;
  total: number;
}

export async function listAdminClasses(
  query: {
    page: number;
    search?: string | undefined;
    status?: AdminClassStatus | undefined;
  },
  context: DirectoryRequestContext = {},
): Promise<AdminClassList> {
  const params = new URLSearchParams({ page: String(query.page) });
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  const response = await apiFetch(`/api/v1/admin/classes?${params.toString()}`, {
    credentials: "include",
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return parseResponse(response, () => !context.signal?.aborted && (context.isCurrent?.() ?? true));
}

export type AdminActivityDays = 7 | 30;

/** 기간 안의 새 건수 — 글 내용·작성자는 오지 않는다. 반 대화가 꺼져 있으면 null. */
export interface AdminActivityCounts {
  active_students: number;
  attendance: number;
  class_chat_messages: number | null;
  help_requests: number;
  notices: number;
  polls: number;
  schedules: number;
  supplies: number;
}

export interface AdminClassActivityRow extends AdminActivityCounts {
  id: string;
  name: string;
  school_name: string;
  students: number;
}

export interface AdminClassActivityList {
  classes: AdminClassActivityRow[];
  days: AdminActivityDays;
  page: number;
  page_size: number;
  total: number;
  totals: AdminActivityCounts;
}

export async function listAdminClassActivity(query: {
  days: AdminActivityDays;
  page: number;
}): Promise<AdminClassActivityList> {
  const params = new URLSearchParams({ days: String(query.days), page: String(query.page) });
  const response = await apiFetch(`/api/v1/admin/class-activity?${params.toString()}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

/** 한국 날짜별 새 가입·새 활동 건수(모든 반 합계, 숫자만). */
export interface AdminActivityTrend {
  days: AdminActivityDays;
  from: string;
  series: Array<{ activity: number; date: string; signups: number }>;
  to: string;
}

export async function getAdminActivityTrend(days: AdminActivityDays): Promise<AdminActivityTrend> {
  const response = await apiFetch(`/api/v1/admin/activity-trend?days=${days}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

/** 시범 판정 지표: 고친 공지·준비물의 재확인 수(숫자만, 학생 이름·번호 없음). */
export interface AdminReconfirmCounts {
  earlier_revisions_excluded: number;
  eligible: number;
  reconfirmed_total: number;
  reconfirmed_within_window: number;
  revisions: number;
}

export interface AdminReconfirmReport {
  classes: Array<AdminReconfirmCounts & { id: string; name: string; school_name: string }>;
  events: Array<{
    class_id: string;
    eligible: number;
    item_id: string;
    kind: "notice" | "supply";
    reconfirmed_total: number;
    reconfirmed_within_window: number;
    revised_at: string;
    revision: string;
  }>;
  /** 한국 날짜 YYYY-MM-DD(처음·끝 포함) */
  from: string;
  to: string;
  totals: AdminReconfirmCounts;
  window_hours: number;
}

export async function getAdminReconfirmReport(period: {
  from?: string;
  to?: string;
}): Promise<AdminReconfirmReport> {
  const params = new URLSearchParams();
  if (period.from) params.set("from", period.from);
  if (period.to) params.set("to", period.to);
  const query = params.toString();
  const response = await apiFetch(
    `/api/v1/admin/reconfirm-report${query === "" ? "" : `?${query}`}`,
    { credentials: "include" },
  );
  return parseResponse(response);
}

export type AdminPersonRole = "teacher" | "student";
export type AdminPersonStatus = "active" | "pending" | "inactive";

/** 사람 한 줄 — 메일은 앞 두 글자만 보이게 가려서 온다. */
export interface AdminPersonRow {
  class_name: string | null;
  created_at: string;
  display_name: string;
  email_masked: string;
  id: string;
  last_login_at: string | null;
  role: AdminPersonRole;
  school_name: string | null;
  status: AdminPersonStatus;
}

export interface AdminPeopleList {
  page: number;
  page_size: number;
  people: AdminPersonRow[];
  total: number;
}

export async function listAdminPeople(
  query: {
    page: number;
    role?: AdminPersonRole | undefined;
    search?: string | undefined;
    status?: AdminPersonStatus | undefined;
  },
  context: DirectoryRequestContext = {},
): Promise<AdminPeopleList> {
  const params = new URLSearchParams({ page: String(query.page) });
  if (query.search) params.set("search", query.search);
  if (query.role) params.set("role", query.role);
  if (query.status) params.set("status", query.status);
  const response = await apiFetch(`/api/v1/admin/people?${params.toString()}`, {
    credentials: "include",
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return parseResponse(response, () => !context.signal?.aborted && (context.isCurrent?.() ?? true));
}
