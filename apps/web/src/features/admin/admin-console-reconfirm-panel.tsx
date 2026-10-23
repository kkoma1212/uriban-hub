import { Download, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  getAdminReconfirmReport,
  type AdminReconfirmCounts,
  type AdminReconfirmReport,
} from "../../api/admin-directory";
import { saveBlobAsFile } from "../../lib/save-blob";
import { adminErrorMessage, LoadState, PanelFrame } from "./admin-console-shared";

/*
 * 시범 판정 지표(2026-10-22 사용자 결정, 전략서 '압도 조건 2'): 공지·준비물을 고친 뒤 수정 전에 이미 확인한
 * 학생이 24시간 안에 새 내용을 다시 확인했는가. 숫자만 보이고 학생 이름·번호는 없다. 확인 기록은 학생마다
 * 마지막 상태만 남아 같은 글을 여러 번 고치면 마지막 수정만 센다(앞선 수정은 제외 수로만 보인다).
 */
const SUMMARY: ReadonlyArray<{ key: keyof AdminReconfirmCounts; label: string }> = [
  { key: "revisions", label: "센 수정" },
  { key: "eligible", label: "대상 학생(연인원)" },
  { key: "reconfirmed_within_window", label: "24시간 안 재확인" },
  { key: "reconfirmed_total", label: "지금까지 재확인" },
  { key: "earlier_revisions_excluded", label: "앞선 수정(제외)" },
];

const rateText = (counts: AdminReconfirmCounts): string =>
  counts.eligible === 0
    ? "—"
    : `${Math.round((counts.reconfirmed_within_window / counts.eligible) * 100)}%`;

// 교사가 지은 반 이름이 엑셀에서 수식으로 실행되지 않게 막고, 쉼표·따옴표는 감싼다.
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const kstText = (iso: string): string =>
  new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

function downloadReconfirmCsv(report: AdminReconfirmReport): void {
  const classes = new Map(report.classes.map((row) => [row.id, row]));
  const lines = [
    "학교,반,종류,글 번호,판,고친 시각(한국),대상 학생,24시간 안 재확인,지금까지 재확인",
    ...report.events.map((event) =>
      [
        classes.get(event.class_id)?.school_name ?? "",
        classes.get(event.class_id)?.name ?? event.class_id,
        event.kind === "notice" ? "공지" : "준비물·숙제",
        event.item_id,
        event.revision,
        kstText(event.revised_at),
        event.eligible,
        event.reconfirmed_within_window,
        event.reconfirmed_total,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  saveBlobAsFile(
    new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }),
    `uriban-hub-reconfirm-${report.from}_${report.to}.csv`,
  );
}

export function ReconfirmReportPanel(): React.JSX.Element {
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [report, setReport] = useState<AdminReconfirmReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (period: { from?: string; to?: string }): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await getAdminReconfirmReport(period);
      setReport(next);
      setDraft({ from: next.from, to: next.to });
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "재확인 지표를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load({});
  }, [load]);

  return (
    <PanelFrame
      description="공지·준비물을 고친 뒤, 고치기 전에 이미 확인한 학생 가운데 24시간 안에 새 내용을 다시 확인한 비율입니다. 숫자만 보이고 학생 이름은 나오지 않습니다."
      icon={RotateCcw}
      title="재확인 지표"
    >
      <form
        className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void load(draft);
        }}
      >
        <div>
          <label className="auth-label" htmlFor="reconfirm-from">
            시작일
          </label>
          <input
            className="auth-input"
            id="reconfirm-from"
            max={draft.to || undefined}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            type="date"
            value={draft.from}
          />
        </div>
        <div>
          <label className="auth-label" htmlFor="reconfirm-to">
            종료일
          </label>
          <input
            className="auth-input"
            id="reconfirm-to"
            min={draft.from || undefined}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            type="date"
            value={draft.to}
          />
        </div>
        <button
          className="ui-button ui-button-primary h-[3.375rem]"
          disabled={loading}
          type="submit"
        >
          <Search aria-hidden="true" size={18} /> 조회
        </button>
      </form>
      <p className="mt-3 break-keep text-xs leading-5 text-app-muted">
        확인 기록은 학생마다 마지막 상태만 남아, 같은 글을 여러 번 고치면 마지막 수정만 셉니다. 오타
        수정과 중요 표시만 바꾼 수정은 세지 않습니다. 기간은 120일까지 고를 수 있어요.
      </p>
      <LoadState
        error={error}
        loading={loading && report === undefined}
        onRetry={() => void load(draft)}
      />
      {report === undefined ? null : (
        <>
          <dl
            aria-label={`${report.from}부터 ${report.to}까지 전체 합계`}
            className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
          >
            <div className="rounded-2xl bg-role-soft px-3 py-2.5">
              <dt className="text-xs font-semibold text-app-muted">24시간 안 재확인율</dt>
              <dd className="text-lg font-bold tabular-nums text-app-text">
                {rateText(report.totals)}
              </dd>
            </div>
            {SUMMARY.map((item) => (
              <div className="rounded-2xl bg-app-surface-muted px-3 py-2.5" key={item.key}>
                <dt className="text-xs font-semibold text-app-muted">{item.label}</dt>
                <dd className="text-lg font-bold tabular-nums text-app-text">
                  {report.totals[item.key]}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-app-muted" role="status">
              {report.from} ~ {report.to} · 수정이 있던 반 {report.classes.length}개
            </p>
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={report.events.length === 0}
              onClick={() => downloadReconfirmCsv(report)}
              type="button"
            >
              <Download aria-hidden="true" size={17} /> 수정별 표(CSV) 받기
            </button>
          </div>
          {report.classes.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
              이 기간에 판이 바뀐 공지·준비물이 없습니다.
            </p>
          ) : (
            <div
              aria-label="반별 재확인 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-3 overflow-x-auto rounded-card border border-app-border"
            >
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                  <tr>
                    <th className="px-3 py-2.5" scope="col">
                      학교·반
                    </th>
                    <th className="px-3 py-2.5 text-right" scope="col">
                      24시간 안 재확인율
                    </th>
                    {SUMMARY.map((item) => (
                      <th className="px-3 py-2.5 text-right" key={item.key} scope="col">
                        {item.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.classes.map((row) => (
                    <tr className="border-t border-app-border" key={row.id}>
                      <td className="px-3 py-2.5">
                        <span className="font-bold text-app-text">{row.name}</span>
                        <span className="block text-xs text-app-muted">{row.school_name}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-app-text">
                        {rateText(row)}
                      </td>
                      {SUMMARY.map((item) => (
                        <td className="px-3 py-2.5 text-right tabular-nums" key={item.key}>
                          {row[item.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </PanelFrame>
  );
}
