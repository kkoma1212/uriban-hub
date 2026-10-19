import type { NoticeConfirmationState } from "../../api/notices";

import { formatKstCalendarDate, formatKstDateTimeWithWeekday } from "../../lib/kst-format";

export function formatNoticeDateTime(value: string): string {
  return formatKstDateTimeWithWeekday(value);
}

export function formatNoticeDate(value: string): string {
  return formatKstCalendarDate(value);
}

/** 공지 등록 직후 안내. 교사가 첫날 이 앱의 차이(읽음 확인·수정본 재확인)를 알게 한다. */
export const NOTICE_CREATED_MESSAGE =
  "공지를 등록했어요. 아래 학생 확인 현황에서 누가 읽었는지 볼 수 있고, 내용을 고치면 이미 읽은 학생에게 다시 확인을 받아요.";

export const confirmationStateLabel: Record<NoticeConfirmationState, string> = {
  confirmed: "확인 완료",
  modified_unconfirmed: "수정 후 재확인 필요",
  unread: "미확인",
};

export function confirmationStateClassName(state: NoticeConfirmationState): string {
  switch (state) {
    case "confirmed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "modified_unconfirmed":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "unread":
      return "border-app-border bg-app-surface-muted text-app-muted";
  }
}
