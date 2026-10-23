import {
  ArrowLeft,
  Backpack,
  CalendarRange,
  ClipboardCheck,
  Ellipsis,
  LayoutDashboard,
  Megaphone,
  MessageCircleMore,
  MessagesSquare,
  NotebookPen,
  Settings,
  Settings2,
  Soup,
  UsersRound,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { Fragment, createContext, useContext, useRef } from "react";
import { Link, useLocation } from "react-router";

import { useNavigationCapabilities } from "../../lib/navigation-capabilities";
import { RequestCooldownNotice } from "../auth/request-cooldown";
import { SystemStateBanner } from "./system-state-banner";
import { AppBreadcrumb, AppFooter } from "./app-chrome";
import { routeMetadataForPath } from "./app-route-metadata";
import { BrandSymbol } from "./brand-symbol";
import { RailMoreHint, useRailHasMoreBelow } from "./rail-more-hint";
import { useAttendancePendingCount } from "./use-attendance-pending-count";
import { useOpenHelpRequestCount } from "./use-open-help-request-count";

type AppShellWidth = "narrow" | "medium" | "wide";
type WordmarkTone = "dark" | "light";
export type AppNavigationRole = "student" | "teacher";

const AppShellNavigationRoleContext = createContext<AppNavigationRole | undefined>(undefined);

export const APP_MAIN_ID = "app-main-content";

const widthClasses: Record<AppShellWidth, string> = {
  narrow: "max-w-2xl",
  medium: "max-w-3xl",
  wide: "max-w-[70rem]",
};

interface AppShellProps {
  children: React.ReactNode;
  centered?: boolean;
  contentFrame?: boolean;
  alignedFrame?: boolean;
  hideMobileNavigation?: boolean;
  navigationRole?: AppNavigationRole;
  studentAssessmentsEnabled?: boolean;
  attendanceNotificationsEnabled?: boolean;
  showRequestCooldownNotice?: boolean;
  width?: AppShellWidth;
}

export function AppShell({
  centered = false,
  children,
  contentFrame = false,
  alignedFrame = false,
  hideMobileNavigation = false,
  navigationRole,
  studentAssessmentsEnabled,
  attendanceNotificationsEnabled,
  showRequestCooldownNotice = true,
  width = "medium",
}: AppShellProps): React.JSX.Element {
  const { pathname } = useLocation();
  const navigationCapabilities = useNavigationCapabilities();
  const assessmentsEnabled =
    studentAssessmentsEnabled ?? navigationCapabilities.studentAssessmentsEnabled;
  const attendanceEnabled =
    attendanceNotificationsEnabled ?? navigationCapabilities.attendanceNotificationsEnabled;
  const attendancePendingCount = useAttendancePendingCount(
    navigationRole === "teacher" && attendanceEnabled,
  );
  // 학생이 교사 주소로 들어와도 역할 확인 전에는 교사용 숫자를 묻지 않는다.
  const helpRequestCount = useOpenHelpRequestCount(
    navigationRole === "teacher" && navigationCapabilities.confirmedTeacher,
  );
  const appRole = navigationRole ?? "public";
  const responsiveNavigation = navigationRole !== undefined;
  const main = (
    <main
      /*
       * 본문 좌우 여백은 화면마다 다르지 않다. 예전에는 홈만 `mobileFlush`로 여백을 0으로
       * 두어, 좁은 화면에서 홈 카드만 화면 끝에 붙고 상단 바·하단 탭과 좌우선이 어긋났다.
       * 끝까지 나가야 하는 머리띠는 제 자리에서 `-mx-5`로 나간다(Round 5 §3).
       */
      className={`app-main-content min-h-dvh bg-app-canvas text-app-text ${
        // 아래 탭 막대 자리는 막대가 보일 때만 비운다(숨긴 대화 화면에서 입력창이 96px 떠 있었다, 2026-09-30).
        responsiveNavigation && !hideMobileNavigation
          ? "pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-8"
          : "pb-8"
      } ${responsiveNavigation ? "lg:col-start-2 lg:row-start-1" : ""} flex flex-col`}
      data-app-role={appRole}
      data-content-frame={contentFrame ? "true" : undefined}
      data-aligned-frame={alignedFrame ? "true" : undefined}
      data-app-shell="true"
      data-app-shell-layout={responsiveNavigation ? `${navigationRole}-main` : "standalone"}
      id={APP_MAIN_ID}
      tabIndex={-1}
    >
      <AppShellNavigationRoleContext.Provider value={navigationRole}>
        {/* 사이드바가 있는 앱 안 화면은 좁은 화면도 바깥 틀을 넓은 탭과 같은 폭·시작선에 두고 내용만 좁힌다 —
            좁은 틀째 가운데 놓으면 제목·카드가 다른 탭의 시작선과 어긋났다(2026-10-04 화면 검수). */}
        <div
          className={`mx-auto flex min-w-0 w-full flex-1 flex-col ${
            responsiveNavigation ? widthClasses.wide : widthClasses[width]
          }`}
          data-app-shell-width={width}
        >
          <SystemStateBanner key={`${appRole}:${pathname}`} />
          {centered ? (
            <div className="grid flex-1 place-items-center">
              <div className="min-w-0 w-full">
                {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
                {children}
              </div>
            </div>
          ) : responsiveNavigation && width !== "wide" ? (
            <div className={`flex min-w-0 w-full flex-1 flex-col ${widthClasses[width]}`}>
              {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
              {children}
            </div>
          ) : (
            <>
              {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
              {children}
            </>
          )}
          {/* 휴대폰 정렬 틀에서는 본문 끝(ContentFrameBody)의 같은 정보줄이 대신 보인다 — content-frame.css */}
          <div className="app-shell-footer">
            <AppFooter />
          </div>
        </div>
      </AppShellNavigationRoleContext.Provider>
    </main>
  );

  return (
    <>
      <a
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[110] focus:not-sr-only focus:rounded-xl focus:bg-app-surface focus:px-4 focus:py-3 focus:text-sm focus:font-extrabold focus:text-app-text focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-primary"
        href={`#${APP_MAIN_ID}`}
      >
        본문으로 건너뛰기
      </a>
      {navigationRole ? (
        <>
          <div
            className="min-h-dvh bg-app-canvas lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[14.5rem_minmax(0,1fr)]"
            data-app-role={navigationRole}
            data-app-shell-layout={`${navigationRole}-responsive`}
          >
            <DesktopNavigationColumn
              role={navigationRole}
              studentAssessmentsEnabled={assessmentsEnabled}
              attendanceNotificationsEnabled={attendanceEnabled}
              classChatEnabled={navigationCapabilities.classChatEnabled}
              attendancePendingCount={attendancePendingCount}
              helpRequestCount={helpRequestCount}
            />
            {main}
          </div>
          {hideMobileNavigation ? null : (
            <PrimaryNavigation
              layout="bottom"
              role={navigationRole}
              studentAssessmentsEnabled={assessmentsEnabled}
              attendanceNotificationsEnabled={attendanceEnabled}
              classChatEnabled={navigationCapabilities.classChatEnabled}
              attendancePendingCount={attendancePendingCount}
              helpRequestCount={helpRequestCount}
              width={width}
            />
          )}
        </>
      ) : (
        main
      )}
    </>
  );
}

interface PrimaryNavigationItem {
  activePrefixes: readonly string[];
  icon: LucideIcon;
  label: string;
  to: string;
}

type PrimaryNavigationLayout = "bottom" | "desktop" | "responsive";

// 2026-09-27 확정 시안: 첫 탭 이름은 '홈'.
const teacherHomeNavigationItem = {
  activePrefixes: ["/home"],
  icon: LayoutDashboard,
  label: "홈",
  to: "/home",
} satisfies PrimaryNavigationItem;

// PC에서는 준비물·숙제 메뉴가 독립되어 소식과 동시에 선택되지 않게 한다.
const studentSuppliesNavigationItem = {
  activePrefixes: ["/supplies"],
  icon: Backpack,
  label: "준비물·숙제",
  to: "/supplies",
} satisfies PrimaryNavigationItem;

const studentHomeNavigationItem = {
  activePrefixes: ["/home"],
  icon: LayoutDashboard,
  label: "홈",
  to: "/home",
} satisfies PrimaryNavigationItem;

const teacherUpdatesNavigationItem = {
  activePrefixes: ["/notices", "/supplies", "/updates"],
  icon: Megaphone,
  label: "소식",
  to: "/updates",
} satisfies PrimaryNavigationItem;

const studentUpdatesNavigationItem = {
  activePrefixes: ["/notices", "/supplies", "/updates"],
  icon: Megaphone,
  label: "소식",
  to: "/updates",
} satisfies PrimaryNavigationItem;

const teacherHelpNavigationItem = {
  activePrefixes: ["/help-requests"],
  icon: MessagesSquare,
  label: "도움 요청",
  to: "/help-requests",
} satisfies PrimaryNavigationItem;

const studentQuestionNavigationItem = {
  activePrefixes: ["/help-requests"],
  icon: MessagesSquare,
  label: "선생님께 물어보기",
  to: "/help-requests/ask",
} satisfies PrimaryNavigationItem;

/** PC 왼쪽 메뉴 전용 — 휴대폰은 더보기 타일로 들어간다(2026-10-01 사용자 요청: PC에서 찾을 길이 없었다). */
const classChatNavigationItem = {
  activePrefixes: ["/class-chat"],
  // 도움 요청과 같은 아이콘이면 나란히 놓여 구별이 안 된다.
  icon: MessageCircleMore,
  label: "반 대화",
  to: "/class-chat",
} satisfies PrimaryNavigationItem;

/** 투표와 대표 선거를 반 활동에서 찾아간다. */
const decisionsNavigationItem = {
  activePrefixes: ["/activities", "/elections", "/polls"],
  icon: Vote,
  label: "반 활동",
  to: "/activities",
} satisfies PrimaryNavigationItem;

const teacherScheduleNavigationItem = {
  activePrefixes: ["/schedules"],
  icon: CalendarRange,
  label: "일정",
  to: "/schedules",
} satisfies PrimaryNavigationItem;

const studentDesktopUpdatesNavigationItem = {
  ...studentUpdatesNavigationItem,
  activePrefixes: ["/notices", "/updates"],
} satisfies PrimaryNavigationItem;

const studentAttendanceNavigationItem = {
  activePrefixes: ["/attendance"],
  icon: ClipboardCheck,
  label: "출결 연락",
  to: "/attendance",
} satisfies PrimaryNavigationItem;

const teacherAttendanceNavigationItem = studentAttendanceNavigationItem;
const teacherMobileAttendanceNavigationItem = {
  ...teacherAttendanceNavigationItem,
  label: "출결",
} satisfies PrimaryNavigationItem;

const studentCalendarNavigationItem = {
  activePrefixes: ["/schedules"],
  icon: CalendarRange,
  label: "일정",
  to: "/schedules",
} satisfies PrimaryNavigationItem;

const studentAssessmentsNavigationItem = {
  activePrefixes: ["/assessments"],
  icon: NotebookPen,
  label: "평가 기록",
  to: "/assessments",
} satisfies PrimaryNavigationItem;

const mealsNavigationItem = {
  activePrefixes: ["/meals"],
  icon: Soup,
  label: "급식",
  to: "/meals",
} satisfies PrimaryNavigationItem;

const teacherStudentNavigationItem = {
  activePrefixes: ["/members/manage"],
  icon: UsersRound,
  label: "학생",
  to: "/members/manage?tab=approved",
} satisfies PrimaryNavigationItem;

const teacherManagementNavigationItem = {
  activePrefixes: ["/class/manage", "/class/archive"],
  icon: Settings2,
  label: "반 관리",
  to: "/class/manage",
} satisfies PrimaryNavigationItem;

const accountNavigationItem = {
  activePrefixes: ["/account", "/settings"],
  icon: Settings,
  label: "내 계정",
  to: "/account/profile",
} satisfies PrimaryNavigationItem;

const teacherMobileStudentNavigationItem = {
  ...teacherStudentNavigationItem,
  label: "학생",
} satisfies PrimaryNavigationItem;

const teacherMoreNavigationItem = {
  activePrefixes: [
    "/account",
    "/class/archive",
    "/class/manage",
    "/meals",
    "/more",
    "/past-classes",
    "/schedules",
    "/settings",
  ],
  icon: Ellipsis,
  label: "더보기",
  to: "/more",
} satisfies PrimaryNavigationItem;

const studentMoreNavigationItem = {
  activePrefixes: ["/account", "/meals", "/more", "/past-classes", "/schedules", "/settings"],
  icon: Ellipsis,
  label: "더보기",
  to: "/more",
} satisfies PrimaryNavigationItem;

function DesktopNavigationColumn({
  role,
  studentAssessmentsEnabled,
  attendanceNotificationsEnabled,
  classChatEnabled,
  attendancePendingCount,
  helpRequestCount,
}: {
  role: AppNavigationRole;
  studentAssessmentsEnabled: boolean;
  attendanceNotificationsEnabled: boolean;
  classChatEnabled: boolean;
  attendancePendingCount: number | undefined;
  helpRequestCount: number | undefined;
}): React.JSX.Element {
  const { pathname } = useLocation();
  const accountActive = accountNavigationItem.activePrefixes.some((prefix) =>
    pathMatches(pathname, prefix),
  );
  const accountRoleLabel = role === "teacher" ? "선생님" : "학생";
  const AccountIcon = accountNavigationItem.icon;
  // 두 역할 모두 설정을 먼저 열고, 이름 변경은 설정 안에서 선택한다.
  const accountDestination = "/settings";

  return (
    <aside
      className="app-desktop-rail hidden lg:sticky lg:top-0 lg:z-20 lg:col-start-1 lg:row-start-1 lg:flex lg:h-dvh lg:flex-col lg:self-start"
      data-app-role={role}
    >
      <PrimaryNavigation
        layout="desktop"
        role={role}
        studentAssessmentsEnabled={studentAssessmentsEnabled}
        attendanceNotificationsEnabled={attendanceNotificationsEnabled}
        classChatEnabled={classChatEnabled}
        attendancePendingCount={attendancePendingCount}
        helpRequestCount={helpRequestCount}
      />
      <nav aria-label={`${accountRoleLabel} 계정`} className="app-rail-account lg:mt-auto">
        <Link
          aria-current={accountActive ? "page" : undefined}
          className={`app-rail-account-link flex min-h-11 min-w-0 items-center gap-3 px-3 py-2.5 text-sm font-extrabold transition focus-visible:outline-none ${
            accountActive ? "is-active" : ""
          }`}
          to={accountDestination}
        >
          <span className="min-w-0 flex-1">
            <span className="block">{accountNavigationItem.label}</span>
            <span className="block text-xs font-semibold">{accountRoleLabel}</span>
          </span>
          <AccountIcon aria-hidden="true" className="shrink-0" size={19} />
        </Link>
      </nav>
    </aside>
  );
}

function pathMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function PrimaryNavigation({
  layout,
  role,
  studentAssessmentsEnabled,
  attendanceNotificationsEnabled,
  classChatEnabled = false,
  attendancePendingCount,
  helpRequestCount,
  width = "medium",
}: {
  layout: PrimaryNavigationLayout;
  role: AppNavigationRole;
  studentAssessmentsEnabled: boolean;
  attendanceNotificationsEnabled: boolean;
  classChatEnabled?: boolean;
  attendancePendingCount: number | undefined;
  helpRequestCount: number | undefined;
  width?: AppShellWidth;
}): React.JSX.Element {
  const { pathname } = useLocation();
  // 투표·선거가 둘 다 꺼진 반은 '반 활동'을 감춘다(총검수 A3-03).
  const activitiesEnabled = useNavigationCapabilities().activitiesEnabled;
  const desktop = layout === "desktop";
  const responsive = layout === "responsive";
  const responsiveLayout = `${role}-${layout}`;
  const navigationRef = useRef<HTMLElement>(null);
  // 교사 메뉴에 먼저 붙이고 2026-10-22 사용자 결정으로 학생 메뉴에도 맞췄다(T-UI-PARITY).
  const railHasMoreBelow = useRailHasMoreBelow(navigationRef, desktop);
  const navigationItems = desktop
    ? role === "teacher"
      ? [
          teacherHomeNavigationItem,
          teacherUpdatesNavigationItem,
          ...(attendanceNotificationsEnabled ? [teacherAttendanceNavigationItem] : []),
          teacherStudentNavigationItem,
          teacherHelpNavigationItem,
          teacherScheduleNavigationItem,
          ...(activitiesEnabled ? [decisionsNavigationItem] : []),
          ...(classChatEnabled ? [classChatNavigationItem] : []),
          mealsNavigationItem,
          teacherManagementNavigationItem,
        ]
      : [
          studentHomeNavigationItem,
          studentDesktopUpdatesNavigationItem,
          studentQuestionNavigationItem,
          ...(classChatEnabled ? [classChatNavigationItem] : []),
          ...(activitiesEnabled ? [decisionsNavigationItem] : []),
          studentCalendarNavigationItem,
          ...(attendanceNotificationsEnabled ? [studentAttendanceNavigationItem] : []),
          ...(studentAssessmentsEnabled ? [studentAssessmentsNavigationItem] : []),
          studentSuppliesNavigationItem,
          mealsNavigationItem,
        ]
    : role === "teacher"
      ? [
          teacherHomeNavigationItem,
          teacherUpdatesNavigationItem,
          attendanceNotificationsEnabled
            ? teacherMobileAttendanceNavigationItem
            : activitiesEnabled
              ? decisionsNavigationItem
              : teacherScheduleNavigationItem,
          teacherMobileStudentNavigationItem,
          {
            ...teacherMoreNavigationItem,
            activePrefixes: [
              // 셋째 칸이 일정이면 일정 화면에서 더보기까지 함께 현재 칸이 되지 않게 뺀다(학생 쪽과 같은 규칙).
              ...teacherMoreNavigationItem.activePrefixes.filter(
                (prefix) =>
                  prefix !== "/schedules" || attendanceNotificationsEnabled || activitiesEnabled,
              ),
              "/help-requests",
              ...(classChatEnabled ? classChatNavigationItem.activePrefixes : []),
              ...(attendanceNotificationsEnabled ? decisionsNavigationItem.activePrefixes : []),
            ],
          },
        ]
      : /*
         * 2026-09-27 확정 시안: 학생 탭은 홈·소식·일정·출결·더보기. 출결이 꺼진 반은 넷째 칸에
         * 반 활동을 두어 빠지는 기능이 없게 하고, 반 활동·평가 기록은 더보기에서도 찾는다.
         */
        [
          studentHomeNavigationItem,
          studentUpdatesNavigationItem,
          studentCalendarNavigationItem,
          attendanceNotificationsEnabled
            ? { ...studentAttendanceNavigationItem, label: "출결" }
            : activitiesEnabled
              ? decisionsNavigationItem
              : mealsNavigationItem,
          {
            ...studentMoreNavigationItem,
            activePrefixes: [
              // 넷째 칸이 급식이면(출결·반 활동 꺼짐) 급식 화면에서 더보기까지 현재 칸이 되지 않게 뺀다.
              ...studentMoreNavigationItem.activePrefixes.filter(
                (prefix) =>
                  prefix !== "/schedules" &&
                  (prefix !== "/meals" || attendanceNotificationsEnabled || activitiesEnabled),
              ),
              "/assessments",
              "/help-requests",
              ...(classChatEnabled ? classChatNavigationItem.activePrefixes : []),
              ...(attendanceNotificationsEnabled ? decisionsNavigationItem.activePrefixes : []),
            ],
          },
        ];
  /*
   * 좁은 화면은 핵심 4개 + 더보기 5칸이다. 교사 출결이 켜지면 반 활동을
   * 더보기로 옮기고, desktop은 알림 다음에 출결을 독립 메뉴로 표시한다.
   */
  const mobileGridColumns = "grid-cols-5";

  return (
    <nav
      aria-label="주요 메뉴"
      className={
        desktop
          ? "app-desktop-navigation min-h-0 flex-1 overflow-y-auto overscroll-contain"
          : responsive
            ? "fixed inset-x-0 bottom-0 z-40 border-t border-app-border bg-app-surface pb-[env(safe-area-inset-bottom)] shadow-lg shadow-slate-900/10 backdrop-blur-xl lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-8 lg:z-20 lg:col-start-1 lg:row-start-1 lg:self-start lg:rounded-card lg:border lg:p-3 lg:pb-0 lg:shadow-card lg:backdrop-blur-none"
            : /*
               * 하단 탭 띠도 본문과 같은 좌우선 위에 세운다(Round 5 §3). 예전에는 화면
               * 끝에서 끝까지 붙어 있어서, 본문 카드의 바깥선과 탭 띠의 바깥선이 20px
               * 어긋난 채로 한 화면에 같이 보였다. 좌우를 본문과 같은 여백만큼 띄우고
               * 폭 상한도 본문과 같은 값을 쓴다.
               *
               * 다섯 메뉴의 안쪽 가로 padding·gap은 두지 않는다. 320px에서도 좌우
               * 20px를 뺀 각 칸이 56px이므로 44px 조작 표면을 유지한다.
               */
              `app-bottom-navigation fixed inset-x-5 bottom-0 z-40 mx-auto ${widthClasses[width]} rounded-t-card border-x border-t border-app-border bg-app-surface pb-[env(safe-area-inset-bottom)] shadow-lg shadow-slate-900/10 sm:inset-x-8 lg:hidden`
      }
      data-app-role={role}
      data-app-shell-layout={`${responsiveLayout}-navigation`}
      data-primary-navigation-layout={responsiveLayout}
      ref={navigationRef}
    >
      {desktop || responsive ? (
        <div
          className={`app-rail-header mb-2 border-b border-app-border px-2 pb-3 pt-1${
            responsive ? " hidden lg:block" : ""
          }`}
        >
          <ProductWordmark
            className="app-rail-wordmark px-1"
            context={role === "teacher" ? "선생님" : "학생"}
            tone={desktop ? "dark" : "light"}
          />
        </div>
      ) : null}
      <div
        className={
          desktop
            ? "grid grid-cols-1 gap-1"
            : responsive
              ? `mx-auto grid max-w-3xl ${mobileGridColumns} gap-1 px-2 pt-1.5 lg:grid-cols-1 lg:px-0 lg:pt-0`
              : `grid ${mobileGridColumns} pt-1.5`
        }
      >
        {navigationItems.map((item, index) => {
          const desktopGroup = (entry: PrimaryNavigationItem): string => {
            if (role === "teacher") {
              if (entry === teacherHomeNavigationItem || entry === teacherUpdatesNavigationItem)
                return "반 소식";
              if (
                entry === teacherAttendanceNavigationItem ||
                entry === teacherStudentNavigationItem ||
                entry === teacherHelpNavigationItem
              )
                return "학생 돌봄";
              return entry === teacherManagementNavigationItem ? "반 관리" : "반 생활";
            }
            if (entry === mealsNavigationItem || entry === studentSuppliesNavigationItem)
              return "생활 정보";
            if (
              entry === studentHomeNavigationItem ||
              entry === studentDesktopUpdatesNavigationItem ||
              entry === studentQuestionNavigationItem ||
              entry === classChatNavigationItem
            )
              return "소식과 소통";
            return "활동과 기록";
          };
          const group = desktop ? desktopGroup(item) : undefined;
          const previousItem = navigationItems[index - 1];
          const beginsGroup =
            desktop && (previousItem === undefined || desktopGroup(previousItem) !== group);
          const active = item.activePrefixes.some((prefix) => pathMatches(pathname, prefix));
          const Icon = item.icon;
          const hasPending =
            role === "teacher" &&
            item.to === "/attendance" &&
            attendancePendingCount !== undefined &&
            attendancePendingCount > 0;

          const hasOpenHelp =
            role === "teacher" &&
            (item.to === "/help-requests" || (!desktop && item.to === "/more")) &&
            helpRequestCount !== undefined &&
            helpRequestCount > 0;

          return (
            <Fragment key={item.label}>
              {beginsGroup ? (
                <p
                  className={`px-3 pb-0.5 text-[0.6875rem] font-semibold tracking-wide text-app-muted ${index === 0 ? "pt-1" : "pt-3"}`}
                  data-navigation-group={group}
                >
                  {group}
                </p>
              ) : null}
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={
                  hasPending
                    ? `${item.label}, 미확인 ${attendancePendingCount}건`
                    : hasOpenHelp
                      ? `${item.label}, 열린 도움 요청 ${helpRequestCount}건`
                      : undefined
                }
                className={`${
                  desktop
                    ? "flex min-h-11 min-w-0 flex-row items-center justify-start gap-3 rounded-2xl border border-transparent px-3 py-2.5 text-sm"
                    : responsive
                      ? "relative flex min-h-[4.25rem] min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-xs leading-[1.03125rem] lg:min-h-11 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-2xl lg:border lg:border-transparent lg:px-3 lg:py-2.5 lg:text-sm lg:leading-5"
                      : "relative flex min-h-[4.25rem] min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-xs leading-[1.03125rem]"
                } font-extrabold transition-colors ${
                  active
                    ? desktop
                      ? "border-role-border bg-role-soft text-role-primary"
                      : responsive
                        ? "text-role-primary lg:border-role-border lg:bg-role-soft"
                        : "text-role-primary"
                    : "text-app-muted hover:bg-app-canvas hover:text-app-text"
                }`}
                data-primary-navigation-item={item.label}
                to={item.to}
              >
                {active && !desktop ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-[24%] top-0 h-[3px] rounded-b-full bg-role-primary"
                    data-primary-navigation-indicator="true"
                  />
                ) : null}
                <Icon aria-hidden="true" size={20} strokeWidth={active ? 2.5 : 2} />
                <span className="whitespace-nowrap">{item.label}</span>
                {hasOpenHelp ? (
                  <span
                    aria-hidden="true"
                    data-help-request-badge="true"
                    className={`${desktop ? "ml-auto" : "absolute left-1/2 top-1 ml-1.5"} min-w-5 rounded-full bg-danger px-1.5 py-0.5 text-center text-[0.6875rem] leading-4 text-app-canvas`}
                  >
                    {helpRequestCount > 99 ? "99+" : helpRequestCount}
                  </span>
                ) : null}
                {hasPending ? (
                  <span
                    aria-hidden="true"
                    className={`${desktop ? "ml-auto" : "absolute left-1/2 top-1 ml-1.5"} min-w-5 rounded-full border border-app-border bg-app-surface px-1.5 py-0.5 text-center text-[0.6875rem] leading-4 text-app-text`}
                    data-attendance-pending-badge="true"
                  >
                    {attendancePendingCount > 99 ? "99+" : attendancePendingCount}
                  </span>
                ) : null}
              </Link>
            </Fragment>
          );
        })}
      </div>
      {railHasMoreBelow ? <RailMoreHint /> : null}
    </nav>
  );
}

interface ProductWordmarkProps {
  className?: string;
  context?: string;
  hideContextOnNarrow?: boolean;
  /** 로그인 화면처럼 제품명이 주인공인 자리에서만 "lg". 앱 내부 헤더는 "md"를 유지한다. */
  size?: "lg" | "md";
  to?: string;
  tone?: WordmarkTone;
}

export function ProductWordmark({
  className = "",
  context,
  hideContextOnNarrow = false,
  size = "md",
  to,
  tone = "light",
}: ProductWordmarkProps): React.JSX.Element {
  const large = size === "lg";
  const content = (
    <>
      <BrandSymbol className={large ? "size-14" : "size-10"} />
      <span
        className={`min-w-0 font-extrabold tracking-[-0.03em] ${large ? "text-[1.75rem] leading-9" : "text-base"} ${
          tone === "dark" ? "text-white" : "text-app-text"
        }`}
      >
        <span className="whitespace-nowrap">우리반 허브</span>
        {context ? (
          <span
            className={`product-wordmark-context ${hideContextOnNarrow ? "hidden min-[390px]:inline" : "inline"} whitespace-nowrap font-bold ${
              tone === "dark" ? "text-blue-100/85" : "text-app-muted"
            }`}
          >
            <span aria-hidden="true" className="product-wordmark-context-divider mx-2 font-medium">
              ·
            </span>
            {context}
          </span>
        ) : null}
      </span>
    </>
  );

  const sharedClassName = `inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-2xl ${className}`;
  const accessibleName = context ? `우리반 허브 · ${context}` : "우리반 허브";

  if (to) {
    return (
      <Link aria-label={accessibleName} className={sharedClassName} to={to}>
        {content}
      </Link>
    );
  }

  return <div className={sharedClassName}>{content}</div>;
}

interface AppShellBarProps {
  backLabel?: string;
  onBack?: () => void;
  backTo?: string;
  brandTo?: string;
  context: string;
}

export function AppShellBar({
  backLabel,
  onBack,
  backTo,
  brandTo,
  context,
}: AppShellBarProps): React.JSX.Element {
  const navigationRole = useContext(AppShellNavigationRoleContext);
  const { pathname } = useLocation();
  const backPath = backTo?.split(/[?#]/u, 1)[0];
  const backAlreadyInBreadcrumb =
    navigationRole !== undefined &&
    backPath !== undefined &&
    routeMetadataForPath(pathname)?.breadcrumbs?.some((item) => {
      const itemPath = item.to?.split(/[?#]/u, 1)[0];
      return itemPath !== undefined && itemPath === backPath;
    }) === true;
  const backClassName = "ui-button ui-button-tertiary min-h-11 shrink-0 gap-1.5 px-3 text-sm";
  const backContent = (
    <>
      <ArrowLeft aria-hidden="true" size={18} strokeWidth={2} />
      {backLabel}
    </>
  );

  if (navigationRole !== undefined) {
    return (
      <div className="app-topbar">
        <AppBreadcrumb />
        {onBack && backLabel ? (
          <nav aria-label="페이지 이동">
            <button className={backClassName} onClick={onBack} type="button">
              {backContent}
            </button>
          </nav>
        ) : backTo && backLabel && !backAlreadyInBreadcrumb ? (
          <nav aria-label="페이지 이동">
            <Link className={backClassName} to={backTo}>
              {backContent}
            </Link>
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <nav aria-label="페이지 이동" className="app-topbar">
      <ProductWordmark
        context={context}
        hideContextOnNarrow={Boolean(onBack ?? backTo)}
        {...(brandTo ? { to: brandTo } : {})}
      />
      {onBack && backLabel ? (
        <button className={backClassName} onClick={onBack} type="button">
          {backContent}
        </button>
      ) : backTo && backLabel ? (
        <Link className={backClassName} to={backTo}>
          {backContent}
        </Link>
      ) : null}
    </nav>
  );
}
