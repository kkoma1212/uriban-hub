import { Check, CheckCircle2, LoaderCircle, RotateCcw } from "lucide-react";

import type { NoticeConfirmationState } from "../../api/notices";
import { confirmationStateClassName, confirmationStateLabel } from "./notice-format";

interface StudentNoticeConfirmationProps {
  busy: boolean;
  compact?: boolean;
  onConfirm: () => void;
  state: NoticeConfirmationState;
  tone?: "important" | "latest";
}

export function StudentNoticeConfirmation({
  busy,
  compact = false,
  onConfirm,
  state,
  tone = "important",
}: StudentNoticeConfirmationProps): React.JSX.Element {
  const confirmed = state === "confirmed";
  if (compact)
    return (
      <button
        aria-busy={busy}
        aria-label={
          confirmed
            ? "확인했어요"
            : state === "modified_unconfirmed"
              ? "최신 내용 다시 확인"
              : "공지 확인하기"
        }
        className={`ui-button w-full min-h-12 text-sm ${confirmed ? "ui-button-secondary" : "ui-button-primary"}`}
        disabled={busy || confirmed}
        onClick={onConfirm}
        type="button"
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
        ) : confirmed ? (
          <CheckCircle2 aria-hidden="true" size={18} />
        ) : state === "modified_unconfirmed" ? (
          <RotateCcw aria-hidden="true" size={18} />
        ) : (
          <Check aria-hidden="true" size={18} />
        )}
        {busy
          ? "확인하는 중…"
          : confirmed
            ? "확인했어요"
            : state === "modified_unconfirmed"
              ? "최신 내용 다시 확인"
              : "공지 확인하기"}
      </button>
    );
  return (
    <section
      className={`mt-6 rounded-card border p-5 sm:p-7 ${
        tone === "important"
          ? "border-home-important-line bg-home-important-soft"
          : "border-role-border bg-role-soft"
      }`}
      data-notice-surface="student-confirmation"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`text-sm font-bold ${
              tone === "important" ? "text-home-important" : "text-role-primary"
            }`}
          >
            내 확인 상태
          </p>
          <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">
            공지 내용을 모두 읽었나요?
          </h2>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-bold ${confirmationStateClassName(state)}`}
        >
          {confirmationStateLabel[state]}
        </span>
      </div>
      {/* 설명은 한 문장으로 둔다. 취소할 수 없다는 사실은 알리되 겁주지 않는 톤으로. */}
      <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
        {confirmed
          ? "선생님께 확인 완료로 표시됐어요."
          : state === "modified_unconfirmed"
            ? "선생님이 내용을 고쳤어요. 최신 내용을 읽고 다시 눌러 주세요."
            : "내용을 읽은 뒤 눌러 주세요. 누르면 선생님께 확인으로 표시되고 되돌릴 수 없어요."}
      </p>
      <button
        aria-busy={busy}
        className={`ui-button mt-5 w-full text-sm ${confirmed ? "ui-button-secondary" : "ui-button-primary"}`}
        disabled={busy || confirmed}
        onClick={onConfirm}
        type="button"
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
        ) : confirmed ? (
          <CheckCircle2 aria-hidden="true" size={18} />
        ) : state === "modified_unconfirmed" ? (
          <RotateCcw aria-hidden="true" size={18} />
        ) : (
          <Check aria-hidden="true" size={18} />
        )}
        {confirmed
          ? "확인했어요"
          : state === "modified_unconfirmed"
            ? "최신 내용 다시 확인"
            : "공지 확인하기"}
      </button>
    </section>
  );
}
