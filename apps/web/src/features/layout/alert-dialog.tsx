import { CircleAlert } from "lucide-react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import { useModalIsolation } from "./use-modal-isolation";

interface AlertDialogProps {
  description: React.ReactNode;
  onClose: () => void;
  open: boolean;
  returnFocusTo?: HTMLElement | null;
  title: string;
}

export function AlertDialog({
  description,
  onClose,
  open,
  returnFocusTo,
  title,
}: AlertDialogProps): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalIsolation({
    dialogRef,
    initialFocusRef: closeButtonRef,
    onDismiss: onClose,
    open,
    returnFocusTo,
  });

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-3 backdrop-blur-[2px] sm:items-center sm:p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-sm rounded-shell border border-danger-border bg-app-surface-raised p-5 text-app-text shadow-2xl sm:p-6"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-xl bg-danger-surface text-danger-text"
        >
          <CircleAlert size={20} />
        </div>
        <h2 className="mt-4 text-lg font-extrabold tracking-[-0.025em]" id={titleId}>
          {title}
        </h2>
        <div className="mt-2 break-keep text-sm leading-6 text-app-muted" id={descriptionId}>
          {description}
        </div>
        <button
          className="ui-button ui-button-primary mt-5 min-h-11 w-full"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          확인
        </button>
      </div>
    </div>,
    document.body,
  );
}
