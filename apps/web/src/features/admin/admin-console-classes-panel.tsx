import { ChevronLeft, ChevronRight, School, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

import {
  listAdminClasses,
  type AdminClassList,
  type AdminClassStatus,
} from "../../api/admin-directory";
import { adminErrorMessage, formatDateTime, LoadState, PanelFrame } from "./admin-console-shared";
import {
  ADMIN_SESSION_CLEAR_SIGNAL,
  ADMIN_SESSION_EXPIRED_EVENT,
} from "../../lib/admin-session-privacy";

const STATUS_LABELS: Record<string, string> = {
  active: "운영 중",
  suspended: "정지",
  archived: "지난 반",
};

/** 학교·반 목록(2026-09-30 사용자 요청): 반 정보·담임·인원 수만 보이고 학생 개인 정보는 없다. */
export function ClassesPanel(): React.JSX.Element {
  const [searchDraft, setSearchDraft] = useState("");
  const [filters, setFilters] = useState<{
    search?: string | undefined;
    status?: AdminClassStatus | undefined;
  }>({});
  const [page, setPage] = useState(1);
  const [loadedList, setList] = useState<AdminClassList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const ended = useRef(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const context = useRef({ filters, page });
  const loadedContext = useRef<{ filters: typeof filters; page: number } | undefined>(undefined);
  context.current = { filters, page };
  const list =
    loadedContext.current?.filters === filters && loadedContext.current.page === page
      ? loadedList
      : undefined;
  useEffect(() => {
    ended.current = false;
    const end = (): void => {
      ended.current = true;
      generation.current += 1;
      flight.current?.abort();
      setList(undefined);
      setError(undefined);
      setLoading(false);
    };
    const storage = (event: StorageEvent): void => {
      if (event.key === ADMIN_SESSION_CLEAR_SIGNAL && event.newValue !== null) end();
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, end);
    window.addEventListener("storage", storage);
    return () => {
      ended.current = true;
      generation.current += 1;
      flight.current?.abort();
      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, end);
      window.removeEventListener("storage", storage);
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (ended.current) return;
    const request = ++generation.current;
    flight.current?.abort();
    const controller = new AbortController();
    flight.current = controller;
    const isCurrent = (): boolean =>
      !ended.current &&
      !controller.signal.aborted &&
      request === generation.current &&
      context.current.filters === filters &&
      context.current.page === page;
    setLoading(true);
    setList(undefined);
    setError(undefined);
    try {
      const result = await listAdminClasses(
        { page, ...filters },
        { signal: controller.signal, isCurrent },
      );
      if (isCurrent()) {
        loadedContext.current = { filters, page };
        setList(result);
      }
    } catch (requestError) {
      if (!isCurrent()) return;
      setError(adminErrorMessage(requestError, "반 목록을 불러오지 못했습니다."));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [filters, page]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      flight.current?.abort();
    };
  }, [load]);

  const lastPage = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.page_size));
  const search = searchDraft.trim();

  return (
    <PanelFrame
      description="전체 반을 최근 만든 순으로 봅니다. 담임 이름과 인원 수만 보이며 학생 이름·활동 내용은 나오지 않습니다."
      icon={School}
      title="학교·반 목록"
    >
      <form
        className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setFilters((current) => ({
            ...current,
            ...(search.length >= 2 ? { search } : { search: undefined }),
          }));
        }}
      >
        <div>
          <label className="auth-label" htmlFor="class-search">
            학교 이름 또는 반 이름 · 2자 이상(비우면 전체)
          </label>
          <input
            className="ui-input"
            id="class-search"
            onChange={(event) => setSearchDraft(event.target.value)}
            value={searchDraft}
          />
        </div>
        <div>
          <label className="auth-label" htmlFor="class-status-filter">
            상태
          </label>
          <select
            className="ui-input"
            id="class-status-filter"
            onChange={(event) => {
              const value = event.target.value as AdminClassStatus | "";
              setPage(1);
              setFilters((current) => ({ ...current, status: value === "" ? undefined : value }));
            }}
            value={filters.status ?? ""}
          >
            <option value="">전체</option>
            <option value="active">운영 중</option>
            <option value="suspended">정지</option>
            <option value="archived">지난 반</option>
          </select>
        </div>
        <button
          className="ui-button ui-button-primary h-[3.375rem]"
          disabled={loading || search.length === 1}
          type="submit"
        >
          <Search aria-hidden="true" size={18} /> 검색
        </button>
      </form>
      <LoadState
        error={error}
        loading={loading && list === undefined}
        onRetry={() => void load()}
      />
      {list === undefined ? null : (
        <>
          <p className="mt-5 text-sm font-semibold text-app-muted" role="status">
            {list.total}개 반{list.total > 0 ? ` · ${page}/${lastPage}쪽` : ""}
          </p>
          {list.classes.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
              조건에 맞는 반이 없습니다.
            </p>
          ) : (
            <div
              aria-label="학교·반 목록 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-3 overflow-x-auto rounded-card border border-app-border"
            >
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                  <tr>
                    <th className="px-3 py-2.5" scope="col">
                      학교
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      반
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      담임
                    </th>
                    <th className="px-3 py-2.5 text-right" scope="col">
                      학생
                    </th>
                    <th className="px-3 py-2.5 text-right" scope="col">
                      참여 대기
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      상태
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      만든 날
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.classes.map((row) => (
                    <tr className="border-t border-app-border" key={row.id}>
                      <td className="px-3 py-2.5">
                        <span className="font-bold text-app-text">{row.school_name}</span>
                        <span className="block text-xs text-app-muted">{row.region_name}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="font-semibold text-app-text">{row.name}</span>
                        <span className="block text-xs text-app-muted">
                          {row.academic_year}년 {row.grade}학년
                        </span>
                      </td>
                      <td className="px-3 py-2.5">{row.teacher_name ?? "없음"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{row.students}</td>
                      <td
                        className={
                          "px-3 py-2.5 text-right tabular-nums " +
                          (row.pending_members > 0 ? "font-bold text-danger-text" : "")
                        }
                      >
                        {row.pending_members}
                      </td>
                      <td className="px-3 py-2.5">{STATUS_LABELS[row.status] ?? row.status}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {formatDateTime(row.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lastPage > 1 ? (
            <nav aria-label="반 목록 쪽" className="mt-3 flex items-center justify-end gap-2">
              <button
                className="ui-button ui-button-secondary text-sm"
                disabled={loading || page <= 1}
                onClick={() => setPage((current) => current - 1)}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={17} /> 이전
              </button>
              <button
                className="ui-button ui-button-secondary text-sm"
                disabled={loading || page >= lastPage}
                onClick={() => setPage((current) => current + 1)}
                type="button"
              >
                다음 <ChevronRight aria-hidden="true" size={17} />
              </button>
            </nav>
          ) : null}
        </>
      )}
    </PanelFrame>
  );
}
