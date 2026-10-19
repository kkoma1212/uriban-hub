import { ContentPeriodForm } from "./content-period-form";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { formatKstCalendarDate } from "../../lib/kst-format";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import { shiftCalendarDate, validateContentPeriod, type ContentPeriod } from "./period-content";
import { loadStudentCatchUp, type CatchUpItem, type CatchUpResult } from "./student-catch-up-data";

function requireStudent(current: BootstrapResponse, expectedId?: string) {
  const member = current.current_membership;
  if (
    current.destination !== "HOME" ||
    member?.role !== "student" ||
    member.status !== "approved" ||
    !current.allowed_actions.includes("VIEW_CLASS") ||
    (expectedId !== undefined && member.id !== expectedId)
  )
    throw new Error("현재 반의 학생 권한을 확인해 주세요.");
}

function CatchUpGroup({
  title,
  items,
}: {
  title: string;
  items: CatchUpItem[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="text-lg font-extrabold text-app-text">
        {title} <span className="text-role-primary">{items.length}</span>
      </h3>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <article
            className="min-w-0 rounded-card border border-app-border bg-app-surface-raised p-4 sm:p-5"
            key={`${item.kind}:${item.id}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
              <span className="text-app-muted">{item.label}</span>
              <span className="rounded-full bg-role-soft px-2.5 py-1 text-role-primary">
                {item.state === "modified_unconfirmed"
                  ? "변경 후 재확인"
                  : item.state === "unread"
                    ? "미확인"
                    : "미체크"}
              </span>
            </div>
            <h4 className="mt-3 break-words text-base font-extrabold leading-6 text-app-text">
              {item.title}
            </h4>
            <p className="mt-2 text-xs font-semibold text-app-muted">
              {item.kind === "notice" ? "게시일" : "예정일"} {formatKstCalendarDate(item.date)}
            </p>
            <p className="mt-3 break-keep text-sm leading-6 text-app-muted">{item.description}</p>
            <Link
              aria-label={`${item.title} · ${item.action}`}
              className="ui-button ui-button-secondary mt-4 min-h-11 w-full px-3 text-sm"
              to={item.to}
            >
              {item.action}
              <ArrowRight aria-hidden="true" size={17} />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

function CatchUpQuery({ bootstrap }: { bootstrap: BootstrapResponse }): React.JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const today = bootstrap.server_today;
  const from = params.get("from") ?? shiftCalendarDate(today, -6);
  const to = params.get("to") ?? today;
  const [draft, setDraft] = useState<ContentPeriod>({ from, to });
  const [result, setResult] = useState<CatchUpResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const run = ++generation.current;
    const active = () => generation.current === run;
    const period = { from, to };
    setDraft(period);
    setResult(undefined);
    const invalid = validateContentPeriod(period, today);
    setError(invalid);
    if (invalid !== undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const current = await getBootstrap();
      if (!active()) return;
      requireStudent(current, bootstrap.current_membership?.id);
      if (current.server_today !== today)
        throw new Error("날짜가 바뀌었어요. 페이지를 새로고침해 주세요.");
      const loaded = await loadStudentCatchUp(period, today, active);
      if (active()) setResult(loaded);
    })()
      .catch((failure: unknown) => {
        if (!active()) return;
        if (failure instanceof ApiRequestError && failure.status === 401)
          void navigate("/login", { replace: true });
        else
          setError(
            failure instanceof Error
              ? failure.message
              : "내 안내를 불러오지 못했어요. 다시 조회해 주세요.",
          );
      })
      .finally(() => {
        if (active()) setLoading(false);
      });
    return () => {
      if (active()) generation.current += 1;
    };
  }, [attempt, bootstrap.current_membership?.id, from, navigate, to, today]);

  function editPeriod(next: ContentPeriod) {
    generation.current += 1;
    setDraft(next);
    setResult(undefined);
    setError(undefined);
    setLoading(false);
  }
  function choosePeriod(period: ContentPeriod) {
    const invalid = validateContentPeriod(period, today);
    setError(invalid);
    if (invalid !== undefined) return;
    setParams({ from: period.from, to: period.to }, { replace: true });
    setAttempt((value) => value + 1);
  }

  return (
    <div className="mt-5 space-y-5">
      <ContentPeriodForm
        busy={loading}
        onChange={editPeriod}
        onQuickSelect={choosePeriod}
        onSubmit={() => choosePeriod(draft)}
        period={draft}
        submitLabel="이 기간 보기"
        today={today}
      />
      {loading ? (
        <p aria-live="polite" className="text-sm font-semibold text-app-muted" role="status">
          내 안내를 불러오고 있어요.
        </p>
      ) : null}
      {error === undefined ? null : (
        <div
          className="rounded-card border border-app-border bg-app-surface-raised p-4 text-app-text"
          role="alert"
        >
          <p className="font-bold">안내를 모두 확인하지 못했어요</p>
          <p className="mt-2 text-sm leading-6">{error}</p>
        </div>
      )}
      {result === undefined ? null : (
        <section aria-labelledby="catch-up-results" className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold text-app-text" id="catch-up-results">
                지금 살펴볼 안내 {result.items.length}개
              </h2>
              <p className="mt-1 text-sm leading-6 text-app-muted">
                {result.period.from} ~ {result.period.to} · 내 안내 {result.total}개 중 확인·체크{" "}
                {result.checkedCount}개
              </p>
            </div>
            <button
              className="ui-button ui-button-secondary min-h-11 px-3 text-sm"
              onClick={() => choosePeriod(result.period)}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              다시 불러오기
            </button>
          </div>
          {result.items.length === 0 ? (
            <p className="rounded-card border border-app-border bg-app-surface-raised p-5 text-app-text">
              {result.total === 0
                ? "이 기간에 내 안내가 없어요."
                : "이 기간에 확인할 안내가 없어요."}
            </p>
          ) : null}
          <CatchUpGroup
            title="바뀐 안내부터 확인해요"
            items={result.items.filter((item) => item.state === "modified_unconfirmed")}
          />
          <CatchUpGroup
            title="아직 확인이 남아 있어요"
            items={result.items.filter((item) => item.state !== "modified_unconfirmed")}
          />
          <p className="text-sm leading-6 text-app-muted">
            숙제 체크는 제출을 뜻하지 않아요. 뒤로 돌아오면 같은 기간을 새로 조회해요.
          </p>
        </section>
      )}
    </div>
  );
}

export function StudentCatchUpPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then((current) => {
        if (!active) return;
        requireStudent(current);
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
      {...(bootstrap === undefined ? {} : { navigationRole: "student" as const })}
      width="wide"
    >
      <AppShellBar
        backLabel="소식으로"
        backTo="/updates"
        brandTo="/home"
        context="놓친 안내 따라잡기"
      />
      <PageHeader
        eyebrow="내가 확인할 안내"
        title="놓친 안내 따라잡기"
        description="놓친 공지·준비물·숙제를 확인해요."
      />
      {bootstrap === undefined ? (
        <AsyncStatePanel
          kind={error === undefined ? "loading" : "error"}
          title={error === undefined ? "내 안내를 확인하고 있어요" : "따라잡기를 시작할 수 없어요"}
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
        <CatchUpQuery bootstrap={bootstrap} />
      )}
    </AppShell>
  );
}
