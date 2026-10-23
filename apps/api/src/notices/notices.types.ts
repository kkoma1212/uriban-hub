import type {
  ContentAudienceMode,
  NormalizedContentAudience,
} from "../content-audiences/content-audiences.service.js";

export type NoticeConfirmationState = "confirmed" | "modified_unconfirmed" | "unread";
export type NoticeImportance = "all" | "important" | "regular";
export type NoticeConfirmationFilter = NoticeConfirmationState;
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

export interface ListNoticesResult {
  items: NoticeItem[];
  next_cursor: string | null;
  selected_audience_enabled: boolean;
  server_today: string;
}

export interface NoticeConfirmationResult {
  confirmation_state: "confirmed";
  content_revision: string;
  notice_id: string;
}

export interface NoticeConfirmationMemberItem {
  confirmation_state: NoticeConfirmationState;
  display_name: string;
  /** 지금 사진을 받을 수 있으면 true — 화면은 true일 때만 사진을 요청한다. 컨트롤러가 붙인다. */
  has_profile_photo?: boolean;
  member_id: string;
  student_number: number | null;
}

export interface NoticeConfirmationCounts {
  confirmed: number;
  /** 게시 이후 승인돼 이 공지의 대상이 아닌 학생 수. 위 세 집계에는 포함되지 않는다. */
  excluded_member_count: number;
  modified_unconfirmed: number;
  /**
   * 확인함(confirmed) 중, 이전 내용을 확인했다가 수정 뒤 새 내용을 다시 확인한 학생 수.
   * 재확인율 = reconfirmed / (reconfirmed + modified_unconfirmed). 처음 확인한 학생은 빠진다.
   */
  reconfirmed?: number;
  unread: number;
}

export interface ListNoticeConfirmationsResult {
  content_revision: string;
  counts: NoticeConfirmationCounts;
  items: NoticeConfirmationMemberItem[];
  last_reminder_requested_at: string | null;
  next_cursor: string | null;
  server_today: string;
}

export interface ListNoticesQuery {
  actorUserId: string;
  cursor?: string;
  importance: NoticeImportance;
  /** 제목·본문 검색어. 공백만 들어오면 undefined로 정규화된다. */
  search?: string;
}

export interface GetNoticeQuery {
  actorUserId: string;
  noticeId: string;
}

export interface CreateNoticeCommand {
  actorUserId: string;
  audience: NormalizedContentAudience;
  category: NoticeCategory;
  content: string;
  idempotencyKey: string | string[] | undefined;
  isImportant: boolean;
  requestId: string;
  title: string;
}

export interface UpdateNoticeCommand {
  actorUserId: string;
  category: NoticeCategory | undefined;
  content: string | undefined;
  ifMatch: string | string[] | undefined;
  isImportant: boolean | undefined;
  /** 오타 수정으로 저장(판 유지). 판단 기준은 content-edits/minor-edit.ts */
  minorEdit: boolean | undefined;
  noticeId: string;
  requestId: string;
  title: string | undefined;
}

export interface DeleteNoticeCommand {
  actorUserId: string;
  ifMatch: string | string[] | undefined;
  noticeId: string;
  reason: string | null;
  requestId: string;
}

export interface ConfirmNoticeCommand {
  actorUserId: string;
  contentRevision: string;
  noticeId: string;
}

export interface CreateNoticeReminderCommand {
  actorUserId: string;
  contentRevision: string;
  idempotencyKey: string | string[] | undefined;
  noticeId: string;
  requestId: string;
}

export interface ListNoticeConfirmationsQuery {
  actorUserId: string;
  cursor?: string;
  noticeId: string;
  state: NoticeConfirmationFilter;
}
