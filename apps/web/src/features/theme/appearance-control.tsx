import { useId } from "react";

import { type AppearancePreference } from "./appearance";
import { AppearanceProvider, useAppearance, useOptionalAppearance } from "./appearance-provider";

const APPEARANCE_OPTIONS: ReadonlyArray<{
  label: string;
  value: AppearancePreference;
}> = [
  { label: "시스템", value: "system" },
  { label: "밝게", value: "light" },
  { label: "어둡게", value: "dark" },
];

interface AppearanceControlProps {
  className?: string;
  description?: string;
  label?: string;
}

function AppearanceControlContent({
  className = "",
  description = "기기 설정을 따르거나 밝은 화면과 어두운 화면을 직접 선택할 수 있어요.",
  label = "화면 모드",
}: AppearanceControlProps): React.JSX.Element {
  const descriptionId = useId();
  const name = useId();
  const { preference, resolved, setPreference } = useAppearance();

  return (
    <fieldset aria-describedby={descriptionId} className={`min-w-0 ${className}`}>
      <legend className="text-sm font-extrabold text-app-text">{label}</legend>
      <p className="mt-1 break-keep text-sm leading-6 text-app-muted" id={descriptionId}>
        {description}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-app-border bg-app-surface-muted p-1.5">
        {APPEARANCE_OPTIONS.map((option) => {
          const selected = preference === option.value;
          return (
            <label
              className={`flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-xl border px-2 text-sm font-extrabold transition-colors ${
                selected
                  ? "border-role-border bg-app-surface-raised text-role-primary shadow-sm"
                  : "border-transparent text-app-muted hover:bg-app-surface hover:text-app-text"
              }`}
              key={option.value}
            >
              <input
                checked={selected}
                className="size-4 shrink-0 accent-[var(--color-role-primary)]"
                name={name}
                onChange={() => setPreference(option.value)}
                type="radio"
                value={option.value}
              />
              <span className="whitespace-nowrap">{option.label}</span>
            </label>
          );
        })}
      </div>
      <p aria-live="polite" className="sr-only">
        현재 적용 모드: {resolved === "dark" ? "어둡게" : "밝게"}
      </p>
    </fieldset>
  );
}

export function AppearanceControl(props: AppearanceControlProps): React.JSX.Element {
  const context = useOptionalAppearance();

  if (context === undefined) {
    return (
      <AppearanceProvider>
        <AppearanceControlContent {...props} />
      </AppearanceProvider>
    );
  }

  return <AppearanceControlContent {...props} />;
}
