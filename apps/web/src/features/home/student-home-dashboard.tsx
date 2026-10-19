import { LoaderCircle, LogOut, RefreshCw } from "lucide-react";

import type { HomeResponse } from "../../api/auth";
import { formatKstCalendarDate } from "../../lib/kst-format";
import { AccessRedirectNoticeBanner } from "../layout/access-redirect-notice";
import { StaleDataAlert } from "../layout/async-state";
import { AskTeacherEntry } from "../help-requests/ask-teacher-entry";
import { PastClassesEntry } from "../past-classes/past-classes-entry";
import { birthdayNames, Chalkboard, studentChalkLines } from "./chalkboard";
import { HomeNewsFeed } from "./home-news-feed";
import { TodayInfoSection } from "./home-today-info";
import { HomeTopbar } from "./home-topbar";
import { NewsBellLink } from "./news-bell-link";
import {
  StudentHomeQuickActions,
  studentHomeQuickActionTargets,
} from "./student-home-quick-actions";
import "./teacher-home-dashboard.css";

/*
 * 2026-10-02 사용자 결정: 학생 홈도 교사 홈과 같은 틀 — 칠판 → 우리반 소식(한 판) → 오늘 정보(한 판).
 * PC(xl)는 왼쪽 소식, 오른쪽 오늘 정보. 9/27 시안의 '칠판 → 급식·일정 두 칸' 순서를 대신한다.
 * 역할에 따라 다른 것(확인 상태, 안 본 것 개수)만 남긴다.
 */
function StudentHomeContent({ home }: { home: HomeResponse }): React.JSX.Element {
  return (
    <>
      <StudentHomeQuickActions home={home} />
      <div
        className="mt-4 grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.8fr)]"
        data-student-home-grid
      >
        <HomeNewsFeed home={home} role="student" />
        <div className="flex min-w-0 flex-col gap-4">
          <TodayInfoSection
            home={home}
            role="student"
            studentQuickActions={studentHomeQuickActionTargets(home)}
          />
        </div>
      </div>
      <PastClassesEntry />
    </>
  );
}

export interface StudentHomeDashboardProps {
  className?: string | undefined;
  error?: string | undefined;
  home: HomeResponse;
  loadFailed: boolean;
  loading: boolean;
  loggingOut: boolean;
  onLogout: () => void;
  onReload: () => void;
}

export function StudentHomeDashboard({
  className,
  error,
  home,
  loadFailed,
  loading,
  loggingOut,
  onLogout,
  onReload,
}: StudentHomeDashboardProps): React.JSX.Element {
  return (
    <div data-student-home>
      {/* 상단 메뉴 아래 칠판, 오늘 정보, 소식 순서로 배치한다. */}
      <header data-home-hero-role="student">
        <div>
          <HomeTopbar className={className} role="student">
            <div className="flex shrink-0 items-center gap-1.5">
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
          </HomeTopbar>

          {loadFailed ? (
            <StaleDataAlert
              busy={loading}
              description="이전에 불러온 홈 카드를 계속 표시하고 있어 최신 정보와 다를 수 있어요."
              onRetry={onReload}
              title="최신 홈 정보를 확인하지 못했어요."
            />
          ) : null}

          <div className="mt-3 lg:hidden" data-home-question-entry>
            <AskTeacherEntry compact />
          </div>

          {/* 날짜는 칠판 윗줄에 둔다(시안). */}
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
                  : "칠판에 올릴 중요한 안내는 없어요"
              }
              footer={
                // 교사 칠판의 '칠판에 쓰기'(44px) 줄과 같은 높이로 두어 두 홈의 칠판 높이를 맞춘다.
                <span className="flex min-h-11 items-center">선생님 안내에서 골랐어요</span>
              }
              lines={studentChalkLines(home)}
            />
          </div>
        </div>
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

        <StudentHomeContent home={home} />
      </div>
    </div>
  );
}
