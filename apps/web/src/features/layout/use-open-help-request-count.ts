import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import { listHelpRequests, subscribeHelpRequestChanges } from "../../api/help-requests";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { forgetBadgeCount, rememberBadgeCount, rememberedBadgeCount } from "./badge-count-cache";

const BADGE_KEY = "help-requests-open";

export function useOpenHelpRequestCount(enabled: boolean): number | undefined {
  const { pathname } = useLocation();
  const [count, setCount] = useState<number | undefined>(
    () => rememberedBadgeCount(BADGE_KEY).value,
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let generation = 0;
    const clear = (): void => {
      generation++;
      forgetBadgeCount(BADGE_KEY);
      setCount(undefined);
    };
    const refresh = (): void => {
      const request = ++generation;
      void listHelpRequests("open")
        .then((items) => {
          if (active && request === generation) {
            rememberBadgeCount(BADGE_KEY, items.length);
            setCount(items.length);
          }
        })
        .catch(() => {
          if (active && request === generation) setCount(undefined);
        });
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== "hidden") refresh();
    };
    const remembered = rememberedBadgeCount(BADGE_KEY);
    setCount(remembered.value);
    if (!remembered.fresh) refresh();
    const unsubscribe = subscribeHelpRequestChanges(refresh);
    // 새 도움 요청이 오면 메뉴 숫자가 새로고침 없이 바뀌게(20초, 화면이 보일 때만)
    const timer = window.setInterval(refreshWhenVisible, 20_000);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clear);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, clear);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, pathname]);
  return enabled ? count : undefined;
}
