import { LoaderCircle, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  deleteTeacherLibraryItem,
  listTeacherLibrary,
  type TeacherLibraryItem,
  type TeacherLibraryKind,
} from "../../api/teacher-library";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { ContentSearchBox } from "../layout/content-search-box";
import { PageHeader } from "../layout/page-header";

const KINDS: Array<{ kind: TeacherLibraryKind | undefined; label: string }> = [
  { kind: undefined, label: "전체" },
  { kind: "notice", label: "공지" },
  { kind: "supply", label: "준비물·숙제" },
];

function kindLabel(item: TeacherLibraryItem): string {
  if (item.kind === "notice") return item.category === "performance" ? "수행평가 공지" : "공지";
  return item.category === "homework" ? "숙제" : "준비물";
}

/** 새 글 쓰기는 기존 재사용 화면을 쓴다 — 지금 그 화면은 공지·숙제만 받는다. */
function reusePath(item: TeacherLibraryItem): string | undefined {
  if (item.kind === "notice") return `/updates/reuse/notice/${item.id}?from=library`;
  if (item.category === "homework") return `/updates/reuse/homework/${item.id}?from=library`;
  return undefined;
}

const currentKstYear = Number(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()),
);

/** S2 교사 자료함: 담아 둔 글을 찾아 다시 쓰거나 지운다. 고치기는 없다. */
export function TeacherLibraryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [kind, setKind] = useState<TeacherLibraryKind>();
  const [year, setYear] = useState<number>();
  const [term, setTerm] = useState<string>();
  const [items, setItems] = useState<TeacherLibraryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "forbidden">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleting, setDeleting] = useState<TeacherLibraryItem>();
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiRequestError && error.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setState(error instanceof ApiRequestError && error.status === 403 ? "forbidden" : "failed");
    },
    [navigate],
  );

  const filters = useCallback(
    (cursor?: string) => ({
      ...(kind === undefined ? {} : { kind }),
      ...(year === undefined ? {} : { year }),
      ...(term === undefined ? {} : { q: term }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
    [kind, year, term],
  );

  const loadFirst = useCallback(() => {
    const current = ++generation.current;
    setState("loading");
    listTeacherLibrary(filters())
      .then((page) => {
        if (current !== generation.current) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (current === generation.current) handleError(error);
      });
  }, [filters, handleError]);

  useEffect(loadFirst, [loadFirst]);

  function loadMore(): void {
    if (nextCursor === null) return;
    const current = generation.current;
    setLoadingMore(true);
    listTeacherLibrary(filters(nextCursor))
      .then((page) => {
        if (current !== generation.current) return;
        setItems((previous) => [...previous, ...page.items]);
        setNextCursor(page.next_cursor);
      })
      .catch(handleError)
      .finally(() => setLoadingMore(false));
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    setDeleting(undefined);
    if (target === undefined) return;
    try {
      await deleteTeacherLibraryItem(target.id);
      setItems((previous) => previous.filter((item) => item.id !== target.id));
      setNotice(`'${target.title}'을(를) 자료함에서 지웠어요.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "지우지 못했어요.");
    }
  }

  const years = Array.from({ length: currentKstYear - 2019 }, (_, index) => currentKstYear - index);

  return (
    <AppShell navigationRole="teacher" width="medium">
      <AppShellBar backLabel="더보기" backTo="/more" brandTo="/home" context="자료함" />
      <PageHeader
        description="담아 둔 공지·준비물 글이에요. 반이 끝나도, 학교를 옮겨도 남아요."
        eyebrow="선생님 기록"
        title="자료함"
      />
      {state === "forbidden" ? (
        <AsyncStatePanel kind="empty" title="선생님 계정만 자료함을 쓸 수 있어요." />
      ) : (
        <>
          <div aria-label="자료 종류" className="mb-3 flex flex-wrap gap-2" role="group">
            {KINDS.map((option) => (
              <button
                aria-pressed={kind === option.kind}
                className={`min-h-11 rounded-xl px-4 text-sm font-extrabold ${
                  kind === option.kind
                    ? "bg-role-primary text-white"
                    : "border border-app-border bg-app-surface text-app-text"
                }`}
                key={option.label}
                onClick={() => setKind(option.kind)}
                type="button"
              >
                {option.label}
              </button>
            ))}
            <label className="sr-only" htmlFor="library-year">
              학년도
            </label>
            <select
              className="min-h-11 rounded-xl border border-app-border bg-app-surface px-3 text-sm font-bold"
              id="library-year"
              onChange={(event) =>
                setYear(event.target.value === "" ? undefined : Number(event.target.value))
              }
              value={year ?? ""}
            >
              <option value="">모든 학년도</option>
              {years.map((option) => (
                <option key={option} value={option}>
                  {option}학년도
                </option>
              ))}
            </select>
          </div>
          <div className="mb-4">
            <ContentSearchBox
              label="자료함 검색"
              onSearch={setTerm}
              placeholder="제목·내용으로 찾기"
              searchTerm={term}
            />
          </div>
          {notice === undefined ? null : (
            <p className="mb-3 text-sm font-bold text-app-text" role="status">
              {notice}
            </p>
          )}
          {state === "loading" ? (
            <AsyncStatePanel kind="loading" title="자료함을 불러오고 있어요." />
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
              title="자료함을 불러오지 못했어요."
            />
          ) : items.length === 0 ? (
            <AsyncStatePanel
              description="공지·준비물 상세나 지난 반 기록에서 '자료함에 담기'를 눌러 보세요."
              kind="empty"
              title="담아 둔 자료가 없어요."
            />
          ) : (
            <>
              <ul aria-label="자료 목록" className="grid gap-3">
                {items.map((item) => {
                  const reuse = reusePath(item);
                  return (
                    <li
                      className="rounded-card border border-app-border bg-app-surface px-4 py-3 shadow-sm"
                      key={item.id}
                    >
                      <details>
                        <summary className="cursor-pointer list-none">
                          <span className="block text-xs font-bold text-app-muted">
                            {kindLabel(item)}
                            {item.is_important ? " · 중요" : ""} · {item.source.academic_year}학년도{" "}
                            {item.source.school_name} {item.source.grade}학년{" "}
                            {item.source.class_name}
                          </span>
                          <strong className="mt-1 block break-words font-extrabold text-app-text">
                            {item.title}
                          </strong>
                        </summary>
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-app-text">
                          {item.body ?? "내용 없음"}
                        </p>
                      </details>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {reuse === undefined ? null : (
                          <Link
                            className="ui-button ui-button-primary min-h-11 gap-1.5 px-3 text-sm"
                            to={reuse}
                          >
                            <PenLine aria-hidden="true" size={17} /> 이 자료로 새 글 쓰기
                          </Link>
                        )}
                        <button
                          className="ui-button ui-button-tertiary min-h-11 gap-1.5 px-3 text-sm"
                          onClick={() => setDeleting(item)}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={17} /> 지우기
                        </button>
                      </div>
                    </li>
                  );
                })}
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
      <ConfirmDialog
        confirmLabel="지우기"
        confirmTone="danger"
        description="자료함에서만 지워지고, 원래 반의 글은 그대로예요. 지운 자료는 되살릴 수 없어요."
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => void confirmDelete()}
        open={deleting !== undefined}
        title="이 자료를 지울까요?"
      />
    </AppShell>
  );
}
