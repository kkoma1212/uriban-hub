import { X } from "lucide-react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import type {
  AttendanceHistoryItem,
  AttendanceNotificationType,
} from "../../api/attendance-notifications";
import { formatKstCalendarDate } from "../../lib/kst-format";
import { useModalIsolation } from "../layout/use-modal-isolation";

/*
 * 숫자만 보면 "언제였지"가 남는다. 세 유형 중 하나를 누르면 그 날짜들을 그대로
 * 펼쳐 보여준다 — 지각·조퇴는 몇 시로 알렸는지까지 함께 보여야 기억이 붙는다.
 * 출결 화면 본체가 이미 1,551줄이라 여기로 갈랐다.
 */
export const ATTENDANCE_TYPE_LABEL: Record<AttendanceNotificationType, string> = {
  absent: "결석",
  early: "조퇴",
  late: "지각",
};

const STATUS_LABEL = {
  acknowledged: "선생님 읽음",
  canceled: "취소함",
  pending: "확인 대기",
} as const;

export function AttendanceHistoryDialog({
  fallbackFocusTo,
  items,
  onClose,
  open,
  returnFocusTo,
  type,
}: {
  fallbackFocusTo?: HTMLElement | null;
  items: AttendanceHistoryItem[];
  onClose: () => void;
  open: boolean;
  returnFocusTo?: HTMLElement | null;
  type: AttendanceNotificationType | undefined;
}): React.JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalOpen = open && type !== undefined;
  useModalIsolation({
    dialogRef,
    fallbackFocusTo,
    initialFocusRef: closeRef,
    onDismiss: onClose,
    open: modalOpen,
    returnFocusTo,
  });

  if (!modalOpen || type === undefined || typeof document === "undefined") return null;
  const label = ATTENDANCE_TYPE_LABEL[type];
  const matching = items.filter((item) => item.notification_type === type);
  // 알린 날짜를 최신부터 보여준다. 최근 것이 먼저 궁금하다.
  const ordered = [...matching].sort((left, right) =>
    right.notification_date.localeCompare(left.notification_date),
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4"
      data-attendance-history-dialog={type}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-card border border-app-border bg-app-surface p-5 shadow-card"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-role-primary">최근 1년 · 내가 알린 기록</p>
            <h2 className="mt-1 text-lg font-extrabold text-app-text" id={titleId}>
              {label} {ordered.length}회
            </h2>
          </div>
          <button
            aria-label="닫기"
            className="ui-icon-button ui-button-secondary shrink-0"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        {ordered.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-app-surface-muted px-4 py-6 text-center text-sm font-semibold text-app-muted">
            {label}으로 알린 날이 없어요.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2">
            {ordered.map((item) => (
              <li
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-2xl border border-app-border bg-app-surface-raised px-4 py-3"
                key={`${item.notification_date}-${item.notification_type}`}
              >
                <span className="min-w-0">
                  <time
                    className="block text-sm font-extrabold text-app-text"
                    dateTime={item.notification_date}
                  >
                    {formatKstCalendarDate(item.notification_date)}
                  </time>
                  {/* 결석은 하루 종일이라 시각이 없다. 없는 칸을 억지로 만들지 않는다. */}
                  {item.expected_time === null ? null : (
                    <span className="mt-0.5 block text-xs font-bold text-role-primary">
                      {item.expected_time} 예정
                    </span>
                  )}
                </span>
                <span className="shrink-0 rounded-full bg-app-surface-muted px-2.5 py-1 text-xs font-bold text-app-muted">
                  {STATUS_LABEL[item.status] ?? item.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
