import { ContentPeriodForm } from "./content-period-form";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { formatKstCalendarDate, formatKstDateTime } from "../../lib/kst-format";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import {
  loadStudentFollowups,
  shiftCalendarDate,
  validateFollowupPeriod,
  type FollowupPeriod,
  type StudentFollowupsResult,
} from "./student-followups-data";

function FollowupsQuery({ bootstrap }: { bootstrap: BootstrapResponse }): React.JSX.Element {
  const today = bootstrap.server_today;
  const navigate = useNavigate();
  const [period, setPeriod] = useState<FollowupPeriod>({
    from: shiftCalendarDate(today, -6),
    to: today,
  });
  const [result, setResult] = useState<StudentFollowupsResult>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [search, setSearch] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  function changePeriod(next: FollowupPeriod) {
    generation.current += 1;
    setPeriod(next);
    setResult(undefined);
    setProgress(undefined);
    setError(undefined);
  }

  async function query() {
    const invalid = validateFollowupPeriod(period, today);
    setError(invalid);
    if (invalid !== undefined) return;
    const run = ++generation.current;
    const active = () => generation.current === run;
    setResult(undefined);
    setProgress("기간에 해당하는 안내를 찾고 있어요.");
    try {
      const current = await getBootstrap();
      if (!active()) return;
      if (
        current.current_membership?.id !== bootstrap.current_membership?.id ||
        current.current_membership?.role !== "teacher" ||
        current.current_membership.status !== "approved" ||
        current.destination !== "HOME" ||
        !current.allowed_actions.includes("MANAGE_CLASS")
      )
        throw new Error("현재 반의 선생님 권한을 확인해 주세요. 페이지를 새로고침해 주세요.");
      if (current.server_today !== today)
        throw new Error("날짜가 바뀌었어요. 페이지를 새로고침해 주세요.");
      const loaded = await loadStudentFollowups(period, today, active, (done, total) => {
        if (active()) setProgress(`안내 ${total}개 중 ${done}개의 학생 현황을 확인했어요.`);
      });
      if (active()) setResult(loaded);
    } catch (failure) {
      if (!active()) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        failure instanceof Error
          ? failure.message
          : "현황을 불러오지 못했어요. 다시 조회해 주세요.",
      );
    } finally {
      if (active()) setProgress(undefined);
    }
  }

  const term = search.trim().toLocaleLowerCase("ko");
  const visible =
    result?.students.filter(
      (student) =>
        term === "" ||
        student.name.toLocaleLowerCase("ko").includes(term) ||
        String(student.number ?? "") === term,
    ) ?? [];
  return (
    <div className="mt-5 space-y-5">
      <ContentPeriodForm
        busy={progress !== undefined}
        includeUpcoming
        onChange={changePeriod}
        onSubmit={() => void query()}
        period={period}
        submitLabel="조회하기"
        today={today}
      />
      {progress === undefined ? null : (
        <p aria-live="polite" className="text-sm font-semibold text-app-muted" role="status">
          {progress}
        </p>
      )}
      {error === undefined ? null : (
        <div
          className="rounded-card border border-app-border bg-app-surface-raised p-4 text-app-text"
          role="alert"
        >
          <p className="font-bold">조회 결과를 표시할 수 없어요</p>
          <p className="mt-2 text-sm">{error}</p>
        </div>
      )}
      {result === undefined ? null : (
        <section aria-labelledby="student-followups-results" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-app-text" id="student-followups-results">
                확인이 남은 학생 {result.students.length}명
              </h2>
              <p className="mt-1 text-sm text-app-muted">
                {result.period.from} ~ {result.period.to} · 안내 {result.contentCount}개 조회
              </p>
            </div>
            <button
              className="ui-button ui-button-secondary min-h-11 px-3 text-sm"
              onClick={() => void query()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              다시 조회
            </button>
          </div>
          <p className="rounded-xl bg-app-surface-muted p-3 text-sm leading-6 text-app-muted">
            학생이 남긴 확인·자기 체크의 조회 시점 현황입니다. 숙제 제출 여부는 알 수 없어요. 재알림
            시각은 해당 안내의 최근 앱 내 요청 시각이며, 학생별 수신·연락 기록과는 다릅니다.
          </p>
          {result.students.length === 0 ? (
            <p className="rounded-card border border-app-border bg-app-surface-raised p-5 text-app-text">
              {result.contentCount === 0
                ? "선택한 기간에 해당하는 안내가 없어요."
                : "조회한 안내에서 미확인·재확인·미체크 상태인 학생이 없어요."}
            </p>
          ) : (
            <>
              <label className="grid gap-2 text-sm font-bold text-app-text">
                학생 이름 또는 번호
                <input
                  className="ui-input min-h-11"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="학생 찾기"
                  type="search"
                  value={search}
                />
              </label>
              {visible.length === 0 ? (
                <p className="text-sm text-app-muted">검색에 맞는 학생이 없어요.</p>
              ) : null}
              <div className="grid items-start gap-4 lg:grid-cols-2">
                {visible.map((student) => (
                  <article
                    className="min-w-0 rounded-card border border-app-border bg-app-surface-raised p-4 sm:p-5"
                    key={student.id}
                  >
                    <h3 className="break-words text-base font-extrabold text-app-text">
                      {student.number === null ? "번호 없음" : `${student.number}번`} ·{" "}
                      {student.name}
                    </h3>
                    <p className="mt-1 text-sm font-semibold text-app-muted">
                      확인할 안내 {student.items.length}개
                    </p>
                    <ul className="mt-3 divide-y divide-app-border">
                      {student.items.map((item) => (
                        <li className="py-3" key={`${item.kind}:${item.id}`}>
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                            <span className="text-app-muted">{item.label}</span>
                            <span className="rounded-full bg-role-soft px-2 py-1 text-role-primary">
                              {item.state === "modified_unconfirmed"
                                ? "변경 후 재확인"
                                : item.state === "unread"
                                  ? "미확인"
                                  : "미체크"}
                            </span>
                          </div>
                          <Link
                            className="mt-1 flex min-h-11 min-w-0 items-center font-bold text-app-text underline decoration-app-border underline-offset-4 hover:text-role-primary"
                            to={`/${item.kind === "notice" ? "notices" : "supplies"}/${encodeURIComponent(item.id)}#${item.kind === "notice" ? "notice-confirmation-status" : "supply-check-status"}`}
                          >
                            <span className="min-w-0 [overflow-wrap:anywhere]">{item.title}</span>
                          </Link>
                          <p className="text-xs leading-5 text-app-muted">
                            {item.kind === "notice" ? "게시일" : "예정일"}{" "}
                            {formatKstCalendarDate(item.date)}
                          </p>
                          <p className="mt-1 text-xs leading-5 text-app-muted">
                            이 안내 최근 재알림:{" "}
                            {item.lastReminderAt === null
                              ? "현재 내용의 요청 기록 없음"
                              : formatKstDateTime(item.lastReminderAt)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

export function StudentFollowupsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then((current) => {
        if (!active) return;
        // 막다른 오류 화면 대신 공통 교사 전용 처리(총검수 B2-05).
        const accessRedirect = teacherOnlyAccessRedirect(current);
        if (accessRedirect !== null) {
          void navigate(accessRedirect.path, {
            replace: true,
            ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
          });
          return;
        }
        setBootstrap(current);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof ApiRequestError && failure.status === 401)
          void navigate("/login", { replace: true });
        else setError(failure instanceof Error ? failure.message : "현재 반을 확인하지 못했어요.");
      });
    return () => {
      active = false;
    };
  }, [bootstrapAttempt, navigate]);
  return (
    <AppShell
      {...(bootstrap === undefined ? {} : { navigationRole: "teacher" as const })}
      width="wide"
    >
      <AppShellBar backLabel="소식으로" backTo="/updates" brandTo="/home" context="학생별 미해결" />
      <PageHeader
        eyebrow="기간별 확인 현황"
        title="학생별 미해결 모아보기"
        description="공지·준비물·숙제에서 확인이 남은 안내를 학생별로 살펴보세요."
      />
      {bootstrap === undefined ? (
        <AsyncStatePanel
          kind={error === undefined ? "loading" : "error"}
          title={error === undefined ? "현재 반을 확인하고 있어요" : "현황을 조회할 수 없어요"}
          {...(error === undefined ? {} : { description: error })}
          action={
            error === undefined ? undefined : (
              <button
                className="ui-button ui-button-primary min-h-11 text-sm"
                onClick={() => {
                  setError(undefined);
                  setBootstrapAttempt((attempt) => attempt + 1);
                }}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={16} />
                다시 불러오기
              </button>
            )
          }
        />
      ) : (
        <FollowupsQuery bootstrap={bootstrap} />
      )}
    </AppShell>
  );
}
