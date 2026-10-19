import { ArrowRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import { listPastClasses, type PastClassSummary } from "../../api/past-classes";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import { usePastClassNavigationRole } from "./past-classes-navigation";

export function formatKstDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "numeric",
    month: "long",
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).format(new Date(value));
}

/** 내가 속했던 지난 반 목록(읽기 전용). 학년도별로 묶고 연도로 거를 수 있다. */
export function PastClassesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [items, setItems] = useState<PastClassSummary[]>();
  const [failed, setFailed] = useState(false);
  const [year, setYear] = useState<number>();
  const navigationRole = usePastClassNavigationRole();

  const load = useCallback(() => {
    setFailed(false);
    listPastClasses()
      .then(setItems)
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setFailed(true);
      });
  }, [navigate]);

  useEffect(load, [load]);

  const years = [...new Set((items ?? []).map((item) => item.academic_year))];
  const shown = (items ?? []).filter((item) => year === undefined || item.academic_year === year);

  return (
    <AppShell {...(navigationRole ? { navigationRole } : {})} width="medium">
      <AppShellBar backLabel="홈" backTo="/home" brandTo="/home" context="지난 반 기록" />
      <PageHeader
        description="반 운영이 끝난 뒤 365일이 지나기 전까지 그 반의 소식을 읽기 전용으로 다시 볼 수 있어요."
        eyebrow="기록"
        title="지난 반 기록"
      />
      {items === undefined && !failed ? (
        <AsyncStatePanel kind="loading" title="지난 반을 불러오고 있어요." />
      ) : failed ? (
        <AsyncStatePanel
          action={
            <button className="ui-button ui-button-primary text-sm" onClick={load} type="button">
              <RefreshCw aria-hidden="true" size={17} /> 다시 시도
            </button>
          }
          kind="error"
          title="지난 반을 불러오지 못했어요."
        />
      ) : shown.length === 0 ? (
        <AsyncStatePanel
          description="반 운영이 끝난 반이 생기면 종료 후 365일이 지나기 전까지 여기에 보여요."
          kind="empty"
          title="다시 볼 지난 반이 없어요."
        />
      ) : (
        <>
          {years.length > 1 ? (
            <div aria-label="학년도" className="mb-4 flex flex-wrap gap-2" role="group">
              {[undefined, ...years].map((option) => (
                <button
                  aria-pressed={year === option}
                  className={`min-h-11 rounded-xl px-4 text-sm font-extrabold ${
                    year === option
                      ? "bg-role-primary text-white"
                      : "border border-app-border bg-app-surface text-app-text"
                  }`}
                  key={option ?? "all"}
                  onClick={() => setYear(option)}
                  type="button"
                >
                  {option === undefined ? "전체" : `${option}학년도`}
                </button>
              ))}
            </div>
          ) : null}
          <ul aria-label="지난 반 목록" className="grid gap-3">
            {shown.map((item) => (
              <li key={item.class_id}>
                <Link
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-card border border-app-border bg-app-surface px-4 py-4 shadow-sm transition hover:border-role-border hover:bg-role-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
                  to={`/past-classes/${item.class_id}`}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-app-muted">
                      {item.academic_year}학년도 · {item.school_name} ·{" "}
                      {item.role === "teacher" ? "담임" : "학생"}
                    </span>
                    <strong className="mt-1 block break-words text-base font-extrabold text-app-text">
                      {item.grade}학년 {item.class_name}
                    </strong>
                    <span className="mt-1 block text-xs text-app-muted">
                      {formatKstDate(item.visible_until)}까지 볼 수 있어요.
                    </span>
                  </span>
                  <ArrowRight aria-hidden="true" className="text-app-muted" size={18} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </AppShell>
  );
}
