import { useEffect, useRef } from "react";

/**
 * 화면이 보이는 동안만 `refresh`를 일정 간격으로 부른다. 창·탭으로 돌아오면 바로 한 번 부른다.
 * 대화처럼 상대가 보낸 내용이 새로고침 없이 보여야 하는 곳에 쓴다(2026-09-28 사용자 피드백:
 * "카톡·DM은 바로바로 갱신되는데 우리는 직접 갱신해야 한다"). 숨긴 탭에서는 요청을 보내지 않아
 * 서버 부담을 늘리지 않는다. `refresh`가 끝나기 전에는 다음 호출을 겹쳐 보내지 않는다.
 */
export function useLivePolling(
  refresh: () => Promise<unknown>,
  intervalMs: number,
  enabled = true,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    const run = (): void => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      void refreshRef
        .current()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };
    const timer = window.setInterval(run, intervalMs);
    const onVisible = (): void => {
      if (document.visibilityState !== "hidden") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, intervalMs]);
}
