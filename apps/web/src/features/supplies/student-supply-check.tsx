import { Check, Circle, LoaderCircle, RotateCcw } from "lucide-react";

import type { SupplyCategory, SupplyCheckState } from "../../api/supplies";
import { checkActionLabel, checkStateClassName, checkStateLabel } from "./supply-format";

/*
 * 2026-09-27 확정 시안(상세형): '챙겼어요 · 다 했어요'는 늘 큰 초록 버튼(해야 할 행동).
 * 예전엔 고른 상태를 초록으로 칠해, 기본값 '아직이에요'가 처음부터 초록이라 누를 버튼처럼 보였다.
 * 고른 상태는 aria-pressed로 알리고, '아직이에요'는 골랐을 때만 테두리 버튼으로 둔다.
 */
const DONE_BUTTON = "ui-button-primary";

interface StudentSupplyCheckProps {
  busy: boolean;
  compact?: boolean;
  category: SupplyCategory;
  onSet: (isChecked: boolean) => void;
  pendingChecked: boolean | undefined;
  state: SupplyCheckState;
}

export function StudentSupplyCheck({
  busy,
  compact = false,
  category,
  onSet,
  pendingChecked,
  state,
}: StudentSupplyCheckProps): React.JSX.Element {
  if (compact)
    return (
      <div
        aria-label={category === "homework" ? "내 숙제 완료 상태" : "내 준비물 챙김 상태"}
        className="grid grid-cols-2 gap-2"
        role="group"
      >
        <button
          aria-busy={busy}
          aria-pressed={state === "checked"}
          className={`ui-button min-h-12 min-w-0 px-2 text-sm ${DONE_BUTTON}`}
          disabled={busy}
          onClick={() => onSet(true)}
          type="button"
        >
          {busy && pendingChecked === true ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : (
            <Check aria-hidden="true" size={18} />
          )}
          {checkActionLabel(category)}
        </button>
        <button
          aria-busy={busy}
          aria-pressed={state === "unchecked"}
          className={`ui-button min-h-12 min-w-0 px-2 text-sm ${
            state === "unchecked" ? "ui-button-secondary" : "ui-button-tertiary"
          }`}
          disabled={busy}
          onClick={() => onSet(false)}
          type="button"
        >
          {busy && pendingChecked === false ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : state === "modified_unconfirmed" ? (
            <RotateCcw aria-hidden="true" size={18} />
          ) : (
            <Circle aria-hidden="true" size={18} />
          )}
          아직이에요
        </button>
      </div>
    );
  return (
    <section className="mt-6 rounded-card border border-role-border bg-role-soft p-5 sm:p-7">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-role-primary">내 준비 상태</p>
          <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">
            {category === "homework" ? "숙제를 다 했나요?" : "준비물을 챙겼나요?"}
          </h2>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-bold ${checkStateClassName(
            state,
          )}`}
        >
          {checkStateLabel(state, category)}
        </span>
      </div>

      <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
        {state === "modified_unconfirmed"
          ? "선생님이 내용을 수정했어요. 최신 내용을 읽고 상태를 다시 선택해 주세요."
          : `직접 선택한 상태만 저장되며, 화면을 열어 본 것만으로는 ${
              category === "homework" ? "완료" : "챙김"
            } 처리되지 않아요.`}
      </p>

      <div
        aria-label={category === "homework" ? "내 숙제 완료 상태" : "내 준비물 챙김 상태"}
        className="mt-5 grid grid-cols-2 gap-3"
        role="group"
      >
        <button
          aria-busy={busy}
          aria-pressed={state === "checked"}
          className={`ui-button min-w-0 px-2 text-sm ${DONE_BUTTON}`}
          disabled={busy}
          onClick={() => onSet(true)}
          type="button"
        >
          {busy && pendingChecked === true ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : (
            <Check aria-hidden="true" size={18} />
          )}
          {checkActionLabel(category)}
        </button>
        <button
          aria-busy={busy}
          aria-pressed={state === "unchecked"}
          className={`ui-button min-w-0 px-2 text-sm ${
            state === "unchecked" ? "ui-button-secondary" : "ui-button-tertiary"
          }`}
          disabled={busy}
          onClick={() => onSet(false)}
          type="button"
        >
          {busy && pendingChecked === false ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : state === "modified_unconfirmed" ? (
            <RotateCcw aria-hidden="true" size={18} />
          ) : (
            <Circle aria-hidden="true" size={18} />
          )}
          아직이에요
        </button>
      </div>
    </section>
  );
}
