import { apiFetch, entityEtag, parseResponse, withCsrfRecovery } from "./auth";
import type { ContentAudienceMode, ContentAudienceRequest } from "./content-audiences";
import { reminderContentRevision, type InAppReminderCreateResponse } from "./in-app-reminders";

export type SupplyScope = "past" | "upcoming" | "today" | "this_week";

export type SupplyCheckState = "checked" | "modified_unconfirmed" | "unchecked";

/** 숙제는 준비물 목록 안에 종류로 들어 있다 — 확인 현황·재알림을 그대로 물려받는다. */
export type SupplyCategory = "general" | "homework";

export interface SupplyItem {
  audience_mode: ContentAudienceMode;
  category: SupplyCategory;
  check_state?: SupplyCheckState;
  content_revision: string;
  description: string | null;
  id: string;
  needed_on: string;
  row_version: string;
  title: string;
}

export interface SupplyListResponse {
  date_range?: { start_date: string; end_date: string };
  items: SupplyItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export interface SupplyWriteRequest {
  audience?: ContentAudienceRequest;
  category: SupplyCategory;
  description: string | null;
  needed_on: string;
  title: string;
}

export interface SupplyEntityResponse {
  etag: string;
  item: SupplyItem;
}

export interface SupplyCheckResponse {
  check_state: SupplyCheckState;
  content_revision: string;
  supply_id: string;
}

export type SupplyCheckListState = SupplyCheckState;

export interface SupplyCheckMember {
  check_state: SupplyCheckState;
  display_name: string;
  member_id: string;
  student_number: number | null;
}

export interface SupplyCheckCounts {
  checked: number;
  /** 게시 이후 승인돼 이 준비물의 대상이 아닌 학생 수. 위 세 집계에는 포함되지 않는다. */
  excluded_member_count: number;
  modified_unconfirmed: number;
  /** 수정 뒤 새 내용을 다시 챙긴 학생 수(확인 현황 응답에만 있음). */
  reconfirmed?: number;
  unchecked: number;
}

export interface SupplyChecksResponse {
  content_revision: string;
  counts: SupplyCheckCounts;
  items: SupplyCheckMember[];
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

function strongEtag(response: Response, item: SupplyItem): string {
  return entityEtag(item.row_version, response.headers.get("ETag"));
}

async function parseSupplyEntity(response: Response): Promise<SupplyEntityResponse> {
  const item = await parseResponse<SupplyItem>(response);
  return { etag: strongEtag(response, item), item };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

/**
 * 종류를 생략하면 준비물과 숙제를 섞어 준다 — 학생 화면이 그렇게 쓴다.
 * 거르기는 서버가 한다. 화면에서 거르면 커서 한 페이지가 통째로 걸러져
 * "더 없음"으로 보인다.
 */
export async function listSupplies(
  scope: SupplyScope,
  cursor?: string,
  category?: SupplyCategory,
  search?: string,
  checkState?: SupplyCheckState,
): Promise<SupplyListResponse> {
  /* 검색어는 커서에 묶여 있다 — 다음 쪽을 부를 때도 같은 값을 보내야 한다. */
  const response = await apiFetch(
    queryPath("/api/v1/supplies", { scope, cursor, category, q: search, check_state: checkState }),
    { credentials: "include" },
  );
  return parseResponse<SupplyListResponse>(response);
}

export async function getSupply(supplyId: string): Promise<SupplyEntityResponse> {
  const response = await apiFetch(`/api/v1/supplies/${encodeURIComponent(supplyId)}`, {
    credentials: "include",
  });
  return parseSupplyEntity(response);
}

export async function createSupply(
  request: SupplyWriteRequest,
  idempotencyKey: string,
): Promise<SupplyEntityResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch("/api/v1/supplies", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseSupplyEntity,
  );
}

export async function updateSupply(
  supplyId: string,
  request: SupplyWriteRequest,
  etag: string,
): Promise<SupplyEntityResponse> {
  const { audience: _immutableAudience, ...mutableRequest } = request;
  const body = JSON.stringify(mutableRequest);
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/supplies/${encodeURIComponent(supplyId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "If-Match": etag,
          "X-CSRF-Token": csrfToken,
        },
        body,
      }),
    parseSupplyEntity,
  );
}

export async function deleteSupply(
  supplyId: string,
  reason: string | null,
  etag: string,
): Promise<void> {
  const body = JSON.stringify({ reason });
  return withCsrfRecovery(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/supplies/${encodeURIComponent(supplyId)}`, {
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

export async function setSupplyCheck(
  supplyId: string,
  isChecked: boolean,
  contentRevision: string,
): Promise<SupplyCheckResponse> {
  const numericRevision = Number(contentRevision);
  if (!Number.isSafeInteger(numericRevision) || numericRevision < 1) {
    throw new Error("준비물 내용이 방금 바뀌었을 수 있어요. 화면을 새로고침해 주세요.");
  }
  const body = JSON.stringify({
    is_checked: isChecked,
    content_revision: numericRevision,
  });
  return withCsrfRecovery<SupplyCheckResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/supplies/${encodeURIComponent(supplyId)}/check`, {
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

export async function createSupplyReminder(
  supplyId: string,
  contentRevision: string,
  idempotencyKey: string,
): Promise<InAppReminderCreateResponse> {
  const body = JSON.stringify({
    content_revision: reminderContentRevision(contentRevision, "준비물"),
  });
  return withCsrfRecovery<InAppReminderCreateResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/supplies/${encodeURIComponent(supplyId)}/reminders`, {
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

export async function listSupplyChecks(
  supplyId: string,
  state: SupplyCheckListState,
  cursor?: string,
): Promise<SupplyChecksResponse> {
  const response = await apiFetch(
    queryPath(`/api/v1/supplies/${encodeURIComponent(supplyId)}/checks`, {
      state,
      cursor,
    }),
    { credentials: "include" },
  );
  return parseResponse<SupplyChecksResponse>(response);
}
