import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { NoticeCategory, NoticeConfirmationState } from "../notices/notices.types.js";
import type { SupplyCategory, SupplyCheckState } from "../supplies/supplies.types.js";

/*
 * 통합 알림은 공지·준비물만 싣는다(2026-08-18 Hex 결정). 투표는 투표 화면 한 곳에서만
 * 다룬다 — 만드는 입구와 보는 자리가 여러 화면에 흩어져 있어 매번 어디서 찾을지
 * 헷갈렸다. 화면에서만 빼면 서버가 아무도 안 쓰는 투표를 계속 실어 보내게 되므로
 * 피드 자체에서 뺐다.
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
export type UpdateItemKind = "notice" | "supply";

/** Shared SQL projection; publication time keeps the feed's six-digit cursor precision. */
export interface UpdatesFeedRow {
  audience_mode: string;
  category: string;
  check_state: string | null;
  confirmation_state: string | null;
  content: string | null;
  content_revision: string;
  id: string;
  is_important: boolean;
  item_kind: string;
  needed_on: string | null;
  published_at: string;
  row_version: string;
  title: string;
}
/** 항목의 종류. kind 별 하위 분류다 — 공지는 자기 category, 준비물은 general/homework. */
export type UpdateItemCategory = NoticeCategory | SupplyCategory;

export interface UpdateItem {
  audience_mode: ContentAudienceMode;
  category: UpdateItemCategory;
  check_state?: SupplyCheckState;
  confirmation_state?: NoticeConfirmationState;
  content: string | null;
  content_revision: string;
  id: string;
  is_important: boolean;
  kind: UpdateItemKind;
  needed_on: string | null;
  published_at: string;
  row_version: string;
  title: string;
}

export interface ListUpdatesResult {
  /** 검색·필터와 무관한 본인 미완료 수. 기존 소식 범위(준비물 최근 90일), 교사는 null. */
  unresolved_count?: number | null;
  items: UpdateItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export interface ListUpdatesQuery {
  actorUserId: string;
  cursor?: string;
  filter: UpdatesFilter;
  /** 제목·본문 검색어. 공백만 들어오면 undefined로 정규화된다. */
  search?: string;
}
