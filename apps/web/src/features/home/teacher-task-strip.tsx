import { Link } from "react-router";

import type { HomeResponse } from "../../api/auth";

/*
 * 2026-09-27 확정 시안의 '처리할 일' 띠(교사 홈 칠판 아래). 출결 연락 미확인·도움 요청·가입 대기를
 * 한 줄로 모으고, 항목을 누르면 그 처리 화면으로 간다. 기간별 확인 현황 진입은 항상 제공한다.
 * 홈에서 바로 승인·읽음 처리(시안 PC 오른쪽 칸)는 아직 하지 않는다 — 각 화면에서 처리한다.
 */

interface Task {
  count: number;
  label: string;
  to: string;
}

export type HelpRequestState =
  { status: "loading" | "error" } | { status: "success"; count: number };

function HelpRequestNotice({ state }: { state: HelpRequestState }): React.JSX.Element | null {
  if (state.status === "success") return null;
  return (
    <Link
      className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-app-muted"
      to="/help-requests"
    >
      {state.status === "loading" ? "도움 요청 확인 중…" : "도움 요청 수 확인 불가 · 목록 보기"}
    </Link>
  );
}

function FollowupsEntry(): React.JSX.Element {
  return (
    <Link
      className="inline-flex min-h-11 items-center rounded-xl px-2 text-sm font-semibold text-role-primary hover:bg-app-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2"
      title="학생별 미해결 모아보기"
      to="/updates/followups"
    >
      기간별 확인 현황
    </Link>
  );
}

function knownCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function taskCounts(home: HomeResponse): {
  attendance: number | undefined;
  members: number | undefined;
} {
  const attendance = home.attendance?.data;
  return {
    attendance:
      home.attendance?.status !== "error" && attendance != null && "pending" in attendance
        ? knownCount(attendance.pending)
        : undefined,
    members: knownCount(home.pending_member_count),
  };
}
function UnconfirmedTaskEntries({ home }: { home: HomeResponse }): React.JSX.Element {
  const counts = taskCounts(home);
  return (
    <>
      {home.attendance !== undefined && counts.attendance === undefined ? (
        <Link
          className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-app-muted"
          to="/attendance"
        >
          출결 수 확인 불가 · 목록 보기
        </Link>
      ) : null}
      {counts.members === undefined ? (
        <Link
          className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-app-muted"
          to="/members/manage"
        >
          가입 요청 수 확인 불가 · 목록 보기
        </Link>
      ) : null}
    </>
  );
}
function allCountsKnown(home: HomeResponse, help: HelpRequestState): boolean {
  const counts = taskCounts(home);
  // The server omits attendance only when its independent feature flag is off.
  return (
    (home.attendance === undefined || counts.attendance !== undefined) &&
    counts.members !== undefined &&
    help.status === "success" &&
    knownCount(help.count) !== undefined
  );
}
export function teacherTasks(home: HomeResponse, helpRequestCount: number): Task[] {
  const counts = taskCounts(home);
  return [
    { count: counts.attendance ?? 0, label: "출결", to: "/attendance" },
    { count: knownCount(helpRequestCount) ?? 0, label: "도움", to: "/help-requests" },
    { count: counts.members ?? 0, label: "가입", to: "/members/manage" },
  ].filter((task) => task.count > 0);
}

export function TeacherTaskStrip({
  helpRequestCount,
  helpRequestState = { status: "success", count: helpRequestCount },
  home,
}: {
  helpRequestCount: number;
  helpRequestState?: HelpRequestState;
  home: HomeResponse;
}): React.JSX.Element | null {
  const tasks = teacherTasks(
    home,
    helpRequestState.status === "success" ? helpRequestState.count : 0,
  );
  const complete = allCountsKnown(home, helpRequestState);
  const total = tasks.reduce((sum, task) => sum + task.count, 0);
  return (
    <nav
      aria-label="처리할 일"
      /* 넓은 화면(xl)에서는 오른쪽 칸의 TeacherTasksPanel이 같은 일을 한다. */
      className="mt-3 flex flex-wrap items-center gap-2 rounded-card border border-app-border bg-app-surface px-3 py-2 shadow-card xl:hidden"
      data-teacher-task-strip
    >
      <span className="flex items-center gap-2 pr-1 text-sm font-extrabold text-app-text">
        {total > 0 || !complete ? (
          <span
            aria-label={complete ? undefined : "전체 건수 확인 불가"}
            className="grid min-w-6 shrink-0 place-items-center whitespace-nowrap rounded-full bg-danger px-1.5 py-0.5 text-xs font-extrabold text-[var(--color-app-canvas)]"
          >
            {complete ? total : "…"}
          </span>
        ) : null}
        {complete && total === 0 ? "처리할 일이 없어요." : "처리할 일"}
      </span>
      {tasks.map((task) => (
        <Link
          className="inline-flex min-h-11 items-center gap-1 rounded-full border border-app-border px-3 text-sm font-bold text-app-text hover:bg-app-surface-muted"
          key={task.label}
          to={task.to}
        >
          {taskTitle(task.label)}
          <strong className="shrink-0 whitespace-nowrap text-role-primary">{task.count}건</strong>
        </Link>
      ))}
      <UnconfirmedTaskEntries home={home} />
      <HelpRequestNotice state={helpRequestState} />
      <FollowupsEntry />
    </nav>
  );
}

const TASK_TITLES: Record<string, string> = {
  가입: "가입 요청",
  도움: "도움 요청",
  출결: "출결 연락 미확인",
};

// 보이는 글자와 화면낭독기 이름을 같은 말로 쓴다(총검수 B1-03).
function taskTitle(label: string): string {
  return label === "출결" ? "출결 확인" : (TASK_TITLES[label] ?? label);
}

/** 시안 PC 오른쪽 칸의 '처리할 일'. 넓은 화면(xl)에서만 보이고, 각 줄은 처리 화면으로 간다. */
export function TeacherTasksPanel({
  helpRequestCount,
  helpRequestState = { status: "success", count: helpRequestCount },
  home,
}: {
  helpRequestCount: number;
  helpRequestState?: HelpRequestState;
  home: HomeResponse;
}): React.JSX.Element {
  const tasks = teacherTasks(
    home,
    helpRequestState.status === "success" ? helpRequestState.count : 0,
  );
  return (
    <section
      aria-labelledby="teacher-tasks-panel-title"
      className="hidden rounded-card border border-app-border bg-app-surface p-4 shadow-card xl:block"
      data-teacher-tasks-panel
    >
      <h2
        className="flex min-h-11 items-center text-base font-extrabold text-app-text"
        id="teacher-tasks-panel-title"
      >
        처리할 일
      </h2>
      {tasks.length === 0 && allCountsKnown(home, helpRequestState) ? (
        <p className="mt-3 text-sm font-semibold text-app-muted">처리할 일이 없어요.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {tasks.map((task) => (
            <li key={task.label}>
              <Link
                aria-label={`${taskTitle(task.label)} ${task.count}건`}
                className="flex min-h-11 items-center justify-between gap-3 rounded-xl px-2 text-sm font-bold text-app-text hover:bg-app-surface-muted"
                to={task.to}
              >
                <span>{taskTitle(task.label)}</span>
                <span className="grid min-w-6 place-items-center rounded-full bg-danger px-1.5 py-0.5 text-xs font-extrabold text-[var(--color-app-canvas)]">
                  {task.count}건
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <UnconfirmedTaskEntries home={home} />
      <HelpRequestNotice state={helpRequestState} />
      <div className="mt-3 border-t border-app-border pt-2">
        <FollowupsEntry />
      </div>
    </section>
  );
}
