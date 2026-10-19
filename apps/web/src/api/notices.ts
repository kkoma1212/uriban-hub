import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";
import type { ContentAudienceMode, ContentAudienceRequest } from "./content-audiences";
import { reminderContentRevision, type InAppReminderCreateResponse } from "./in-app-reminders";

export type NoticeImportance = "all" | "important" | "regular";
export type NoticeConfirmationState = "confirmed" | "modified_unconfirmed" | "unread";
export type NoticeConfirmationListState = NoticeConfirmationState;
export type NoticeCategory = "general" | "performance";

export interface NoticeItem {
  audience_mode: ContentAudienceMode;
  category: NoticeCategory;
  confirmation_state?: NoticeConfirmationState;
  content: string;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: string;
  row_version: string;
  title: string;
}

export interface NoticeListResponse {
  items: NoticeItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export interface NoticeWriteRequest {
  audience?: ContentAudienceRequest;
  category?: NoticeCategory;
  content: string;
  is_important: boolean;
  title: string;
}

export interface NoticeEntityResponse {
  etag: string;
  item: NoticeItem;
}

export interface NoticeConfirmationResponse {
  confirmation_state: "confirmed";
  content_revision: string;
  notice_id: string;
}

export interface NoticeConfirmationMember {
  confirmation_state: NoticeConfirmationState;
  display_name: string;
  member_id: string;
  student_number: number | null;
}

export interface NoticeConfirmationCounts {
  confirmed: number;
  /** 게시 이후 승인돼 이 공지의 대상이 아닌 학생 수. 위 세 집계에는 포함되지 않는다. */
  excluded_member_count: number;
  modified_unconfirmed: number;
  /** 수정 뒤 새 내용을 다시 확인한 학생 수(확인 현황 응답에만 있음). */
  reconfirmed?: number;
  unread: number;
}

export interface NoticeConfirmationsResponse {
  content_revision: string;
  counts: NoticeConfirmationCounts;
  items: NoticeConfirmationMember[];
  last_reminder_requested_at: string | null;
  next_cursor: string | null;
  server_today: string;
}

function queryPath(path: string, values: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) search.set(key, value);
  }
  return `${path}?${search.toString()}`;
}

function strongEtag(response: Response, item: NoticeItem): string {
  return entityEtag(item.row_version, response.headers.get("ETag"));
}

async function parseNoticeEntity(response: Response): Promise<NoticeEntityResponse> {
  const item = await parseResponse<NoticeItem>(response);
  return { etag: strongEtag(response, item), item };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function listNotices(
  importance: NoticeImportance,
  cursor?: string,
  search?: string,
): Promise<NoticeListResponse> {
  /* 검색어는 커서에 묶여 있다 — 다음 쪽을 부를 때도 같은 값을 보내야 한다. */
  const response = await apiFetch(queryPath("/api/v1/notices", { importance, cursor, q: search }), {
    credentials: "include",
  });
  return parseResponse<NoticeListResponse>(response);
}

export async function getNotice(noticeId: string): Promise<NoticeEntityResponse> {
  const response = await apiFetch(`/api/v1/notices/${encodeURIComponent(noticeId)}`, {
    credentials: "include",
  });
  return parseNoticeEntity(response);
}

export async function createNotice(
  request: NoticeWriteRequest,
  idempotencyKey: string,
): Promise<NoticeEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/notices", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseNoticeEntity,
  );
}

export async function updateNotice(
  noticeId: string,
  request: NoticeWriteRequest,
  etag: string,
): Promise<NoticeEntityResponse> {
  const { audience: _immutableAudience, ...mutableRequest } = request;
  const body = JSON.stringify(mutableRequest);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/notices/${encodeURIComponent(noticeId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseNoticeEntity,
  );
}

export async function deleteNotice(
  noticeId: string,
  reason: string | null,
  etag: string,
): Promise<void> {
  const body = JSON.stringify({ reason });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/notices/${encodeURIComponent(noticeId)}`, {
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

export async function confirmNotice(
  noticeId: string,
  contentRevision: string,
): Promise<NoticeConfirmationResponse> {
  const numericRevision = Number(contentRevision);
  if (!Number.isSafeInteger(numericRevision) || numericRevision < 1) {
    throw new Error("공지 내용이 방금 바뀌었을 수 있어요. 화면을 새로고침해 주세요.");
  }
  const body = JSON.stringify({ content_revision: numericRevision });
  return withCsrfRecovery<NoticeConfirmationResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/notices/${encodeURIComponent(noticeId)}/confirmation`, {
      method: "PUT",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function createNoticeReminder(
  noticeId: string,
  contentRevision: string,
  idempotencyKey: string,
): Promise<InAppReminderCreateResponse> {
  const body = JSON.stringify({
    content_revision: reminderContentRevision(contentRevision, "공지"),
  });
  return withCsrfRecovery<InAppReminderCreateResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/notices/${encodeURIComponent(noticeId)}/reminders`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function listNoticeConfirmations(
  noticeId: string,
  state: NoticeConfirmationListState,
  cursor?: string,
): Promise<NoticeConfirmationsResponse> {
  const response = await apiFetch(
    queryPath(`/api/v1/notices/${encodeURIComponent(noticeId)}/confirmations`, {
      state,
      cursor,
    }),
    { credentials: "include" },
  );
  return parseResponse<NoticeConfirmationsResponse>(response);
}
