import { BellRing, CheckCircle2, Download, TrendingUp, UserRoundPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  getAdminActivityTrend,
  listAdminPeople,
  type AdminActivityDays,
  type AdminActivityTrend,
  type AdminPersonRow,
} from "../../api/admin-directory";
import { adminOverviewServiceLabel, type AdminOverview } from "../../api/admin-overview";
import { saveBlobAsFile } from "../../lib/save-blob";
import { adminErrorMessage, formatDateTime, LoadState } from "./admin-console-shared";

export type DashboardTarget =
  "approvals" | "class_activity" | "inquiries" | "members" | "people" | "system";

interface DashboardLinks {
  canOpen: (target: DashboardTarget) => boolean;
  onOpen: (target: DashboardTarget) => void;
}

/** 확인할 것 띠: 0이 아닌 일만 모아 맨 위에 둔다. 누르면 해당 메뉴로(권한 있는 메뉴만). */
export function AttentionStrip({
  canOpen,
  onOpen,
  overview,
}: DashboardLinks & { overview: AdminOverview }): React.JSX.Element {
  const { server, signups, support } = overview;
  const items: Array<{ label: string; target?: DashboardTarget }> = [];
  if (signups.pending_teachers > 0)
    items.push({
      label: `승인 기다리는 선생님 ${signups.pending_teachers}명`,
      target: "approvals",
    });
  if (support.inquiries_open > 0)
    items.push({ label: `새 문의 ${support.inquiries_open}건`, target: "inquiries" });
  // 반 대화 신고는 담임이 처리하므로 바로가기 없이 수만 알린다.
  if ((support.class_chat_reports_open ?? 0) > 0)
    items.push({ label: `반 대화 열린 신고 ${support.class_chat_reports_open}건` });
  if (server.errors_last_hour > 0)
    items.push({
      label: `${adminOverviewServiceLabel(server)} 최근 1시간 오류 ${server.errors_last_hour}건`,
      target: "system",
    });
  if (server.database_ms === null) items.push({ label: "DB 응답 없음", target: "system" });
  if (!server.redis_ok) items.push({ label: "세션 저장소 응답 없음", target: "system" });
  if (server.maintenance_mode === null)
    items.push({ label: "점검 모드 확인 불가", target: "system" });
  if (server.maintenance_mode === true) items.push({ label: "점검 모드 켜짐", target: "system" });

  if (items.length === 0)
    return (
      <p
        className="mt-4 flex items-center gap-2 rounded-card bg-app-surface-muted px-4 py-3 text-sm font-semibold text-app-muted"
        role="status"
      >
        <CheckCircle2 aria-hidden="true" size={17} /> 지금 확인할 것이 없습니다.
      </p>
    );
  return (
    <section
      aria-label="확인할 것"
      className="mt-4 rounded-card border border-warning-border bg-warning-surface px-4 py-3"
    >
      <h3 className="flex items-center gap-2 text-sm font-extrabold text-warning-text">
        <BellRing aria-hidden="true" size={17} /> 확인할 것 {items.length}가지
      </h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.label}>
            {item.target !== undefined && canOpen(item.target) ? (
              <button
                className="ui-button ui-button-secondary text-xs"
                onClick={() => onOpen(item.target!)}
                type="button"
              >
                {item.label} →
              </button>
            ) : (
              <span className="inline-flex min-h-9 items-center rounded-full bg-app-surface px-3 text-xs font-bold text-app-text">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const shortDate = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;

/** 막대 하나당 하루. 가입과 활동은 크기가 달라 한 축에 섞지 않고 작은 그래프 두 개로 나눈다. */
function DailyBars({
  hint,
  label,
  series,
  unit,
  valueOf,
}: {
  hint?: string;
  label: string;
  series: AdminActivityTrend["series"];
  unit: string;
  valueOf: (point: AdminActivityTrend["series"][number]) => number;
}): React.JSX.Element {
  const values = series.map(valueOf);
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    <figure className="min-w-0 rounded-card border border-app-border bg-app-surface p-4">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-extrabold text-app-text">{label}</span>
          {hint === undefined ? null : <span className="block text-xs text-app-muted">{hint}</span>}
        </span>
        <span className="whitespace-nowrap text-xs font-semibold text-app-muted">
          합계 <strong className="text-base tabular-nums text-app-text">{total}</strong>
          {unit}
        </span>
      </figcaption>
      <div
        aria-hidden="true"
        className="mt-3 flex h-28 items-end gap-0.5 border-b border-app-border"
      >
        {series.map((point, index) => (
          <div className="admin-trend-bar" key={point.date}>
            <div style={{ height: values[index] === 0 ? 0 : `${(values[index]! / max) * 100}%` }} />
            <span className="admin-trend-tooltip">
              {shortDate(point.date)} · {values[index]}
              {unit}
            </span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between text-xs text-app-muted">
        <span>{shortDate(series[0]!.date)}</span>
        <span>{shortDate(series[series.length - 1]!.date)}</span>
      </div>
    </figure>
  );
}

function downloadTrendCsv(trend: AdminActivityTrend): void {
  // 날짜·숫자만 담는다(개인 정보 없음). 엑셀 한글 깨짐을 막으려 BOM을 붙인다.
  const lines = [
    "날짜,새 가입,새 활동",
    ...trend.series.map((point) => `${point.date},${point.signups},${point.activity}`),
  ];
  saveBlobAsFile(
    new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }),
    `uriban-hub-daily-${trend.from}_${trend.to}.csv`,
  );
}

/** 기간 추이: 최근 7·30일 하루마다 새 가입·새 활동(모든 반 합계). CSV로 받을 수 있다. */
export function TrendSection(): React.JSX.Element {
  const [days, setDays] = useState<AdminActivityDays>(7);
  const [trend, setTrend] = useState<AdminActivityTrend>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setTrend(await getAdminActivityTrend(days));
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "기간 추이를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => {
    void load();
  }, [load]);

  const allZero =
    !loading &&
    error === undefined &&
    trend !== undefined &&
    trend.series.length > 0 &&
    trend.series.every((point) => point.signups === 0 && point.activity === 0);
  const charts =
    trend === undefined ? null : (
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DailyBars
          label="새 가입"
          series={trend.series}
          unit="명"
          valueOf={(point) => point.signups}
        />
        <DailyBars
          hint="소식·일정·챙길 일·출결·투표·도움 요청·반 대화"
          label="새 활동"
          series={trend.series}
          unit="건"
          valueOf={(point) => point.activity}
        />
      </div>
    );

  return (
    <section aria-label="기간 추이" className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-text">
          <TrendingUp aria-hidden="true" size={17} /> 기간 추이
        </h3>
        <div className="flex flex-wrap gap-2">
          <div aria-label="기간" className="flex gap-2" role="group">
            {([7, 30] as const).map((option) => (
              <button
                aria-pressed={days === option}
                className={
                  "ui-button text-xs " +
                  (days === option ? "ui-button-primary" : "ui-button-secondary")
                }
                disabled={loading}
                key={option}
                onClick={() => setDays(option)}
                type="button"
              >
                최근 {option}일
              </button>
            ))}
          </div>
          <button
            className="ui-button ui-button-secondary text-xs"
            disabled={trend === undefined}
            onClick={() => trend && downloadTrendCsv(trend)}
            type="button"
          >
            <Download aria-hidden="true" size={15} /> CSV 받기
          </button>
        </div>
      </div>
      <LoadState
        error={error}
        loading={loading && trend === undefined}
        onRetry={() => void load()}
      />
      {trend === undefined ? null : (
        <>
          {allZero ? (
            <div className="mt-3 rounded-card border border-app-border bg-app-surface p-3">
              <p className="text-sm font-semibold text-app-text">
                {shortDate(trend.from)}부터 {shortDate(trend.to)}까지 새 가입 합계 0명 · 새 활동
                합계 0건
              </p>
              <details key={trend.from + ":" + trend.to} className="mt-1">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold text-role-primary">
                  날짜별 차트 펼치기
                </summary>
                {charts}
              </details>
            </div>
          ) : (
            charts
          )}
          {/* 표는 1px 너비를 무시하고 내용만큼 넓어지므로 가린 상자로 감싸 화면 폭을 밀지 않게 한다. */}
          <div className="sr-only">
            <table>
              <caption>
                {trend.from}부터 {trend.to}까지 날짜별 새 가입·새 활동
              </caption>
              <thead>
                <tr>
                  <th scope="col">날짜</th>
                  <th scope="col">새 가입</th>
                  <th scope="col">새 활동</th>
                </tr>
              </thead>
              <tbody>
                {trend.series.map((point) => (
                  <tr key={point.date}>
                    <th scope="row">{point.date}</th>
                    <td>{point.signups}</td>
                    <td>{point.activity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

const ROLE_TEXT = { student: "학생", teacher: "선생님" } as const;
const STATUS_TEXT = { active: "사용 중", inactive: "중지", pending: "승인 대기" } as const;
const RECENT_LIMIT = 10;

/** 최근 가입 10명: 선생님·학생 목록의 첫 쪽을 그대로 쓰므로 메일은 가려져 온다. */
export function RecentSignups({ canOpen, onOpen }: DashboardLinks): React.JSX.Element | null {
  const allowed = canOpen("people");
  const [people, setPeople] = useState<AdminPersonRow[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      setPeople((await listAdminPeople({ page: 1 })).people.slice(0, RECENT_LIMIT));
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "최근 가입을 불러오지 못했습니다."));
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return null;
  return (
    <section aria-label="최근 가입" className="mt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-extrabold text-app-text">
          <UserRoundPlus aria-hidden="true" size={17} /> 최근 가입
        </h3>
        <button
          className="ui-button ui-button-secondary text-xs"
          onClick={() => onOpen("people")}
          type="button"
        >
          전체 보기
        </button>
      </div>
      <LoadState
        error={error}
        loading={people === undefined && error === undefined}
        onRetry={() => void load()}
      />
      {people === undefined ? null : people.length === 0 ? (
        <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-6 text-center text-sm font-semibold text-app-muted">
          아직 가입한 사람이 없습니다.
        </p>
      ) : (
        <div
          aria-label="일별 추이 표"
          data-admin-table-scroll
          role="region"
          tabIndex={0}
          className="mt-3 overflow-x-auto rounded-card border border-app-border"
        >
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
              <tr>
                <th className="px-3 py-2.5" scope="col">
                  이름
                </th>
                <th className="px-3 py-2.5" scope="col">
                  메일(가림)
                </th>
                <th className="px-3 py-2.5" scope="col">
                  역할
                </th>
                <th className="px-3 py-2.5" scope="col">
                  상태
                </th>
                <th className="px-3 py-2.5" scope="col">
                  가입
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr className="border-t border-app-border" key={person.id}>
                  <td className="px-3 py-2.5 font-semibold text-app-text">{person.display_name}</td>
                  <td className="px-3 py-2.5 text-app-muted">{person.email_masked}</td>
                  <td className="px-3 py-2.5">{ROLE_TEXT[person.role]}</td>
                  <td
                    className={
                      "px-3 py-2.5 " +
                      (person.status === "pending" ? "font-bold text-danger-text" : "")
                    }
                  >
                    {STATUS_TEXT[person.status]}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                    {formatDateTime(person.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
