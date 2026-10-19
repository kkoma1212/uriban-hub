import {
  ArrowRight,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  UsersRound,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { getCurrentElection, listElections } from "../../api/elections";
import { listPolls } from "../../api/polls";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import { AppShell } from "../layout/app-shell";
import {
  ContentPostCard,
  selectContentInPlace,
  useContentDesktop,
} from "../updates/content-list-view";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentFrameBody, ContentFrameHeader, ContentSplit } from "../layout/content-frame";
import "./activity-layout.css";

type ActivityGroup = "participation";

interface ActivityDestination {
  actions: readonly string[];
  description: string;
  group: ActivityGroup;
  icon: LucideIcon;
  studentLabel: string;
  teacherLabel: string;
  title: string;
  to: string;
  tone: "people" | "poll";
}

interface ActivitySnapshot {
  detail: string;
  state: "empty" | "error" | "loading" | "ready";
  status?: string;
  title: string;
}

type ActivitySnapshotMap = Record<string, ActivitySnapshot | undefined>;

const activityDestinations = [
  {
    actions: ["MANAGE_POLLS", "VOTE_IN_POLLS"],
    description: "한 가지를 골라 의견을 모으고 마감 뒤 결과를 확인해요.",
    group: "participation",
    icon: Vote,
    studentLabel: "참여할 투표 보기",
    teacherLabel: "투표 현황 보기",
    title: "투표",
    to: "/polls",
    tone: "poll",
  },
  {
    actions: ["MANAGE_ELECTIONS", "VOTE_IN_ELECTIONS"],
    description: "후보 등록부터 비밀투표와 결과 발표까지 이어서 진행해요.",
    group: "participation",
    icon: UsersRound,
    studentLabel: "선거 목록 보기",
    teacherLabel: "선거 목록 보기",
    title: "대표 선거",
    to: "/elections",
    tone: "people",
  },
] as const satisfies readonly ActivityDestination[];

const toneClasses: Record<ActivityDestination["tone"], string> = {
  people: "border-home-people-line bg-home-people-soft text-home-people",
  poll: "border-home-poll-line bg-home-poll-soft text-home-poll",
};

const electionStatusLabel = {
  closed: "개표 대기",
  draft: "후보 등록",
  open: "투표 중",
  published: "결과 공개",
} as const;

const kstShortDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Seoul",
  year: "numeric",
});

function shortDate(value: string | null): string {
  if (value === null) return "시각 미정";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : kstShortDateFormatter.format(date).replaceAll("-", ".");
}

function emptySnapshot(title: string, detail: string): ActivitySnapshot {
  return { detail, state: "empty", title };
}

async function loadActivitySnapshot(
  destination: ActivityDestination,
  role: "student" | "teacher",
): Promise<ActivitySnapshot> {
  try {
    if (destination.to === "/polls") {
      const result = await listPolls("open");
      const first = result.items[0];
      if (first === undefined) {
        return emptySnapshot(
          "진행 중인 투표가 없어요",
          role === "teacher"
            ? "필요할 때 새 투표를 만들 수 있어요."
            : "새 투표가 열리면 여기에 보여요.",
        );
      }
      return {
        detail: `마감 ${shortDate(first.closes_at)}${result.items.length > 1 ? ` · 외 ${result.items.length - 1}건` : ""}`,
        state: "ready",
        status: `${result.items.length}건 진행 중`,
        title: first.title,
      };
    }

    if (destination.to === "/elections") {
      if (role === "teacher") {
        const result = await listElections();
        const current = result.items.find((item) => item.status !== "published") ?? result.items[0];
        if (current === undefined) {
          return emptySnapshot("진행 중인 선거가 없어요", "새 선거는 후보 등록부터 시작해요.");
        }
        return {
          detail:
            current.status === "open"
              ? `투표 시작 ${shortDate(current.opened_at)}`
              : current.status === "published"
                ? `결과 공개 ${shortDate(current.published_at)}`
                : "현재 단계에서 가능한 작업을 이어가세요.",
          state: "ready",
          status: electionStatusLabel[current.status],
          title: current.title,
        };
      }

      const result = await getCurrentElection();
      if (result.item === null) {
        return emptySnapshot(
          "참여할 선거가 없어요",
          "투표가 열리면 후보와 참여 상태를 보여 드려요.",
        );
      }
      return {
        detail: result.item.has_voted
          ? `${result.item.participant_count}명 참여 · 제출 완료`
          : `${result.item.participant_count}명 참여`,
        state: "ready",
        status: result.item.has_voted ? "참여 완료" : electionStatusLabel[result.item.status],
        title: result.item.title,
      };
    }

    throw new Error("Unknown activity destination.");
  } catch (requestError) {
    if (requestError instanceof ApiRequestError && requestError.status === 401) throw requestError;
    return {
      detail: "투표·선거 화면에 들어가면 최신 내용을 볼 수 있어요.",
      state: "error",
      title: "현황을 불러오지 못했어요",
    };
  }
}

function hasAnyAction(bootstrap: BootstrapResponse, actions: readonly string[]): boolean {
  const allowed = bootstrap.allowed_actions as readonly string[];
  return actions.some((action) => allowed.includes(action));
}

function ActivityCard({
  destination,
  role,
  snapshot,
}: {
  destination: ActivityDestination;
  role: "student" | "teacher";
  snapshot: ActivitySnapshot | undefined;
}): React.JSX.Element {
  const Icon = destination.icon;
  return (
    <article
      className="content-card activity-summary-panel flex min-w-0 flex-col p-4 sm:p-5"
      data-activity-dashboard-card={destination.to.slice(1)}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`grid size-11 shrink-0 place-items-center rounded-2xl border ${toneClasses[destination.tone]}`}
        >
          <Icon aria-hidden="true" size={21} />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-extrabold text-app-text">{destination.title}</h3>
          <p className="mt-1 line-clamp-2 break-words text-sm leading-5 text-app-muted">
            {destination.description}
          </p>
        </div>
      </div>

      <div
        aria-atomic="true"
        aria-live={snapshot?.state === "error" ? "assertive" : "polite"}
        className="mt-3 border-t border-app-border py-3"
        data-activity-summary={snapshot?.state ?? "loading"}
        role={snapshot?.state === "error" ? "alert" : "status"}
      >
        {snapshot === undefined || snapshot.state === "loading" ? (
          <div className="flex min-h-11 items-center gap-3 text-sm font-bold text-app-muted">
            <LoaderCircle aria-hidden="true" className="animate-spin text-role-primary" size={19} />
            현재 현황을 확인하고 있어요.
          </div>
        ) : (
          <>
            <div className="flex min-w-0 items-start justify-between gap-3">
              <strong className="min-w-0 line-clamp-2 break-words text-base font-extrabold text-app-text">
                {snapshot.title}
              </strong>
              {snapshot.status === undefined ? (
                snapshot.state === "error" ? (
                  <RefreshCw aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
                ) : (
                  <History aria-hidden="true" className="shrink-0 text-app-muted" size={17} />
                )
              ) : (
                <span className="shrink-0 rounded-full bg-role-soft px-2.5 py-1 text-xs font-extrabold text-role-primary">
                  {snapshot.status}
                </span>
              )}
            </div>
            <p className="mt-2 line-clamp-2 break-words text-xs font-semibold leading-5 text-app-muted">
              {snapshot.detail}
            </p>
          </>
        )}
      </div>
      <div
        className={`mt-auto grid gap-2 pt-2 ${role === "teacher" ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-1" : ""}`}
      >
        {role === "teacher" ? (
          <Link
            className="ui-button ui-button-primary min-h-11 w-full"
            to={`${destination.to}?create=1`}
          >
            <Plus aria-hidden="true" className="shrink-0" size={18} />
            {destination.title} 만들기
          </Link>
        ) : null}
        <Link
          className="inline-flex min-h-11 items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface-raised px-4 py-2.5 text-sm font-extrabold text-app-text transition hover:border-role-border hover:text-role-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
          to={destination.to}
        >
          {role === "teacher" ? destination.teacherLabel : destination.studentLabel}
          <ArrowRight aria-hidden="true" className="shrink-0" size={17} />
        </Link>
      </div>
    </article>
  );
}

export function ActivitiesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const desktop = useContentDesktop();
  const [selectedActivity, setSelectedActivity] = useState<string>();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [activitySnapshots, setActivitySnapshots] = useState<ActivitySnapshotMap>({});
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardReload, setDashboardReload] = useState(0);

  const bootstrapGeneration = useRef(0);

  const load = useCallback((): void => {
    const generation = ++bootstrapGeneration.current;
    setLoading(true);
    setError(undefined);
    void getBootstrap()
      .then((result) => {
        if (generation !== bootstrapGeneration.current) return;
        if (result.destination !== "HOME" || result.current_membership === null) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (generation !== bootstrapGeneration.current) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearAuthenticatedClientState();
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "반 활동을 불러오지 못했어요.",
        );
      })
      .finally(() => {
        if (generation === bootstrapGeneration.current) setLoading(false);
      });
  }, [navigate]);

  useEffect(() => {
    load();
    return () => {
      bootstrapGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    const role = bootstrap.current_membership?.role === "teacher" ? "teacher" : "student";
    const destinations = activityDestinations.filter((destination) =>
      hasAnyAction(bootstrap, destination.actions),
    );
    let cancelled = false;
    setDashboardLoading(true);
    setActivitySnapshots(
      Object.fromEntries(
        destinations.map((destination) => [
          destination.to,
          {
            detail: "현재 공개·진행 상태를 확인하고 있어요.",
            state: "loading",
            title: "현황 확인 중",
          } satisfies ActivitySnapshot,
        ]),
      ),
    );
    void Promise.all(
      destinations.map(
        async (destination) =>
          [destination.to, await loadActivitySnapshot(destination, role)] as const,
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setActivitySnapshots(Object.fromEntries(entries));
        setDashboardLoading(false);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          cancelled = true;
          clearAuthenticatedClientState();
          void navigate("/login", { replace: true });
          return;
        }
        setDashboardLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrap, dashboardReload, navigate]);

  if (bootstrap === undefined) {
    return (
      <AppShell alignedFrame contentFrame width="wide">
        <ContentFrameHeader title="반 활동" />
        <ContentFrameBody>
          {loading ? (
            <div className="text-center" role="status">
              <LoaderCircle
                aria-hidden="true"
                className="mx-auto animate-spin text-role-primary"
                size={32}
              />
              <p className="mt-4 font-bold text-app-text">반 활동을 모으고 있어요.</p>
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
              title="반 활동을 열지 못했어요."
            />
          )}
        </ContentFrameBody>
      </AppShell>
    );
  }

  const role = bootstrap.current_membership?.role === "teacher" ? "teacher" : "student";
  const visibleDestinations = activityDestinations.filter((destination) =>
    hasAnyAction(bootstrap, destination.actions),
  );

  return (
    <AppShell alignedFrame contentFrame navigationRole={role} width="wide">
      <ContentFrameHeader
        actions={
          <button
            aria-busy={dashboardLoading}
            aria-label="반 활동 현황 새로고침"
            className="ui-icon-button"
            disabled={dashboardLoading}
            onClick={() => setDashboardReload((current) => current + 1)}
            type="button"
          >
            {dashboardLoading ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            ) : (
              <RefreshCw aria-hidden="true" size={17} />
            )}
          </button>
        }
        title="반 활동"
      />
      <ContentFrameBody>
        {visibleDestinations.length === 0 ? (
          <AsyncStatePanel
            description="반 관리에서 기능을 켜면 사용할 수 있는 활동이 여기에 나타나요."
            kind="empty"
            title="지금 사용할 수 있는 반 활동이 없어요."
          />
        ) : (
          <ContentSplit
            className="activity-overview"
            asideLabel="선택한 반 활동"
            aside={
              !desktop ? undefined : (
                <ActivityCard
                  destination={
                    visibleDestinations.find((item) => item.to === selectedActivity) ??
                    visibleDestinations[0]!
                  }
                  role={role}
                  snapshot={
                    activitySnapshots[
                      (
                        visibleDestinations.find((item) => item.to === selectedActivity) ??
                        visibleDestinations[0]!
                      ).to
                    ]
                  }
                />
              )
            }
          >
            <ul className="grid min-w-0 content-start gap-2">
              {visibleDestinations.map((destination) => (
                <li className="min-w-0" key={destination.to}>
                  {desktop ? (
                    <ContentPostCard
                      to={destination.to}
                      selected={(selectedActivity ?? visibleDestinations[0]?.to) === destination.to}
                      onClick={(event) => {
                        if (selectContentInPlace(event)) setSelectedActivity(destination.to);
                      }}
                      title={activitySnapshots[destination.to]?.title ?? destination.title}
                      body={activitySnapshots[destination.to]?.detail ?? destination.description}
                      kind={destination.title}
                      footer={
                        activitySnapshots[destination.to]?.status ??
                        (activitySnapshots[destination.to]?.state === "error"
                          ? "현황을 불러오지 못했어요"
                          : role === "teacher"
                            ? destination.teacherLabel
                            : destination.studentLabel)
                      }
                    />
                  ) : (
                    <ActivityCard
                      destination={destination}
                      role={role}
                      snapshot={activitySnapshots[destination.to]}
                    />
                  )}
                </li>
              ))}
            </ul>
          </ContentSplit>
        )}
      </ContentFrameBody>
    </AppShell>
  );
}
