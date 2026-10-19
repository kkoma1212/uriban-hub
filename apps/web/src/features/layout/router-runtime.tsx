import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigation, useRouteError } from "react-router";

import { reportClientError } from "../../lib/client-error-reporter";
import { APP_MAIN_ID } from "./app-shell";
import { routeDocumentTitle } from "./app-route-metadata";
import { PwaStatusBanner } from "./pwa-status-banner";
import { SessionPrivacyBoundary } from "./session-privacy-boundary";

export { routeDocumentTitle } from "./app-route-metadata";

const ROUTE_RETRY_PREFIX = "classhub:route-retry:";
const fallbackRetryPaths = new Set<string>();

type RetryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function routeRetryStorageKey(pathname: string): string {
  return `${ROUTE_RETRY_PREFIX}${pathname}`;
}

export function hasRouteRetryMarker(
  pathname: string,
  storage: RetryStorage = window.sessionStorage,
): boolean {
  try {
    return storage.getItem(routeRetryStorageKey(pathname)) === "1";
  } catch {
    return fallbackRetryPaths.has(pathname);
  }
}

export function beginRouteRetry(
  pathname: string,
  storage: RetryStorage = window.sessionStorage,
): boolean {
  if (hasRouteRetryMarker(pathname, storage)) return false;

  fallbackRetryPaths.add(pathname);
  try {
    storage.setItem(routeRetryStorageKey(pathname), "1");
  } catch {
    // The in-memory guard still prevents repeated reloads during this page lifetime.
  }
  return true;
}

export function clearRouteRetryMarker(
  pathname: string,
  storage: RetryStorage = window.sessionStorage,
): void {
  fallbackRetryPaths.delete(pathname);
  try {
    storage.removeItem(routeRetryStorageKey(pathname));
  } catch {
    // A blocked storage API does not prevent the successfully loaded route from rendering.
  }
}

export function RouteRuntime(): React.JSX.Element {
  const location = useLocation();
  const navigation = useNavigation();
  const focusedPathnameRef = useRef(location.pathname);

  useEffect(() => {
    clearRouteRetryMarker(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    if (focusedPathnameRef.current === location.pathname) return;
    focusedPathnameRef.current = location.pathname;
    // Child effects have already run, so a page that manages its own focus
    // (error headings, restored list links) keeps it. Only reclaim focus that
    // fell back to <body> when the previous screen unmounted, so keyboard and
    // screen-reader users land on the new main content instead of nowhere.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.getElementById(APP_MAIN_ID)?.focus({ preventScroll: true });
  }, [location.pathname]);

  useEffect(() => {
    const previousTitle = document.title;
    const nextTitle = routeDocumentTitle(location.pathname);
    document.title = nextTitle;
    return () => {
      if (document.title === nextTitle) document.title = previousTitle;
    };
  }, [location.pathname]);

  return (
    <>
      <SessionPrivacyBoundary pathname={location.pathname} />
      <div
        aria-atomic="false"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <PwaStatusBanner />
        {navigation.state !== "idle" ? (
          <p
            className="rounded-full bg-slate-950 px-4 py-3 text-sm font-bold text-white shadow-lg"
            role="status"
          >
            다음 화면을 불러오고 있어요.
          </p>
        ) : null}
      </div>
      <Outlet />
    </>
  );
}

export function RouteHydrationFallback(): React.JSX.Element {
  return (
    <main className="grid min-h-dvh place-items-center bg-app-canvas px-5 text-center text-app-text">
      <div>
        <p className="text-sm font-extrabold tracking-[0.16em] text-role-primary">우리반 허브</p>
        <p aria-live="polite" className="mt-3 text-base font-bold" role="status">
          화면을 불러오고 있어요.
        </p>
      </div>
    </main>
  );
}

export function RouteErrorBoundary(): React.JSX.Element {
  const routeError = useRouteError();
  const location = useLocation();
  useEffect(() => {
    reportClientError(routeError, "render");
  }, [routeError]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [retryAvailable, setRetryAvailable] = useState(
    () => !hasRouteRetryMarker(location.pathname),
  );

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const handleRetry = (): void => {
    if (!beginRouteRetry(location.pathname)) {
      setRetryAvailable(false);
      return;
    }
    window.location.reload();
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-app-canvas px-5 py-10 text-app-text">
      <section className="w-full max-w-lg rounded-[1.75rem] border border-app-border bg-app-surface-raised p-6 shadow-card sm:p-8">
        <p className="text-sm font-extrabold text-home-important">화면 오류</p>
        <h1
          className="mt-2 text-2xl font-black tracking-tight text-app-text"
          ref={headingRef}
          tabIndex={-1}
        >
          화면을 불러오지 못했어요.
        </h1>
        <p className="mt-3 leading-7 text-app-muted">
          인터넷 연결을 확인한 뒤 다시 시도해 주세요. 현재 화면의 임시 입력 내용은 보존되지 않았을
          수 있어요.
        </p>
        {!retryAvailable ? (
          <p className="mt-3 rounded-xl bg-warning-surface px-3 py-2 text-sm font-semibold leading-6 text-warning-text">
            한 번 다시 불러왔지만 같은 문제가 계속됐어요. 오늘이나 로그인 화면으로 이동해 주세요.
          </p>
        ) : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            className="ui-button ui-button-primary w-full"
            disabled={!retryAvailable}
            onClick={handleRetry}
            type="button"
          >
            다시 불러오기
          </button>
          <a className="ui-button ui-button-secondary w-full" href="/home">
            홈으로 이동
          </a>
          <a className="ui-button ui-button-tertiary w-full sm:col-span-2" href="/login">
            로그인 화면으로 이동
          </a>
        </div>
      </section>
    </main>
  );
}
