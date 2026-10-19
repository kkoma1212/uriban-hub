import { ChevronLeft, ChevronRight, Search, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

import {
  listAdminPeople,
  type AdminPeopleList,
  type AdminPersonRole,
  type AdminPersonStatus,
} from "../../api/admin-directory";
import { adminErrorMessage, formatDateTime, LoadState, PanelFrame } from "./admin-console-shared";
import {
  ADMIN_SESSION_CLEAR_SIGNAL,
  ADMIN_SESSION_EXPIRED_EVENT,
} from "../../lib/admin-session-privacy";

const ROLE_NAMES: Record<AdminPersonRole, string> = { teacher: "선생님", student: "학생" };
const STATUS_NAMES: Record<AdminPersonStatus, string> = {
  active: "사용 중",
  pending: "승인 대기",
  inactive: "이용 중지",
};

interface PeopleFilters {
  role?: AdminPersonRole | undefined;
  search?: string | undefined;
  status?: AdminPersonStatus | undefined;
}

/** 선생님·학생 목록(2026-09-30 사용자 요청): 전체를 쪽으로 보고, 메일은 가려서 보인다. */
export function PeoplePanel(): React.JSX.Element {
  const [searchDraft, setSearchDraft] = useState("");
  const [filters, setFilters] = useState<PeopleFilters>({});
  const [page, setPage] = useState(1);
  const [loadedList, setList] = useState<AdminPeopleList>();
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
      const result = await listAdminPeople(
        { page, ...filters },
        { signal: controller.signal, isCurrent },
      );
      if (isCurrent()) {
        loadedContext.current = { filters, page };
        setList(result);
      }
    } catch (requestError) {
      if (!isCurrent()) return;
      setError(adminErrorMessage(requestError, "사용자 목록을 불러오지 못했습니다."));
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

  const changeFilter = (next: PeopleFilters): void => {
    setPage(1);
    setFilters((current) => ({ ...current, ...next }));
  };
  const lastPage = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.page_size));
  const search = searchDraft.trim();

  return (
    <PanelFrame
      description="전체 선생님·학생을 최근 가입 순으로 봅니다. 메일 주소는 가려서 보이며, 계정을 바꾸는 일은 계정 관리에서 합니다."
      icon={UsersRound}
      title="선생님·학생 목록"
    >
      <form
        className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_150px_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          changeFilter({ search: search.length >= 2 ? search : undefined });
        }}
      >
        <div>
          <label className="auth-label" htmlFor="people-search">
            이름 또는 이메일 · 2자 이상(비우면 전체)
          </label>
          <input
            className="ui-input"
            id="people-search"
            onChange={(event) => setSearchDraft(event.target.value)}
            value={searchDraft}
          />
        </div>
        <div>
          <label className="auth-label" htmlFor="people-role-filter">
            구분
          </label>
          <select
            className="ui-input"
            id="people-role-filter"
            onChange={(event) => {
              const value = event.target.value as AdminPersonRole | "";
              changeFilter({ role: value === "" ? undefined : value });
            }}
            value={filters.role ?? ""}
          >
            <option value="">전체</option>
            <option value="teacher">선생님</option>
            <option value="student">학생</option>
          </select>
        </div>
        <div>
          <label className="auth-label" htmlFor="people-status-filter">
            상태
          </label>
          <select
            className="ui-input"
            id="people-status-filter"
            onChange={(event) => {
              const value = event.target.value as AdminPersonStatus | "";
              changeFilter({ status: value === "" ? undefined : value });
            }}
            value={filters.status ?? ""}
          >
            <option value="">전체</option>
            <option value="active">사용 중</option>
            <option value="pending">승인 대기</option>
            <option value="inactive">이용 중지</option>
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
            {list.total}명{list.total > 0 ? ` · ${page}/${lastPage}쪽` : ""}
          </p>
          {list.people.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
              조건에 맞는 사용자가 없습니다.
            </p>
          ) : (
            <div
              aria-label="선생님·학생 목록 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-3 overflow-x-auto rounded-card border border-app-border"
            >
              <table className="w-full min-w-[50rem] text-left text-sm">
                <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                  <tr>
                    <th className="px-3 py-2.5" scope="col">
                      이름
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      구분
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      소속
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      상태
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      가입일
                    </th>
                    <th className="px-3 py-2.5" scope="col">
                      마지막 로그인
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.people.map((person) => (
                    <tr className="border-t border-app-border" key={person.id}>
                      <td className="px-3 py-2.5">
                        <span className="font-bold text-app-text">{person.display_name}</span>
                        <span className="block text-xs text-app-muted">{person.email_masked}</span>
                      </td>
                      <td className="px-3 py-2.5">{ROLE_NAMES[person.role]}</td>
                      <td className="px-3 py-2.5">
                        {person.class_name === null ? (
                          <span className="text-app-muted">반 없음</span>
                        ) : (
                          <>
                            <span className="font-semibold text-app-text">{person.class_name}</span>
                            <span className="block text-xs text-app-muted">
                              {person.school_name}
                            </span>
                          </>
                        )}
                      </td>
                      <td
                        className={
                          "px-3 py-2.5 " +
                          (person.status === "active" ? "" : "font-bold text-danger-text")
                        }
                      >
                        {STATUS_NAMES[person.status]}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {formatDateTime(person.created_at)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {person.last_login_at === null
                          ? "기록 없음"
                          : formatDateTime(person.last_login_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lastPage > 1 ? (
            <nav aria-label="사용자 목록 쪽" className="mt-3 flex items-center justify-end gap-2">
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
