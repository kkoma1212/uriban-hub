import type { ContentAudienceMode } from "../content-audiences/content-audiences.service.js";
import type { NoticeCategory, NoticeConfirmationState, NoticeItem } from "./notices.types.js";

export interface NoticeViewRow {
  audience_mode: string;
  category: string;
  content: string;
  content_revision: string;
  id: string;
  is_important: boolean;
  published_at: Date | string;
  row_version: string;
  title: string;
}

export function noticeConfirmationState(
  confirmedRevision: string | null,
  contentRevision: string,
): NoticeConfirmationState {
  if (confirmedRevision === null) return "unread";
  return confirmedRevision === contentRevision ? "confirmed" : "modified_unconfirmed";
}

export function noticeItemView(
  row: NoticeViewRow,
  confirmationState?: NoticeConfirmationState,
): NoticeItem {
  return {
    audience_mode: row.audience_mode as ContentAudienceMode,
    category: row.category as NoticeCategory,
    ...(confirmationState === undefined ? {} : { confirmation_state: confirmationState }),
    content: row.content,
    content_revision: row.content_revision,
    id: row.id,
    is_important: row.is_important,
    published_at:
      row.published_at instanceof Date
        ? row.published_at.toISOString()
        : new Date(row.published_at).toISOString(),
    row_version: row.row_version,
    title: row.title,
  };
}
