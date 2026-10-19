import { apiFetch, parseResponse } from "./auth";
import type { ContentAudienceMode } from "./content-audiences";
import type { NoticeCategory, NoticeConfirmationState } from "./notices";
import type { SupplyCategory, SupplyCheckState } from "./supplies";

/*
 * 통합 알림은 공지·준비물만 싣는다(2026-08-18 Hex 결정). 투표는 투표 화면 한 곳에서만
 * 다룬다 — 서버 피드에서도 뺐으므로 여기서 `poll` 을 되살리면 오지 않는 것을 기다린다.
 */
export type UpdatesFilter =
  | "all"
  | "notices"
  | "materials"
  | "important"
  | "performance"
  | "supplies"
  | "homework"
  | "unresolved";

export interface UpdateItem {
  audience_mode: ContentAudienceMode;
  /** kind 별 하위 분류. 공지는 general/performance, 준비물은 general/homework. */
  category: NoticeCategory | SupplyCategory;
  check_state?: SupplyCheckState;
  confirmation_state?: NoticeConfirmationState;
  content: string | null;
  content_revision: string;
  id: string;
  is_important: boolean;
  kind: "notice" | "supply";
  needed_on: string | null;
  published_at: string;
  row_version: string;
  title: string;
}

export interface UpdatesListResponse {
  /** 검색·필터와 무관한 본인 미완료 수. 기존 소식 범위(준비물 최근 90일), 교사는 null. */
  unresolved_count?: number | null;
  items: UpdateItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export async function listUpdates(
  filter: UpdatesFilter,
  cursor?: string,
  term?: string,
): Promise<UpdatesListResponse> {
  const search = new URLSearchParams({ filter });
  if (cursor !== undefined) search.set("cursor", cursor);
  /* 검색어는 커서에 묶여 있다 — 다음 쪽을 부를 때도 같은 값을 보내야 한다. */
  if (term !== undefined) search.set("q", term);
  const response = await apiFetch(`/api/v1/updates?${search.toString()}`, {
    credentials: "include",
  });
  return parseResponse<UpdatesListResponse>(response);
}
