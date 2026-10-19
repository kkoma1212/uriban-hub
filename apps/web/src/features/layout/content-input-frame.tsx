import { Check, LoaderCircle } from "lucide-react";
import { useId, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useModalIsolation } from "./use-modal-isolation";
import "./content-input-frame.css";

interface ContentInputFrameProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  preview: ReactNode;
  actions: ReactNode;
  keyboardAware?: boolean;
}

/** Keep writing and its action dock inside the visible viewport, including the keyboard. */
export function ContentInputFrame({
  children,
  preview,
  actions,
  keyboardAware = true,
  className = "",
  ...props
}: ContentInputFrameProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null || !keyboardAware) return;
    const viewport = window.visualViewport;
    let animation = 0;
    const measure = (): void => {
      const bounds = frame.getBoundingClientRect();
      const bottom =
        viewport === null || viewport === undefined
          ? window.innerHeight
          : viewport.height + viewport.offsetTop;
      const keyboardBottom = Math.max(0, window.innerHeight - bottom);
      frame.style.setProperty(
        "--input-available-height",
        Math.max(100, bottom - bounds.top - 8) + "px",
      );
      frame.style.setProperty("--input-keyboard-bottom", keyboardBottom + "px");
      frame.style.setProperty("--input-dock-left", bounds.left + "px");
      frame.style.setProperty("--input-dock-width", bounds.width + "px");
      frame.style.setProperty(
        "--input-dock-height",
        (actionsRef.current?.offsetHeight ?? 76) + "px",
      );
      frame.dataset.keyboardOpen = keyboardBottom > 100 ? "true" : "false";
    };
    const scheduleMeasure = (): void => {
      cancelAnimationFrame(animation);
      animation = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("resize", scheduleMeasure);
    viewport?.addEventListener("resize", scheduleMeasure);
    viewport?.addEventListener("scroll", scheduleMeasure);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(frame);
    if (actionsRef.current !== null) observer?.observe(actionsRef.current);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener("resize", scheduleMeasure);
      viewport?.removeEventListener("resize", scheduleMeasure);
      viewport?.removeEventListener("scroll", scheduleMeasure);
      observer?.disconnect();
    };
  }, [keyboardAware]);
  return (
    <div {...props} className={"content-input-frame " + className} ref={frameRef}>
      <div className="content-input-fields">{children}</div>
      <aside className="content-input-aside" aria-label="작성 내용 미리보기">
        <div className="content-input-preview">{preview}</div>
        <div className="content-input-actions" ref={actionsRef}>
          {actions}
        </div>
      </aside>
    </div>
  );
}

export function ContentInputMemo({
  children,
  footer,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & { footer?: ReactNode }): React.JSX.Element {
  return (
    <div {...props} className={"content-input-memo " + className}>
      {children}
      {footer === undefined ? null : <div className="content-input-memo-footer">{footer}</div>}
    </div>
  );
}

export interface ContentInputPreviewProps {
  kind: string;
  title: string;
  content?: string | undefined;
  dateLabel?: string | undefined;
  audienceLabel?: string | undefined;
  important?: boolean;
  boardMessage?: string | undefined;
}

/** Read-only rendering of the home chalkboard and the student's news card. */
export function ContentInputPreview({
  kind,
  title,
  content,
  dateLabel,
  audienceLabel,
  important = false,
  boardMessage,
}: ContentInputPreviewProps): React.JSX.Element {
  return (
    <div className="content-input-student-preview">
      <p className="content-input-preview-label">학생에게 이렇게 보여요</p>
      <div className="content-input-board">
        <div className="content-input-board-face">
          <div className="content-input-board-meta">
            <span>오늘 우리반</span>
            <span>미리보기</span>
          </div>
          <p className="content-input-chalk">
            {boardMessage === undefined ? (
              <span aria-label="새 소식" className="content-input-new-dot" />
            ) : null}
            {boardMessage ?? (title.trim() || "제목을 적어 주세요")}
          </p>
          {dateLabel ? <p className="content-input-board-date">{dateLabel}</p> : null}
        </div>
      </div>
      <article className="content-input-post">
        <div className="content-input-post-meta">
          <span>{kind}</span>
          {important ? <strong>중요</strong> : null}
          <span>선생님</span>
        </div>
        <h3>{title.trim() || "제목을 적어 주세요"}</h3>
        <p className="content-input-post-content">
          {content?.trim() || "작성한 내용이 여기에 보여요."}
        </p>
        {dateLabel ? <p className="content-input-post-date">{dateLabel}</p> : null}
        <p className="content-input-post-footer">
          <Check aria-hidden="true" size={17} />
          확인 전
        </p>
      </article>
      {audienceLabel ? (
        <p className="content-input-preview-audience">받는 사람 · {audienceLabel}</p>
      ) : null}
    </div>
  );
}

interface ContentInputReviewProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  returnFocusTo?: HTMLElement | null | undefined;
}

export function ContentInputReview({
  open,
  title,
  children,
  onCancel,
  onConfirm,
  busy = false,
  confirmLabel = "올리기",
  confirmDisabled = false,
  cancelLabel = "더 고치기",
  returnFocusTo,
}: ContentInputReviewProps): React.JSX.Element | null {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalIsolation({
    dialogRef,
    initialFocusRef: cancelRef,
    onDismiss: () => {
      if (!busy) onCancel();
    },
    open,
    returnFocusTo,
  });
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="content-input-review-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="content-input-review"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div aria-hidden="true" className="content-input-review-handle" />
        <h2 id={titleId}>{title}</h2>
        <div className="content-input-review-body">{children}</div>
        <div className="content-input-review-actions">
          <button
            className="ui-button ui-button-secondary"
            disabled={busy}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className="ui-button content-input-submit"
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            type="button"
          >
            {busy ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <Check aria-hidden="true" size={18} />
            )}{" "}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
