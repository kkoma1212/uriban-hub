import { ChevronRight, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ContentAudienceRequest } from "../../api/content-audiences";
import { ContentInputReview } from "../layout/content-input-frame";
import { ContentAudienceSelector } from "./content-audience-selector";

export function inputAudienceLabel(audience: ContentAudienceRequest | undefined): string {
  return audience === undefined
    ? "선택해 주세요"
    : audience.mode === "all"
      ? "올릴 때의 반 전체 학생"
      : "선택 학생 " + audience.member_ids.length + "명";
}

interface ContentInputAudienceProps {
  audience: ContentAudienceRequest | undefined;
  busy: boolean;
  enabled: boolean;
  invalid?: boolean;
  locked: boolean;
  errorId: string;
  errorMessage?: string | undefined;
  onChange: (audience: ContentAudienceRequest) => void;
}

export function ContentInputAudience({
  audience,
  busy,
  enabled,
  invalid = false,
  locked,
  errorId,
  errorMessage,
  onChange,
}: ContentInputAudienceProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (invalid) setOpen(true);
  }, [invalid]);
  useEffect(() => {
    if (open && invalid)
      selectorRef.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
  }, [invalid, open]);
  return (
    <section aria-label="게시 대상과 결과">
      <button
        aria-expanded={open}
        aria-label={"받는 사람: " + inputAudienceLabel(audience)}
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        className="content-input-recipient"
        disabled={busy || locked}
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <UsersRound aria-hidden="true" size={19} />
        <strong>받는 사람</strong>
        <span>{inputAudienceLabel(audience)}</span>
        <ChevronRight aria-hidden="true" size={16} />
      </button>
      {!open && invalid && errorMessage ? (
        <p className="content-input-error mt-2" id={errorId} role="alert">
          {errorMessage}
        </p>
      ) : null}
      <ContentInputReview
        open={open}
        title="받는 사람"
        cancelLabel="닫기"
        confirmLabel="선택 완료"
        onCancel={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
        returnFocusTo={triggerRef.current}
      >
        {invalid && errorMessage ? (
          <p className="content-input-error mb-3" id={errorId} role="alert">
            {errorMessage}
          </p>
        ) : null}
        <div ref={selectorRef}>
          <ContentAudienceSelector
            busy={busy}
            enabled={enabled}
            errorId={errorId}
            invalid={invalid}
            locked={locked}
            onChange={onChange}
            value={audience}
          />
        </div>
      </ContentInputReview>
    </section>
  );
}
