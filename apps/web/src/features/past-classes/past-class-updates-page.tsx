import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  listPastClasses,
  listPastClassUpdates,
  type PastClassSummary,
} from "../../api/past-classes";
import type { UpdateItem, UpdatesFilter } from "../../api/updates";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentSearchBox } from "../layout/content-search-box";
import { PageHeader } from "../layout/page-header";
import { formatKstDate } from "./past-classes-page";
import { usePastClassNavigationRole } from "./past-classes-navigation";

const FILTERS: Array<{ filter: UpdatesFilter; label: string }> = [
  { filter: "all", label: "전체" },
  { filter: "important", label: "중요" },
  { filter: "performance", label: "수행평가" },
  { filter: "homework", label: "숙제" },
  { filter: "supplies", label: "준비물·숙제" },
];

function kindLabel(item: UpdateItem): string {
  if (item.kind === "notice") return item.category === "performance" ? "수행평가 공지" : "공지";
  return item.category === "homework" ? "숙제" : "준비물";
}

type LoadState = "loading" | "ready" | "failed" | "not_found";

/** 지난 반 한 곳의 소식을 읽기 전용으로 본다. 확인·체크·수정 버튼은 두지 않는다. */
export function PastClassUpdatesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { classId = "" } = useParams();
  const [summary, setSummary] = useState<PastClassSummary>();
  const [filter, setFilter] = useState<UpdatesFilter>("all");
  const [term, setTerm] = useState<string>();
  const [items, setItems] = useState<UpdateItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  // 조건을 바꾼 뒤 늦게 도착한 이전 응답이 목록을 덮지 않게 한다.
  const generation = useRef(0);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiRequestError && error.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setState(error instanceof ApiRequestError && error.status === 404 ? "not_found" : "failed");
    },
    [navigate],
  );

  const loadFirst = useCallback(() => {
    const current = ++generation.current;
    setState("loading");
    Promise.all([listPastClasses(), listPastClassUpdates(classId, filter, undefined, term)])
      .then(([classes, page]) => {
        if (current !== generation.current) return;
        setSummary(classes.find((item) => item.class_id === classId));
        setItems(page.items);
        setNextCursor(page.next_cursor);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (current === generation.current) handleError(error);
      });
  }, [classId, filter, term, handleError]);

  useEffect(loadFirst, [loadFirst]);

  function loadMore(): void {
    if (nextCursor === null) return;
    const current = generation.current;
    setLoadingMore(true);
    listPastClassUpdates(classId, filter, nextCursor, term)
      .then((page) => {
        if (current !== generation.current) return;
        setItems((previous) => [...previous, ...page.items]);
        setNextCursor(page.next_cursor);
      })
      .catch(handleError)
      .finally(() => setLoadingMore(false));
  }

  const title =
    summary === undefined
      ? "지난 반 소식"
      : `${summary.academic_year}학년도 ${summary.grade}학년 ${summary.class_name}`;

  const navigationRole = usePastClassNavigationRole();
  return (
    <AppShell {...(navigationRole ? { navigationRole } : {})} width="medium">
      <AppShellBar
        backLabel="지난 반 기록"
        backTo="/past-classes"
        brandTo="/home"
        context="지난 반 소식"
      />
      <PageHeader
        description={
          summary === undefined
            ? "읽기 전용으로 보여요."
            : `${summary.school_name} · 읽기 전용 · ${formatKstDate(summary.visible_until)}까지 볼 수 있어요.`
        }
        eyebrow="지난 반 기록"
        title={title}
      />
      {state === "not_found" ? (
        <AsyncStatePanel
          description="보관 기간(반 종료 후 365일)이 지났거나 볼 수 없는 반이에요."
          kind="empty"
          title="이 반의 기록을 찾을 수 없어요."
        />
      ) : (
        <>
          <div aria-label="소식 종류" className="mb-3 flex flex-wrap gap-2" role="group">
            {FILTERS.map((option) => (
              <button
                aria-pressed={filter === option.filter}
                className={`min-h-11 rounded-xl px-4 text-sm font-extrabold ${
                  filter === option.filter
                    ? "bg-role-primary text-white"
                    : "border border-app-border bg-app-surface text-app-text"
                }`}
                key={option.filter}
                onClick={() => setFilter(option.filter)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mb-4">
            <ContentSearchBox
              label="지난 반 소식 검색"
              onSearch={setTerm}
              placeholder="제목·내용으로 찾기"
              searchTerm={term}
            />
          </div>
          {state === "loading" ? (
            <AsyncStatePanel kind="loading" title="지난 반 소식을 불러오고 있어요." />
          ) : state === "failed" ? (
            <AsyncStatePanel
              action={
                <button
                  className="ui-button ui-button-primary text-sm"
                  onClick={loadFirst}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={17} /> 다시 시도
                </button>
              }
              kind="error"
              title="지난 반 소식을 불러오지 못했어요."
            />
          ) : items.length === 0 ? (
            <AsyncStatePanel
              {...(term === undefined ? {} : { description: "검색어나 종류를 바꿔 보세요." })}
              kind="empty"
              title="보여 줄 소식이 없어요."
            />
          ) : (
            <>
              <ul aria-label="지난 반 소식 목록" className="grid gap-3">
                {items.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    <details className="rounded-card border border-app-border bg-app-surface px-4 py-3 shadow-sm">
                      <summary className="cursor-pointer list-none">
                        <span className="block text-xs font-bold text-app-muted">
                          {kindLabel(item)}
                          {item.is_important ? " · 중요" : ""} ·{" "}
                          {item.kind === "supply" && item.needed_on !== null
                            ? `${item.needed_on} 필요`
                            : formatKstDate(item.published_at)}
                        </span>
                        <strong className="mt-1 block break-words font-extrabold text-app-text">
                          {item.title}
                        </strong>
                      </summary>
                      <p className="mt-3 whitespace-pre-wrap break-words text-sm text-app-text">
                        {item.content === null || item.content === "" ? "내용 없음" : item.content}
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
              {nextCursor === null ? null : (
                <button
                  aria-busy={loadingMore}
                  className="ui-button ui-button-secondary mt-4 h-12 w-full rounded-2xl"
                  disabled={loadingMore}
                  onClick={loadMore}
                  type="button"
                >
                  {loadingMore ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                  ) : null}
                  더 보기
                </button>
              )}
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
