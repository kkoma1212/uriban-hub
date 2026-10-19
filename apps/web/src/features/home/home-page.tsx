import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  getHome,
  logout,
  type BootstrapResponse,
  type HomeResponse,
} from "../../api/auth";
import { createHomeAuthorizationRecheckRouteState } from "../bootstrap/bootstrap-route-state";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import { StudentHomeDashboard } from "./student-home-dashboard";
import { TeacherHomeDashboard } from "./teacher-home-dashboard";
import { prefetchTabPages } from "../layout/prefetch-tab-pages";

function millisecondsUntilNextKstDay(): number {
  const now = Date.now();
  const shifted = new Date(now + 9 * 60 * 60 * 1_000);
  const nextUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return Math.max(1_000, nextUtc - 9 * 60 * 60 * 1_000 - now + 1_000);
}

function homeAuthorizationContextKey(bootstrap: BootstrapResponse): string {
  return JSON.stringify({
    allowed_actions: [...bootstrap.allowed_actions].sort(),
    class:
      bootstrap.current_class === null
        ? null
        : { id: bootstrap.current_class.id, status: bootstrap.current_class.status },
    membership:
      bootstrap.current_membership === null
        ? null
        : {
            class_id: bootstrap.current_membership.class_id,
            id: bootstrap.current_membership.id,
            role: bootstrap.current_membership.role,
            status: bootstrap.current_membership.status,
          },
  });
}

export function HomePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [home, setHome] = useState<HomeResponse>();
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const activeHomeContextKeyRef = useRef<string | undefined>(undefined);
  const homeRef = useRef<HomeResponse | undefined>(undefined);
  const homeLoadGenerationRef = useRef(0);
  const homeLoadInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const lifetimeGenerationRef = useRef(0);
  function clearPrivateHomeStateAndNavigate(
    destination: "/bootstrap" | "/login",
    state?: unknown,
  ): void {
    homeLoadGenerationRef.current += 1;
    homeLoadInFlightRef.current = undefined;
    activeHomeContextKeyRef.current = undefined;
    homeRef.current = undefined;
    setBootstrap(undefined);
    setHome(undefined);
    setLoadFailed(false);
    setLoading(false);
    void navigate(destination, {
      replace: true,
      ...(state === undefined ? {} : { state }),
    });
  }

  function activateHomeContext(contextKey: string): void {
    if (activeHomeContextKeyRef.current === contextKey) return;
    activeHomeContextKeyRef.current = contextKey;
    homeRef.current = undefined;
    setHome(undefined);
    setLoadFailed(false);
  }

  function handleAuthorizationFailure(requestError: unknown): boolean {
    if (!(requestError instanceof ApiRequestError)) return false;
    if (requestError.status === 401) {
      clearPrivateHomeStateAndNavigate("/login");
      return true;
    }
    if (requestError.status === 403) {
      clearPrivateHomeStateAndNavigate("/bootstrap", createHomeAuthorizationRecheckRouteState());
      return true;
    }
    return false;
  }

  async function performLoad(generation: number): Promise<void> {
    setLoading(true);
    setError(undefined);
    if (homeRef.current === undefined) setLoadFailed(false);
    try {
      const nextBootstrap = await getBootstrap();
      if (generation !== homeLoadGenerationRef.current) return;
      if (nextBootstrap.destination !== "HOME") {
        clearPrivateHomeStateAndNavigate("/bootstrap");
        return;
      }
      const contextKey = homeAuthorizationContextKey(nextBootstrap);
      activateHomeContext(contextKey);
      setBootstrap(nextBootstrap);
      const nextHome = await getHome();
      if (
        generation !== homeLoadGenerationRef.current ||
        activeHomeContextKeyRef.current !== contextKey
      ) {
        return;
      }
      setHome(nextHome);
      homeRef.current = nextHome;
      setLoadFailed(false);
    } catch (requestError) {
      if (generation !== homeLoadGenerationRef.current) return;
      if (handleAuthorizationFailure(requestError)) return;
      setLoadFailed(true);
    } finally {
      if (generation === homeLoadGenerationRef.current) setLoading(false);
    }
  }

  function load(): Promise<void> {
    const inFlight = homeLoadInFlightRef.current;
    if (inFlight !== undefined) return inFlight;

    const generation = ++homeLoadGenerationRef.current;
    const request = performLoad(generation).finally(() => {
      if (homeLoadInFlightRef.current === request) homeLoadInFlightRef.current = undefined;
    });
    homeLoadInFlightRef.current = request;
    return request;
  }

  useEffect(() => {
    lifetimeGenerationRef.current += 1;
    void load();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      lifetimeGenerationRef.current += 1;
      homeLoadGenerationRef.current += 1;
      homeLoadInFlightRef.current = undefined;
    };
  }, []);

  const prefetchRole = home === undefined ? undefined : bootstrap?.current_membership?.role;
  useEffect(() => {
    if (prefetchRole === undefined) return;
    return prefetchTabPages(prefetchRole);
  }, [prefetchRole]);

  useEffect(() => {
    if (home === undefined) return;
    const timer = window.setTimeout(() => void load(), millisecondsUntilNextKstDay());
    return () => window.clearTimeout(timer);
  }, [home?.server_today]);

  async function submitLogout(): Promise<void> {
    const lifetime = lifetimeGenerationRef.current;
    setLoggingOut(true);
    setError(undefined);
    try {
      await logout();
      if (lifetime !== lifetimeGenerationRef.current) return;
      void navigate("/login", { replace: true });
    } catch (requestError) {
      if (lifetime !== lifetimeGenerationRef.current) return;
      setError(requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.");
      setLoggingOut(false);
    }
  }

  if (bootstrap === undefined || home === undefined) {
    const navigationRole = bootstrap?.current_membership?.role;
    return (
      <AppShell centered width="wide" {...(navigationRole === undefined ? {} : { navigationRole })}>
        <div className="w-full">
          <PageHeader
            description="오늘의 소식·급식·준비물·일정을 한 화면에 모아 보여드려요."
            eyebrow="홈"
            title={loading ? "홈을 준비하고 있어요." : "홈을 열지 못했어요."}
          />
          {loading ? (
            <AsyncStatePanel kind="loading" title="홈을 준비하고 있어요." tone="neutral" />
          ) : (
            <AsyncStatePanel
              action={
                <button
                  className="ui-button ui-button-primary text-sm"
                  onClick={() => void load()}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={17} /> 다시 시도
                </button>
              }
              description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
              kind="error"
              title="홈을 불러오지 못했어요."
              tone="neutral"
            />
          )}
        </div>
      </AppShell>
    );
  }

  const isTeacher = bootstrap.current_membership?.role === "teacher";
  if (isTeacher) {
    return (
      <AppShell contentFrame navigationRole="teacher" width="wide">
        <TeacherHomeDashboard
          className={bootstrap.current_class?.name}
          error={error}
          home={home}
          loadFailed={loadFailed}
          loading={loading}
          loggingOut={loggingOut}
          onLogout={() => void submitLogout()}
          onReload={() => void load()}
        />
      </AppShell>
    );
  }

  return (
    <AppShell contentFrame navigationRole="student" width="wide">
      <StudentHomeDashboard
        className={bootstrap.current_class?.name}
        error={error}
        home={home}
        loadFailed={loadFailed}
        loading={loading}
        loggingOut={loggingOut}
        onLogout={() => void submitLogout()}
        onReload={() => void load()}
      />
    </AppShell>
  );
}
