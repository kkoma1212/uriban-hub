import type {
  ContentAudienceMode,
  NormalizedContentAudience,
} from "../content-audiences/content-audiences.service.js";

export type SupplyCheckState = "checked" | "modified_unconfirmed" | "unchecked";

/**
 * 숙제는 준비물의 한 종류다 — 확인 현황·재알림·페이지네이션을 그대로 물려받으려고
 * 별도 기능이 아니라 이 값으로 갈랐다. 'general' 이름은 notices.category 관습을 따랐다.
 */
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

export interface ListSuppliesResult {
  date_range?: SupplyDateRange;
  items: SupplyItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export interface SupplyCheckResult {
  check_state: SupplyCheckState;
  content_revision: string;
  supply_id: string;
}

export interface SupplyCheckMemberItem {
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
  /**
   * 챙김(checked) 중, 마지막 수정 전부터 체크 기록이 있던 학생 수(수정 뒤 다시 챙김).
   * 재확인율 = reconfirmed / (reconfirmed + modified_unconfirmed). 공지와 같은 기준이다.
   */
  reconfirmed?: number;
  unchecked: number;
}

export interface ListSupplyChecksResult {
  content_revision: string;
  counts: SupplyCheckCounts;
  items: SupplyCheckMemberItem[];
  last_reminder_requested_at: string | null;
  next_cursor: string | null;
  server_today: string;
}

export type SupplyListScope = "past" | "upcoming" | "today" | "this_week";
export interface SupplyDateRange {
  start_date: string;
  end_date: string;
}
export type SupplyCheckFilter = SupplyCheckState;

export interface ListSuppliesQuery {
  actorUserId: string;
  /** 생략하면 준비물과 숙제를 한 목록에 함께 표시한다. */
  category?: SupplyCategory;
  /** 학생 본인의 확인 상태. 생략하면 모든 상태를 조회한다. */
  checkState?: SupplyCheckFilter;
  cursor?: string;
  scope: SupplyListScope;
  /** 제목·내용 검색어. 공백만 들어오면 undefined로 정규화된다. */
  search?: string;
}

export interface GetSupplyQuery {
  actorUserId: string;
  supplyId: string;
}

export interface CreateSupplyCommand {
  actorUserId: string;
  audience: NormalizedContentAudience;
  category: SupplyCategory;
  description: string | null;
  idempotencyKey: string | string[] | undefined;
  neededOn: string;
  requestId: string;
  title: string;
}

export interface UpdateSupplyCommand {
  actorUserId: string;
  category: SupplyCategory | undefined;
  description: string | null | undefined;
  ifMatch: string | string[] | undefined;
  /** 오타 수정으로 저장(판 유지). 판단 기준은 content-edits/minor-edit.ts */
  minorEdit: boolean | undefined;
  neededOn: string | undefined;
  requestId: string;
  supplyId: string;
  title: string | undefined;
}

export interface DeleteSupplyCommand {
  actorUserId: string;
  ifMatch: string | string[] | undefined;
  reason: string | null;
  requestId: string;
  supplyId: string;
}

export interface SetSupplyCheckCommand {
  actorUserId: string;
  contentRevision: string;
  isChecked: boolean;
  supplyId: string;
}

export interface CreateSupplyReminderCommand {
  actorUserId: string;
  contentRevision: string;
  idempotencyKey: string | string[] | undefined;
  requestId: string;
  supplyId: string;
}

export interface ListSupplyChecksQuery {
  actorUserId: string;
  cursor?: string;
  state: SupplyCheckFilter;
  supplyId: string;
}
