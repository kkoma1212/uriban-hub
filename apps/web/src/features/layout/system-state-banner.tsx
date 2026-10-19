import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; maintenance: boolean; announcement: string | null };

/** Request ordering is local to this mounted shell; no account data or persistent cache. */
export function SystemStateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    let generation = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      const current = ++generation;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), 5000);
      try {
        const response = await fetch("/api/v1/public/system-state", {
          credentials: "omit",
          cache: "no-store",
          signal: request.signal,
        });
        if (!response.ok) throw new Error("STATE_UNAVAILABLE");
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) throw new Error("INVALID_STATE");
        const value = data as Record<string, unknown>;
        if (
          typeof value.maintenance !== "boolean" ||
          (value.announcement !== null &&
            (typeof value.announcement !== "string" || [...value.announcement].length > 500))
        )
          throw new Error("INVALID_STATE");
        if (active && current === generation)
          setState({
            kind: "ready",
            maintenance: value.maintenance,
            announcement: value.announcement,
          });
      } catch {
        if (active && current === generation) setState({ kind: "error" });
      } finally {
        window.clearTimeout(timeout);
      }
    };
    let timer: number | undefined;
    const pause = () => {
      ++generation;
      controller?.abort();
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const resume = () => {
      pause();
      if (document.visibilityState === "hidden") return;
      if (!navigator.onLine) {
        setState({ kind: "error" });
        return;
      }
      void refresh();
      timer = window.setInterval(() => {
        void refresh();
      }, 15000);
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      active = false;
      pause();
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  if (state.kind === "ready" && !state.maintenance && state.announcement === null) return null;
  return (
    <section
      aria-label="서비스 안내"
      className="mb-4 min-w-0 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm leading-6 text-app-text"
      role={state.kind === "error" ? "alert" : "status"}
    >
      {state.kind === "loading" ? (
        <p>점검 상태를 확인하고 있어요.</p>
      ) : state.kind === "error" ? (
        <p>
          점검 상태를 확인하지 못했어요. 정상 이용 여부는 확인되지 않았습니다. 입력 내용을 보관하고
          잠시 뒤 다시 확인해 주세요.
        </p>
      ) : (
        <>
          {state.maintenance ? (
            <p className="font-bold">
              서비스 점검 중입니다. 교육 기록 조회와 로그인·복구는 이용할 수 있어요. 저장·변경은
              점검 뒤 다시 시도해 주세요.
            </p>
          ) : null}
          {state.announcement === null ? null : (
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {state.announcement}
            </p>
          )}
        </>
      )}
    </section>
  );
}
