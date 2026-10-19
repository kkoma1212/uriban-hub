import { LoaderCircle, Save } from "lucide-react";

interface ContentFormActionBarProps {
  busy: boolean;
  onCancel: () => void;
  submitLabel: string;
}

export function ContentFormActionBar({
  busy,
  onCancel,
  submitLabel,
}: ContentFormActionBarProps): React.JSX.Element {
  return (
    <div className="h-[4.75rem]">
      <div
        aria-label="저장 및 취소"
        className="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 mx-auto grid max-w-3xl grid-cols-2 gap-3 rounded-2xl border border-app-border bg-app-surface-raised p-3 shadow-card sm:inset-x-8"
        data-form-action-bar="fixed"
        role="group"
      >
        <button
          className="ui-button ui-button-secondary min-h-12 px-5 text-base"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          취소
        </button>
        <button
          aria-busy={busy}
          className="ui-button ui-button-primary min-h-12 px-5 text-base"
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : (
            <Save aria-hidden="true" size={18} />
          )}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
