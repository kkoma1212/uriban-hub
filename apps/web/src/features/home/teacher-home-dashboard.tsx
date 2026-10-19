import { LoaderCircle, LogOut, PenLine, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { type HomeResponse } from "../../api/auth";
import { listHelpRequests } from "../../api/help-requests";
import { formatKstCalendarDate } from "../../lib/kst-format";
import { AccessRedirectNoticeBanner } from "../layout/access-redirect-notice";
import { StaleDataAlert } from "../layout/async-state";
import { PastClassesEntry } from "../past-classes/past-classes-entry";
import { birthdayNames, Chalkboard, teacherChalkLines } from "./chalkboard";
import { HomeNewsFeed } from "./home-news-feed";
import { TodayInfoSection } from "./home-today-info";
import { HomeTopbar } from "./home-topbar";
import { NewsBellLink } from "./news-bell-link";
import { type HelpRequestState, TeacherTaskStrip, TeacherTasksPanel } from "./teacher-task-strip";
import "./teacher-home-dashboard.css";

interface TeacherHomeDashboardProps {
  className: string | undefined;
  error: string | undefined;
  home: HomeResponse;
  loadFailed: boolean;
  loading: boolean;
  loggingOut: boolean;
  onLogout: () => void;
  onReload: () => void;
}

function UtilityActions({
  loading,
  loggingOut,
  onLogout,
  onReload,
}: Pick<
  TeacherHomeDashboardProps,
  "loading" | "loggingOut" | "onLogout" | "onReload"
>): React.JSX.Element {
  return (
    <div aria-label="홈 도구" className="flex shrink-0 items-center gap-1.5" role="group">
      <NewsBellLink />
      <button
        aria-busy={loading}
        aria-label="홈 새로고침"
        className="ui-icon-button ui-button-secondary size-11 min-h-11 min-w-11"
        disabled={loading}
        onClick={onReload}
        type="button"
      >
        <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={17} />
      </button>
      <button
        aria-busy={loggingOut}
        aria-label="로그아웃"
        className="ui-icon-button ui-button-secondary size-11 min-h-11 min-w-11"
        disabled={loggingOut}
        onClick={onLogout}
        type="button"
      >
        {loggingOut ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
        ) : (
          <LogOut aria-hidden="true" size={17} />
        )}
      </button>
    </div>
  );
}

export function TeacherHomeDashboard({
  className,
  error,
  home,
  loadFailed,
  loading,
  loggingOut,
  onLogout,
  onReload,
}: TeacherHomeDashboardProps): React.JSX.Element {
  // 홈을 다시 불러올 때마다(home이 바뀔 때) 처리 중 도움 요청 수도 함께 새로 읽는다.
  const [helpResult, setHelpResult] = useState<{
    home: HomeResponse;
    className: string | undefined;
    state: HelpRequestState;
  }>();
  const helpRequestState: HelpRequestState =
    helpResult?.home === home && helpResult.className === className
      ? helpResult.state
      : { status: "loading" };
  useEffect(() => {
    let active = true;
    setHelpResult({ home, className, state: { status: "loading" } });
    listHelpRequests("open")
      .then((items) => {
        if (active)
          setHelpResult({ home, className, state: { status: "success", count: items.length } });
      })
      .catch(() => {
        if (active) setHelpResult({ home, className, state: { status: "error" } });
      });
    return () => {
      active = false;
    };
  }, [home, className]);

  return (
    <div className="pb-2" data-teacher-home>
      {/* 상단 메뉴와 칠판 아래 소식·처리할 일·오늘 정보를 배치한다. */}
      <header data-teacher-home-header="true">
        <HomeTopbar className={className} role="teacher">
          <UtilityActions
            loading={loading}
            loggingOut={loggingOut}
            onLogout={onLogout}
            onReload={onReload}
          />
        </HomeTopbar>
        {loadFailed ? (
          <StaleDataAlert
            busy={loading}
            description="이전에 불러온 홈 카드를 계속 표시하고 있어 최신 정보와 다를 수 있어요."
            onRetry={onReload}
            title="최신 홈 정보를 확인하지 못했어요."
          />
        ) : null}

        <div className="mt-3">
          <Chalkboard
            compactEmpty={
              !loading &&
              !loadFailed &&
              home.notices.status !== "error" &&
              home.supplies.status !== "error" &&
              home.birthdays?.status !== "error"
            }
            birthdays={birthdayNames(home)}
            dateLabel={formatKstCalendarDate(home.server_today)}
            dateTime={home.server_today}
            emptyText={
              home.notices.status === "error" || home.supplies.status === "error"
                ? "칠판 안내를 모두 확인하지 못했어요. 아래 소식에서 다시 확인해 주세요."
                : "칠판이 비어 있어요. 반에 알릴 것을 적어 보세요"
            }
            footer={
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <span className="min-w-0 break-keep text-right [overflow-wrap:anywhere]">
                  학생 칠판에는 각자 아직 안 본 것만 보여요
                </span>
                <Link
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--color-chalk-text)] px-3 text-sm font-bold text-[var(--color-chalk-board)] transition-opacity hover:opacity-90"
                  data-chalkboard-write
                  to="/updates?create=notice"
                >
                  <PenLine aria-hidden="true" size={15} />
                  칠판에 쓰기
                </Link>
              </span>
            }
            lines={teacherChalkLines(home)}
          />
        </div>
        <TeacherTaskStrip helpRequestCount={0} helpRequestState={helpRequestState} home={home} />
      </header>

      <div>
        <AccessRedirectNoticeBanner />

        {error === undefined ? null : (
          <p
            className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}

        {loading ? (
          <p aria-live="polite" className="sr-only" role="status">
            홈을 새로고침하는 중입니다.
          </p>
        ) : null}

        <div
          className="mt-4 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.8fr)]"
          data-teacher-home-grid
        >
          {/* 2026-09-27 시안대로(사용자 A안): 가운데는 우리반 소식만, 옛 '지금 먼저 볼 일·다음 할 일·
              한눈에 보기·도움 요청 카드'는 걷어냈다. 처리할 일은 칠판 아래 띠(좁은 화면)와 오른쪽 칸(xl). */}
          <HomeNewsFeed home={home} role="teacher" />
          <div className="flex min-w-0 flex-col gap-4">
            <TeacherTasksPanel
              helpRequestCount={0}
              helpRequestState={helpRequestState}
              home={home}
            />
            <TodayInfoSection home={home} role="teacher" />
          </div>
        </div>
        <PastClassesEntry />
      </div>
    </div>
  );
}
