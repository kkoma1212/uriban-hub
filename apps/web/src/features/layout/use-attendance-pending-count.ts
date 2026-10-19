import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import { getTodayAttendance, subscribeAttendanceChanges } from "../../api/attendance-notifications";
import { rememberBadgeCount, rememberedBadgeCount } from "./badge-count-cache";

const BADGE_KEY = "attendance-pending";

export function useAttendancePendingCount(enabled: boolean): number | undefined {
  const { pathname } = useLocation();
  const [pendingCount, setPendingCount] = useState<number | undefined>(
    () => rememberedBadgeCount(BADGE_KEY).value,
  );

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let generation = 0;
    const refresh = (): void => {
      const request = ++generation;
      void getTodayAttendance("all", "pending")
        .then(({ data }) => {
          if (active && request === generation) {
            const next = data.role === "teacher" ? data.counts.pending : undefined;
            rememberBadgeCount(BADGE_KEY, next);
            setPendingCount(next);
          }
        })
        .catch(() => {
          if (active && request === generation) setPendingCount(undefined);
        });
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== "hidden") refresh();
    };
    const remembered = rememberedBadgeCount(BADGE_KEY);
    setPendingCount(remembered.value);
    if (!remembered.fresh) refresh();
    const unsubscribe = subscribeAttendanceChanges(refresh);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, pathname]);

  return enabled ? pendingCount : undefined;
}
