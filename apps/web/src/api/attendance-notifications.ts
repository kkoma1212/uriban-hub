import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";

const changeListeners = new Set<() => void>();

export function subscribeAttendanceChanges(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export type AttendanceNotificationType = "absent" | "early" | "late";
export type AttendanceNotificationStatus = "acknowledged" | "pending";
export type AttendanceTypeFilter = "all" | AttendanceNotificationType;
export type AttendanceStatusFilter = "all" | AttendanceNotificationStatus;

export interface AttendanceNotificationItem {
  acknowledged_at: string | null;
  expected_time: string | null;
  id: string;
  notification_type: AttendanceNotificationType;
  row_version: string;
  status: AttendanceNotificationStatus;
  submitted_at: string;
  updated_at: string;
}

export interface AttendanceMutationItem extends Omit<AttendanceNotificationItem, "status"> {
  status: AttendanceNotificationStatus | "canceled";
}

export interface AttendanceCounts {
  absent: number;
  acknowledged: number;
  early: number;
  late: number;
  pending: number;
  total: number;
}

export interface AttendanceHistoryCounts {
  absent: number;
  early: number;
  late: number;
  total: number;
}

export interface AttendanceHistoryItem {
  expected_time: string | null;
  notification_date: string;
  notification_type: AttendanceNotificationType;
  status: AttendanceNotificationStatus;
}

export interface AttendanceStudentHistory {
  counts: AttendanceHistoryCounts;
  items: AttendanceHistoryItem[];
  range: {
    from: string;
    to: string;
  };
  role: "student";
  server_today: string;
}

export interface AttendanceTeacherItem extends AttendanceNotificationItem {
  account_state: "active" | "deleted" | "inactive";
  display_name: string;
  member_id: string;
  membership_state: "account_deleted" | "approved" | "left" | "removed";
  student_number: number | null;
}

export interface AttendanceStudentToday {
  notification: AttendanceNotificationItem | null;
  role: "student";
  server_today: string;
}

export interface AttendanceTeacherToday {
  counts: AttendanceCounts;
  items: AttendanceTeacherItem[];
  next_cursor: string | null;
  role: "teacher";
  server_today: string;
}

export type AttendanceToday = AttendanceStudentToday | AttendanceTeacherToday;

export interface AttendanceWriteRequest {
  expected_time: string | null;
  notification_type: AttendanceNotificationType;
}

export interface AttendanceTodayResponse {
  data: AttendanceToday;
  etag: string | null;
}

export interface AttendanceMutationResponse {
  etag: string;
  item: AttendanceMutationItem;
}

function requestPath(
  type: AttendanceTypeFilter,
  status: AttendanceStatusFilter,
  cursor?: string,
): string {
  const search = new URLSearchParams({ status, type });
  if (cursor !== undefined) search.set("cursor", cursor);
  return `/api/v1/attendance-notifications/today?${search.toString()}`;
}

function strongEtag(response: Response, rowVersion: string): string {
  return entityEtag(rowVersion, response.headers.get("ETag"));
}

async function parseMutation(response: Response): Promise<AttendanceMutationResponse> {
  const item = await parseResponse<AttendanceMutationItem>(response);
  for (const listener of changeListeners) listener();
  return { etag: strongEtag(response, item.row_version), item };
}

export async function getTodayAttendance(
  type: AttendanceTypeFilter = "all",
  status: AttendanceStatusFilter = "all",
  cursor?: string,
): Promise<AttendanceTodayResponse> {
  const response = await apiFetch(requestPath(type, status, cursor), { credentials: "include" });
  const data = await parseResponse<AttendanceToday>(response);
  return {
    data,
    etag:
      data.role === "student" && data.notification !== null
        ? strongEtag(response, data.notification.row_version)
        : null,
  };
}

export async function getAttendanceHistory(
  from: string,
  to: string,
): Promise<AttendanceStudentHistory> {
  const search = new URLSearchParams({ from, to });
  const response = await apiFetch(`/api/v1/attendance-notifications/history?${search.toString()}`, {
    credentials: "include",
  });
  return parseResponse<AttendanceStudentHistory>(response);
}

export async function createAttendanceNotification(
  request: AttendanceWriteRequest,
  serverToday: string,
  idempotencyKey: string,
): Promise<AttendanceMutationResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/attendance-notifications", {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
          "X-Server-Today": serverToday,
        },
        method: "POST",
      }),
    parseMutation,
  );
}

export async function updateAttendanceNotification(
  id: string,
  request: AttendanceWriteRequest,
  serverToday: string,
  etag: string,
): Promise<AttendanceMutationResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/attendance-notifications/${encodeURIComponent(id)}`, {
        body,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
          "X-Server-Today": serverToday,
        },
        method: "PATCH",
      }),
    parseMutation,
  );
}

async function attendanceAction(
  id: string,
  action: "acknowledge" | "cancel",
  serverToday: string,
  etag: string,
): Promise<AttendanceMutationResponse> {
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/attendance-notifications/${encodeURIComponent(id)}/${action}`, {
        credentials: "include",
        headers: {
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
          "X-Server-Today": serverToday,
        },
        method: "POST",
      }),
    parseMutation,
  );
}

export function cancelAttendanceNotification(
  id: string,
  serverToday: string,
  etag: string,
): Promise<AttendanceMutationResponse> {
  return attendanceAction(id, "cancel", serverToday, etag);
}

export function acknowledgeAttendanceNotification(
  id: string,
  serverToday: string,
  etag: string,
): Promise<AttendanceMutationResponse> {
  return attendanceAction(id, "acknowledge", serverToday, etag);
}
