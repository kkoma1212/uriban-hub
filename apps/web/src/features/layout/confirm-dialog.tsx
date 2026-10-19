import { BellRing, TriangleAlert } from "lucide-react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import { useModalIsolation } from "./use-modal-isolation";

export interface ConfirmDialogProps {
  appearance?: "dark" | "light";
  cancelLabel?: string | null;
  confirmLabel: string;
  confirmTone?: "danger" | "primary";
  description: React.ReactNode;
  fallbackFocusTo?: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  returnFocusTo?: HTMLElement | null;
  title: string;
}

export function ConfirmDialog({
  appearance = "light",
  cancelLabel = "취소",
  confirmLabel,
  confirmTone = "danger",
  description,
  fallbackFocusTo,
  onCancel,
  onConfirm,
  open,
  returnFocusTo,
  title,
}: ConfirmDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  useModalIsolation({
    dialogRef,
    fallbackFocusTo,
    initialFocusRef: cancelLabel === null ? confirmButtonRef : cancelButtonRef,
    onDismiss: onCancel,
    open,
    returnFocusTo,
  });

  if (!open || typeof document === "undefined") return null;

  const dark = appearance === "dark";
  const ConfirmIcon = confirmTone === "danger" ? TriangleAlert : BellRing;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 backdrop-blur-[2px] sm:items-center sm:p-6"
      data-testid="confirm-dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`w-full rounded-t-[1.75rem] border p-6 shadow-2xl sm:max-w-md sm:rounded-shell sm:p-7 ${
          dark
            ? "border-slate-700 bg-slate-900 text-slate-100"
            : "border-app-border bg-app-surface-raised text-app-text"
        }`}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className={`grid size-11 place-items-center rounded-2xl ${
            confirmTone === "danger"
              ? "bg-danger-surface text-danger-text"
              : dark
                ? "bg-blue-400/15 text-blue-200"
                : "bg-role-soft text-role-primary"
          }`}
        >
          <ConfirmIcon size={21} />
        </div>
        <h2
          className={`mt-5 break-keep [overflow-wrap:anywhere] text-xl font-extrabold tracking-[-0.025em] ${
            dark ? "text-white" : "text-app-text"
          }`}
          id={titleId}
        >
          {title}
        </h2>
        <div
          className={`mt-3 break-keep text-sm leading-6 ${dark ? "text-slate-300" : "text-app-muted"}`}
          id={descriptionId}
        >
          {description}
        </div>
        <div className={`mt-7 grid gap-3 ${cancelLabel === null ? "grid-cols-1" : "grid-cols-2"}`}>
          {cancelLabel === null ? null : (
            <button
              className={`ui-button ${dark ? "ui-button-on-dark" : "ui-button-secondary"}`}
              onClick={onCancel}
              ref={cancelButtonRef}
              type="button"
            >
              {cancelLabel}
            </button>
          )}
          <button
            className={`ui-button ${
              confirmTone === "danger"
                ? "ui-button-danger-solid"
                : "ui-button-primary whitespace-nowrap"
            }`}
            onClick={onConfirm}
            ref={confirmButtonRef}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
