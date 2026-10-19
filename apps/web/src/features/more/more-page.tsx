import {
  Backpack,
  CalendarRange,
  ChevronRight,
  History,
  LoaderCircle,
  MessageCircleMore,
  MessagesSquare,
  NotebookPen,
  RefreshCw,
  Settings,
  Settings2,
  Soup,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  type BootstrapAllowedAction,
  type BootstrapResponse,
} from "../../api/auth";
import { listHelpRequests } from "../../api/help-requests";
import { AppShell, type AppNavigationRole } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentFrameHeader } from "../layout/content-frame";

/*
 * 2026-09-27 확정 시안(더보기설정_v3_확정): 맨 위 '나' 카드 → 아래 탭에 없는 기능은 아이콘 타일
 * 3칸(tile) → 가끔 쓰는 곳은 줄 목록(row). 학생의 '선생님께 물어보기'는 맨 위 넓은 칸(wide).
 * 긴 설명 문장은 타일에서 빼고 줄 목록에만 짧게 둔다.
 */
type Placement = "row" | "tile" | "wide";
type Tone = "event" | "exam" | "help" | "school" | "task";

interface MoreDestination {
  actions?: readonly BootstrapAllowedAction[];
  description: string;
  icon: LucideIcon;
  label: string;
  placement: Placement;
  /** 타일 아이콘 바탕 색(일정 종류 색과 같은 차분한 계열). */
  tone?: Tone;
  to: string;
}

const teacherDestinations = [
  {
    description: "반 일정",
    icon: CalendarRange,
    label: "일정",
    placement: "tile",
    tone: "exam",
    to: "/schedules",
  },
  {
    description: "이번 주 급식",
    icon: Soup,
    label: "급식",
    placement: "tile",
    tone: "task",
    to: "/meals",
  },
  {
    // 투표·선거가 둘 다 꺼지면 빈 화면이라 숨긴다(총검수 A3-03).
    actions: ["MANAGE_POLLS", "VOTE_IN_POLLS", "MANAGE_ELECTIONS", "VOTE_IN_ELECTIONS"],
    description: "투표 · 선거",
    icon: Vote,
    label: "반 활동",
    placement: "tile",
    tone: "event",
    to: "/activities",
  },
  {
    actions: ["USE_CLASS_CHAT"],
    description: "반 단체 대화방 관리",
    // 도움 요청과 같은 아이콘이었다 — PC 메뉴와 같은 반 대화 아이콘(총검수 B1-10).
    icon: MessageCircleMore,
    label: "반 대화",
    placement: "tile",
    tone: "school",
    to: "/class-chat",
  },
  {
    description: "학생이 보낸 질문",
    icon: MessagesSquare,
    label: "도움 요청",
    placement: "tile",
    tone: "help",
    to: "/help-requests",
  },
  {
    description: "끝난 반의 소식을 1년 동안 볼 수 있어요",
    icon: History,
    label: "지난 반 기록",
    placement: "row",
    to: "/past-classes",
  },
  {
    // 반 운영과 프로필은 반 관리, 비밀번호와 화면 설정은 /settings에서 연다.
    description: "초대 코드 · 반 정보 · 내 프로필",
    icon: Settings2,
    label: "반 관리",
    placement: "row",
    to: "/class/manage",
  },
  {
    // 휴대폰에서도 화면 테마 등 /settings에 갈 수 있게(총검수 B1-01). 교사 알림은 아직 없다(B1-02).
    description: "테마 · 비밀번호 · 로그아웃",
    icon: Settings,
    label: "내 계정·화면 설정",
    placement: "row",
    to: "/settings",
  },
] as const satisfies readonly MoreDestination[];

const studentDestinations = [
  {
    description: "챙길 준비물과 해야 할 숙제",
    icon: Backpack,
    label: "준비물·숙제",
    placement: "tile",
    tone: "task",
    to: "/supplies",
  },
  {
    description: "담임 선생님만 볼 수 있어요",
    icon: MessagesSquare,
    label: "선생님께 물어보기",
    placement: "wide",
    to: "/help-requests/ask",
  },
  {
    // 2026-09-27 시안 탭(홈·소식·일정·출결·더보기)에서 빠진 반 활동을 여기서 찾는다.
    // 투표·선거가 둘 다 꺼지면 빈 화면이라 숨긴다(총검수 A3-03).
    actions: ["MANAGE_POLLS", "VOTE_IN_POLLS", "MANAGE_ELECTIONS", "VOTE_IN_ELECTIONS"],
    description: "투표 · 선거",
    icon: Vote,
    label: "반 활동",
    placement: "tile",
    tone: "event",
    to: "/activities",
  },
  {
    description: "이번 주 급식",
    icon: Soup,
    label: "급식",
    placement: "tile",
    tone: "task",
    to: "/meals",
  },
  {
    actions: ["USE_CLASS_CHAT"],
    description: "반 친구들과 선생님",
    icon: MessageCircleMore,
    label: "반 대화",
    placement: "tile",
    tone: "school",
    to: "/class-chat",
  },
  {
    actions: ["MANAGE_OWN_ASSESSMENTS"],
    description: "나만 보는 평가 계획과 기록",
    icon: NotebookPen,
    label: "평가 기록",
    placement: "tile",
    tone: "school",
    to: "/assessments",
  },
  {
    // 출결이 켜진 반은 아래 탭에 일정이 없을 수 있어 여기서도 찾게 둔다.
    description: "반 일정을 날짜별로",
    icon: CalendarRange,
    // 교사 화면과 같은 이름(총검수 B2-07).
    label: "일정",
    placement: "row",
    to: "/schedules",
  },
  {
    description: "끝난 반의 소식을 1년 동안 볼 수 있어요",
    icon: History,
    label: "지난 반 기록",
    placement: "row",
    to: "/past-classes",
  },
  {
    description: "화면 · 알림 · 계정",
    icon: Settings,
    label: "설정",
    placement: "row",
    to: "/settings",
  },
] as const satisfies readonly MoreDestination[];

const TILE_TONE: Record<Tone, string> = {
  event: "bg-[#e6ecf0] text-[#4d6474]",
  exam: "bg-[#e2eee7] text-[#2b6149]",
  help: "bg-[#fbeae6] text-[#b0443a]",
  school: "bg-[#eeebf4] text-[#6b5b8a]",
  task: "bg-[#f6eedd] text-[#8a6a2e]",
};

const TILE_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2",
  // 5개는 2열이면 빈칸이 생겨 3+2로 놓는다(총검수 B1-10).
  5: "grid-cols-3",
};

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2";

function isVisible(bootstrap: BootstrapResponse, destination: MoreDestination): boolean {
  return (
    destination.actions === undefined ||
    destination.actions.some((action) => bootstrap.allowed_actions.includes(action))
  );
}

function CountBadge({ count }: { count: number | undefined }): React.JSX.Element | null {
  if (count === undefined || count === 0) return null;
  return (
    <span
      aria-label={`${count}건`}
      className="absolute right-2.5 top-2.5 grid min-w-5 place-items-center rounded-full bg-danger px-1.5 py-0.5 text-xs font-extrabold text-app-canvas"
    >
      {count}
    </span>
  );
}

function MoreTile({
  count,
  destination,
}: {
  count?: number | undefined;
  destination: MoreDestination;
}): React.JSX.Element {
  const Icon = destination.icon;
  return (
    <Link
      className={`relative flex min-h-24 flex-col items-center justify-center gap-2 rounded-card bg-app-surface px-2 text-sm font-bold text-app-text shadow-card transition hover:bg-role-soft ${FOCUS_RING}`}
      data-more-tile={destination.to}
      to={destination.to}
    >
      <span
        className={`grid size-10 place-items-center rounded-[0.8rem] ${TILE_TONE[destination.tone ?? "exam"]}`}
        data-tile-tone={destination.tone ?? "exam"}
      >
        <Icon aria-hidden="true" size={21} />
      </span>
      {destination.label}
      <CountBadge count={count} />
    </Link>
  );
}

function MoreRow({
  destination,
  wide = false,
}: {
  destination: MoreDestination;
  wide?: boolean;
}): React.JSX.Element {
  const Icon = destination.icon;
  return (
    <Link
      className={`flex items-center gap-3 px-4 py-2.5 text-app-text transition hover:bg-role-soft ${FOCUS_RING} ${
        wide ? "min-h-16 rounded-card bg-app-surface shadow-card" : "min-h-14"
      }`}
      data-more-row={destination.to}
      to={destination.to}
    >
      <span
        className={
          wide
            ? "grid size-10 shrink-0 place-items-center rounded-[0.8rem] bg-[#e2eee7] text-[#2b6149]"
            : "shrink-0 text-role-primary"
        }
      >
        <Icon aria-hidden="true" size={wide ? 21 : 20} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-[0.95rem] font-extrabold">{destination.label}</strong>
        <span className="mt-0.5 block break-keep text-xs text-app-muted">
          {destination.description}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
    </Link>
  );
}

function MeCard({ bootstrap }: { bootstrap: BootstrapResponse }): React.JSX.Element {
  const membership = bootstrap.current_membership;
  const teacher = membership?.role === "teacher";
  const name = membership?.display_name_in_class ?? bootstrap.account.display_name;
  const studentNumber =
    !teacher && membership?.student_number != null ? `${membership.student_number}번` : undefined;
  const detail = [teacher ? "선생님" : "학생", bootstrap.current_class?.name, studentNumber]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      className={`flex min-h-16 items-center gap-3 rounded-card bg-app-surface px-4 py-3 shadow-card transition hover:bg-role-soft ${FOCUS_RING}`}
      data-more-me
      to={teacher ? "/class/manage" : "/settings"}
    >
      {/* 사진 기능 전 기본 표시: 이름 첫 글자 동그라미(실제 사진은 서버 준비가 필요한 별도 단계). */}
      <span
        aria-hidden="true"
        className="grid size-12 shrink-0 place-items-center rounded-full bg-role-soft text-lg font-extrabold text-role-primary"
      >
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block break-words text-base font-extrabold text-app-text">{name}</strong>
        <span className="block break-words text-sm text-app-muted">{detail}</span>
      </span>
      {teacher ? (
        <span className="shrink-0 text-xs font-bold text-role-primary">반 프로필·관리</span>
      ) : null}
      <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
    </Link>
  );
}

export function MorePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // 선생님께는 알림이 없으므로(2026-09-27 결정) 열린 도움 요청 수를 타일의 빨간 숫자로 보여 준다.
  const [helpRequestCount, setHelpRequestCount] = useState<number>();
  const teacherMembership = bootstrap?.current_membership?.role === "teacher";

  const load = useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void getBootstrap()
      .then((result) => {
        if (result.destination !== "HOME" || result.current_membership === null) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "더보기를 불러오지 못했어요.",
        );
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!teacherMembership) return;
    let active = true;
    listHelpRequests("open")
      .then((items) => {
        if (active) setHelpRequestCount(items.length);
      })
      // 숫자는 보조 정보라 실패해도 타일은 그대로 연다(숫자만 생략).
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [teacherMembership]);

  if (bootstrap === undefined) {
    return (
      <AppShell contentFrame width="wide">
        <ContentFrameHeader title="더보기" />
        {loading ? (
          <div className="mt-6 text-center" role="status">
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
            <p className="mt-4 font-bold text-app-text">사용할 수 있는 기능을 모으고 있어요.</p>
          </div>
        ) : (
          <AsyncStatePanel
            action={
              <button className="ui-button ui-button-primary" onClick={load} type="button">
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            }
            description={error ?? "잠시 뒤 다시 시도해 주세요."}
            kind="error"
            title="더보기를 열지 못했어요."
          />
        )}
      </AppShell>
    );
  }

  const role: AppNavigationRole =
    bootstrap.current_membership?.role === "teacher" ? "teacher" : "student";
  const destinations: MoreDestination[] = (
    role === "teacher" ? teacherDestinations : studentDestinations
  ).filter((destination) => isVisible(bootstrap, destination));
  const byPlacement = (placement: Placement) =>
    destinations.filter((destination) => destination.placement === placement);
  const tiles = byPlacement("tile");

  return (
    <AppShell contentFrame navigationRole={role} width="wide">
      <ContentFrameHeader title="더보기" />
      {/* 카드도 제목과 같은 시작선에 둔다(가운데 정렬이면 제목만 왼쪽에 남아 어긋났다, 2026-10-04 화면 검수). */}
      <div className="grid w-full max-w-5xl gap-4" data-more-layout>
        <MeCard bootstrap={bootstrap} />
        <nav
          aria-label="더보기 메뉴"
          className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"
        >
          <section aria-labelledby="more-class-menu-title" className="grid min-w-0 gap-2.5">
            <h2 id="more-class-menu-title" className="text-sm font-extrabold text-app-text">
              우리 반 메뉴
            </h2>
            {byPlacement("wide").map((destination) => (
              <MoreRow destination={destination} key={destination.to} wide />
            ))}
            {/* 타일 배치: 4개면 2×2, 5개면 3+2, 3개 이하면 그 수만큼(빈칸 없이). */}
            <div className={`grid gap-2.5 ${TILE_COLUMNS[tiles.length] ?? "grid-cols-3"}`}>
              {tiles.map((destination) => (
                <MoreTile
                  count={destination.to === "/help-requests" ? helpRequestCount : undefined}
                  destination={destination}
                  key={destination.to}
                />
              ))}
            </div>
          </section>
          <section aria-labelledby="more-records-title" className="grid min-w-0 gap-2.5">
            <h2 id="more-records-title" className="text-sm font-extrabold text-app-text">
              {role === "teacher" ? "기록·관리" : "내 기록·설정"}
            </h2>
            <div className="divide-y divide-app-border overflow-hidden rounded-card bg-app-surface shadow-card">
              {byPlacement("row").map((destination) => (
                <MoreRow destination={destination} key={destination.to} />
              ))}
            </div>
          </section>
        </nav>
      </div>
    </AppShell>
  );
}
