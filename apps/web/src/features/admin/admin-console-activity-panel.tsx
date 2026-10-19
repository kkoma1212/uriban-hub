import { ChartColumn, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  listAdminClassActivity,
  type AdminActivityCounts,
  type AdminActivityDays,
  type AdminClassActivityList,
} from "../../api/admin-directory";
import { adminErrorMessage, LoadState, PanelFrame } from "./admin-console-shared";

// 표 열 순서 = 합계 칸 순서. 반 대화는 기능이 꺼져 있으면 "꺼짐"으로 보인다.
const COLUMNS: ReadonlyArray<{ key: keyof AdminActivityCounts; label: string }> = [
  { key: "active_students", label: "접속 학생" },
  { key: "notices", label: "소식" },
  { key: "schedules", label: "일정" },
  { key: "supplies", label: "챙길 일" },
  { key: "attendance", label: "출결 연락" },
  { key: "polls", label: "투표" },
  { key: "help_requests", label: "도움 요청" },
  { key: "class_chat_messages", label: "반 대화" },
];

const DAY_OPTIONS: readonly AdminActivityDays[] = [7, 30];

const countText = (value: number | null): string => (value === null ? "꺼짐" : String(value));

/** 반 활동 현황(2026-09-30 사용자 요청): 운영 중인 반의 기간 건수만 보이고 글 내용·이름은 없다. */
export function ClassActivityPanel(): React.JSX.Element {
  const [days, setDays] = useState<AdminActivityDays>(7);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<AdminClassActivityList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setList(await listAdminClassActivity({ days, page }));
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "반 활동 현황을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [days, page]);
  useEffect(() => {
    void load();
  }, [load]);

  const lastPage = list === undefined ? 1 : Math.max(1, Math.ceil(list.total / list.page_size));

  return (
    <PanelFrame
      description="운영 중인 반마다 기간 안에 새로 생긴 건수만 봅니다. 글 내용·학생 이름은 나오지 않습니다."
      icon={ChartColumn}
      title="반 활동 현황"
    >
      <div aria-label="기간" className="mt-5 flex gap-2" role="group">
        {DAY_OPTIONS.map((option) => (
          <button
            aria-pressed={days === option}
            className={
              "ui-button text-sm " + (days === option ? "ui-button-primary" : "ui-button-secondary")
            }
            disabled={loading}
            key={option}
            onClick={() => {
              setPage(1);
              setDays(option);
            }}
            type="button"
          >
            최근 {option}일
          </button>
        ))}
      </div>
      <LoadState
        error={error}
        loading={loading && list === undefined}
        onRetry={() => void load()}
      />
      {list === undefined ? null : (
        <>
          <dl
            aria-label={`최근 ${list.days}일 전체 합계`}
            className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
          >
            {COLUMNS.map((column) => (
              <div className="rounded-2xl bg-app-surface-muted px-3 py-2.5" key={column.key}>
                <dt className="text-xs font-semibold text-app-muted">{column.label}</dt>
                <dd className="text-lg font-bold tabular-nums text-app-text">
                  {countText(list.totals[column.key])}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-sm font-semibold text-app-muted" role="status">
            운영 중 {list.total}개 반{list.total > 0 ? ` · ${page}/${lastPage}쪽` : ""}
          </p>
          {list.classes.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
              운영 중인 반이 없습니다.
            </p>
          ) : (
            <div
              aria-label="반 활동 현황 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-3 overflow-x-auto rounded-card border border-app-border"
            >
              <table className="w-full min-w-[54rem] text-left text-sm">
                <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                  <tr>
                    <th className="px-3 py-2.5" scope="col">
                      학교·반
                    </th>
                    <th className="px-3 py-2.5 text-right" scope="col">
                      학생
                    </th>
                    {COLUMNS.map((column) => (
                      <th className="px-3 py-2.5 text-right" key={column.key} scope="col">
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.classes.map((row) => (
                    <tr className="border-t border-app-border" key={row.id}>
                      <td className="px-3 py-2.5">
                        <span className="font-bold text-app-text">{row.name}</span>
                        <span className="block text-xs text-app-muted">{row.school_name}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{row.students}</td>
                      {COLUMNS.map((column) => (
                        <td
                          className={
                            "px-3 py-2.5 text-right tabular-nums " +
                            (row[column.key] === 0 || row[column.key] === null
                              ? "text-app-muted"
                              : "font-semibold text-app-text")
                          }
                          key={column.key}
                        >
                          {countText(row[column.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lastPage > 1 ? (
            <nav aria-label="반 활동 쪽" className="mt-3 flex items-center justify-end gap-2">
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
