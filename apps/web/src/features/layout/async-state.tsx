import { AlertTriangle, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type AsyncStateKind = "empty" | "error" | "loading";
type AsyncStateTone = "important" | "meal" | "neutral" | "schedule" | "supplies";

const toneClassName: Record<AsyncStateTone, { icon: string; skeleton: string; surface: string }> = {
  important: {
    icon: "text-home-important",
    skeleton: "bg-danger-surface",
    surface: "border-home-important-line bg-home-important-soft",
  },
  meal: {
    icon: "text-home-meal",
    skeleton: "bg-home-meal-line",
    surface: "border-home-meal-line bg-home-meal-soft",
  },
  neutral: {
    icon: "text-role-primary",
    skeleton: "bg-app-border",
    surface: "border-app-border bg-app-surface-muted",
  },
  schedule: {
    icon: "text-home-schedule",
    skeleton: "bg-home-schedule-line",
    surface: "border-home-schedule-line bg-home-schedule-soft",
  },
  supplies: {
    icon: "text-home-supplies",
    skeleton: "bg-home-supplies-line",
    surface: "border-home-supplies-line bg-home-supplies-soft",
  },
};

interface AsyncStatePanelProps {
  action?: ReactNode;
  description?: string;
  icon?: LucideIcon;
  kind: AsyncStateKind;
  title: string;
  tone?: AsyncStateTone;
}

export function AsyncStatePanel({
  action,
  description,
  icon,
  kind,
  title,
  tone = "neutral",
}: AsyncStatePanelProps): React.JSX.Element {
  const classes = toneClassName[tone];

  if (kind === "loading") {
    return (
      <div
        aria-live="polite"
        className={`mt-6 overflow-hidden rounded-card border px-5 py-6 ${classes.surface}`}
        role="status"
      >
        <div className="flex min-w-0 items-center gap-3">
          <LoaderCircle
            aria-hidden="true"
            className={`shrink-0 motion-safe:animate-spin ${classes.icon}`}
            size={24}
          />
          <p className="break-keep text-sm font-bold text-app-text">{title}</p>
        </div>
        <div aria-hidden="true" className="mt-5 grid gap-3 sm:grid-cols-2">
          {[0, 1].map((index) => (
            <div
              className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
              key={index}
            >
              <div className={`h-4 w-2/3 rounded-full ${classes.skeleton}`} />
              <div className={`mt-3 h-3 w-1/3 rounded-full ${classes.skeleton}`} />
              <div className={`mt-5 h-3 w-full rounded-full ${classes.skeleton}`} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const Icon = kind === "error" ? AlertTriangle : icon;
  return (
    <div
      aria-live={kind === "error" ? "assertive" : undefined}
      className={`mt-6 rounded-card border px-5 py-9 text-center ${
        kind === "error" ? "border-danger-border bg-danger-surface" : classes.surface
      }`}
      role={kind === "error" ? "alert" : undefined}
    >
      {Icon === undefined ? null : (
        <Icon
          aria-hidden="true"
          className={`mx-auto ${kind === "error" ? "text-danger-text" : classes.icon}`}
          size={34}
        />
      )}
      <p
        className={`break-keep font-bold ${
          kind === "error" ? "mt-4 text-danger-text" : "mt-4 text-app-text"
        }`}
      >
        {title}
      </p>
      {description === undefined ? null : (
        <>
          {" "}
          <p
            className={`mt-2 break-keep text-sm leading-6 ${
              kind === "error" ? "text-danger-text" : "text-app-muted"
            }`}
          >
            {description}
          </p>
        </>
      )}
      {action === undefined ? null : <div className="mt-4">{action}</div>}
    </div>
  );
}

interface StaleDataAlertProps {
  busy: boolean;
  description: string;
  onRetry: () => void;
  title: string;
}

export function StaleDataAlert({
  busy,
  description,
  onRetry,
  title,
}: StaleDataAlertProps): React.JSX.Element {
  return (
    <div
      className="mt-6 rounded-card border border-danger-border bg-danger-surface px-5 py-5"
      role="alert"
    >
      <p className="break-keep font-bold text-danger-text">{title}</p>
      <p className="mt-2 break-keep text-sm leading-6 text-danger-text">{description}</p>
      <button
        aria-busy={busy}
        className="ui-button ui-button-primary mt-4 text-sm"
        disabled={busy}
        onClick={onRetry}
        type="button"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={17} /> : null}
        {busy ? "다시 불러오는 중" : "다시 시도"}
      </button>
    </div>
  );
}
