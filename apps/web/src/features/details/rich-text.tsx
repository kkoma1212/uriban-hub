import { Bold, Highlighter } from "lucide-react";
import { Fragment, useLayoutEffect, useState } from "react";

import { hasRichText, parseRichText, wrapSelection, type RichTextStyle } from "../../lib/rich-text";

// 홈 소식의 중요 공지와 같은 형광 밑줄(테마별 색 — 어두운 테마에서는 글자를 가리지 않는 짙은 초록).
// 노랑은 '바뀜' 전용이라 쓰지 않는다(planning/common-frame-20260927).
const MARK_CLASS =
  "bg-transparent text-inherit [text-decoration:underline_var(--color-feed-important-mark)_0.35em] [text-underline-offset:-0.12em] [text-decoration-skip-ink:none]";

/** 공지 본문의 **굵게**·==형광펜==을 그린다. 글자는 React 글자 마디로만 넣는다(HTML로 해석하지 않음). */
export function RichText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseRichText(text).map((segment, index) =>
        segment.style === "bold" ? (
          <strong className="font-extrabold" key={index}>
            {segment.text}
          </strong>
        ) : segment.style === "mark" ? (
          <mark className={MARK_CLASS} key={index}>
            {segment.text}
          </mark>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/** 쓰기 칸 아래 줄의 [굵게][형광펜]. 고른 글자를 기호로 감싸고, 다시 그린 뒤 그 글자를 계속 골라 둔다. */
export function RichTextButtons({
  buttonClassName,
  disabled,
  onChange,
  textareaRef,
}: {
  /** 쓰기 칸 아래 줄(content-input-memo-footer)은 CSS가 단추 모양을 정한다. 그 밖에서만 준다. */
  buttonClassName?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}): React.JSX.Element {
  const [pendingSelection, setPendingSelection] = useState<[number, number]>();
  useLayoutEffect(() => {
    if (pendingSelection === undefined) return;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(...pendingSelection);
    setPendingSelection(undefined);
  }, [pendingSelection, textareaRef]);

  function apply(style: RichTextStyle): void {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const next = wrapSelection(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      style,
    );
    onChange(next.value);
    setPendingSelection([next.selectionStart, next.selectionEnd]);
  }

  return (
    <span aria-label="본문 서식" className="inline-flex gap-1" role="toolbar">
      <button
        className={buttonClassName}
        disabled={disabled}
        onClick={() => apply("bold")}
        type="button"
      >
        <Bold aria-hidden="true" size={15} />
        굵게
      </button>
      <button
        className={buttonClassName}
        disabled={disabled}
        onClick={() => apply("mark")}
        type="button"
      >
        <Highlighter aria-hidden="true" size={15} />
        형광펜
      </button>
    </span>
  );
}

/**
 * 오른쪽 미리보기가 없는 예전 양식(공지·준비물 수정)용: [굵게][형광펜] 단추 + 서식이 있을 때만 학생에게 보일 모습.
 */
export function RichTextFieldTools({
  disabled = false,
  onChange,
  textareaRef,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
}): React.JSX.Element {
  return (
    <>
      <div className="mt-2">
        <RichTextButtons
          buttonClassName="ui-button ui-button-secondary min-h-11 gap-1.5 px-3 text-sm"
          disabled={disabled}
          onChange={onChange}
          textareaRef={textareaRef}
        />
      </div>
      {hasRichText(value) ? (
        <div
          className="mt-3 rounded-2xl border border-app-border bg-app-surface-muted px-4 py-3"
          data-rich-text-preview
        >
          <p className="text-xs font-bold text-app-muted">학생에게 이렇게 보여요</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-7 text-app-text">
            <RichText text={value.trim()} />
          </p>
        </div>
      ) : null}
    </>
  );
}
