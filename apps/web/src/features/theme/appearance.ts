export const APPEARANCE_STORAGE_KEY = "classhub:appearance";
export const DARK_APPEARANCE_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;

export const APPEARANCE_THEME_COLOR: Readonly<Record<ResolvedAppearance, string>> = {
  light: "#efe8dc",
  dark: "#11131d",
};

export function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

function storedAppearance(): AppearancePreference {
  try {
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearancePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function initialAppearancePreference(): AppearancePreference {
  if (typeof document !== "undefined") {
    const initialized = document.documentElement.getAttribute("data-appearance");
    if (isAppearancePreference(initialized)) return initialized;
  }
  return typeof window === "undefined" ? "system" : storedAppearance();
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_APPEARANCE_MEDIA_QUERY).matches
  );
}

export function applyAppearance(
  preference: AppearancePreference,
  resolved: ResolvedAppearance,
): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.setAttribute("data-appearance", preference);
  root.setAttribute("data-theme", resolved);
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", APPEARANCE_THEME_COLOR[resolved]);
}

export function persistAppearance(preference: AppearancePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, preference);
    }
  } catch {
    // The selected mode still applies for the current page when storage is unavailable.
  }
}
