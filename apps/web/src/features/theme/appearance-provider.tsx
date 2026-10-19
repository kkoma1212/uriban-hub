import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";

import {
  APPEARANCE_STORAGE_KEY,
  DARK_APPEARANCE_MEDIA_QUERY,
  applyAppearance,
  initialAppearancePreference,
  isAppearancePreference,
  persistAppearance,
  resolveAppearance,
  systemPrefersDark,
  type AppearancePreference,
  type ResolvedAppearance,
} from "./appearance";

interface AppearanceContextValue {
  preference: AppearancePreference;
  resolved: ResolvedAppearance;
  setPreference: (preference: AppearancePreference) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

export function AppearanceProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [preference, setPreferenceState] = useState(initialAppearancePreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolved = resolveAppearance(preference, systemDark);

  useLayoutEffect(() => {
    applyAppearance(preference, resolved);
  }, [preference, resolved]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(DARK_APPEARANCE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };

    setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== APPEARANCE_STORAGE_KEY) return;
      setPreferenceState(isAppearancePreference(event.newValue) ? event.newValue : "system");
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function setPreference(nextPreference: AppearancePreference): void {
    persistAppearance(nextPreference);
    applyAppearance(nextPreference, resolveAppearance(nextPreference, systemPrefersDark()));
    setPreferenceState(nextPreference);
  }

  return (
    <AppearanceContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (context === undefined) {
    throw new Error("useAppearance must be used inside AppearanceProvider.");
  }
  return context;
}

export function useOptionalAppearance(): AppearanceContextValue | undefined {
  return useContext(AppearanceContext);
}
