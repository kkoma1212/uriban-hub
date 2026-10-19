import { Bug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import { getAdminClientErrors, type AdminClientErrorSummary } from "../../api/admin-operations";
import { adminErrorMessage, formatDateTime, LoadState } from "./admin-console-shared";

type Kind = AdminClientErrorSummary["kinds"][number];

const SOURCE_LABELS: Record<Kind["source"], string> = {
  chunk: "화면 파일 불러오기 실패",
  promise: "처리 안 된 오류",
  render: "화면 오류 창",
  script: "스크립트 오류",
};
const ROLE_LABELS: Record<Kind["role"], string> = {
  student: "학생",
  teacher: "교사",
  unknown: "알 수 없음",
};
const DEVICE_LABELS: Record<Kind["device"], string> = { desktop: "PC", phone: "휴대폰" };

function Th({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <th className="px-3 py-2.5" scope="col">
      {children}
    </th>
  );
}

/**
 * 휴대폰 화면 오류(T-CLIENT-ERRORS): 운영 상태 화면 안의 표. 화면 모양·오류 이름·건수만 보인다.
 * refreshKey가 바뀌면(운영 상태 '새로 보기') 함께 다시 읽는다.
 */
export function ClientErrorsSection({ refreshKey }: { refreshKey: string }): React.JSX.Element {
  const [summary, setSummary] = useState<AdminClientErrorSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setSummary(await getAdminClientErrors());
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "화면 오류를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section
      aria-labelledby="admin-client-errors-title"
      className="mt-3 rounded-card border border-app-border bg-app-surface p-4"
    >
      <h3
        className="flex items-center gap-2 text-sm font-extrabold text-app-text"
        id="admin-client-errors-title"
      >
        <Bug aria-hidden="true" size={17} /> 화면 오류(최근 {summary?.window_hours ?? 24}시간)
        {summary === undefined ? null : (
          <span className="font-bold text-app-muted">· {summary.total}건</span>
        )}
      </h3>
      <LoadState
        error={error}
        loading={loading && summary === undefined}
        onRetry={() => void load()}
      />
      {summary === undefined ? null : summary.kinds.length === 0 ? (
        <p className="mt-2 rounded-2xl bg-app-surface-muted px-3 py-3 text-sm font-semibold text-app-muted">
          최근 {summary.window_hours}시간 동안 모인 화면 오류가 없습니다.
        </p>
      ) : (
        <div
          aria-label="화면 오류 표"
          className="mt-2 overflow-x-auto rounded-card border border-app-border"
          data-admin-table-scroll
          role="region"
          tabIndex={0}
        >
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
              <tr>
                <Th>화면</Th>
                <Th>오류</Th>
                <Th>사용자</Th>
                <Th>건수</Th>
                <Th>마지막</Th>
              </tr>
            </thead>
            <tbody>
              {summary.kinds.map((kind) => (
                <tr
                  className="border-t border-app-border"
                  key={[kind.source, kind.name, kind.route, kind.role, kind.device].join("|")}
                >
                  <td className="px-3 py-2.5 font-semibold text-app-text">
                    <code className="break-all">{kind.route}</code>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block font-semibold text-app-text">{kind.name}</span>
                    <span className="text-xs text-app-muted">{SOURCE_LABELS[kind.source]}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {ROLE_LABELS[kind.role]} · {DEVICE_LABELS[kind.device]}
                  </td>
                  <td className="px-3 py-2.5 font-bold tabular-nums text-app-text">
                    {kind.count}건
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                    {formatDateTime(kind.last_seen_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs leading-5 text-app-muted">
        로그인한 화면의 오류만 모읍니다. 오류 문장·입력 내용·사람 정보는 받지 않으며, 한 시간 단위로
        묶어 약 25시간 뒤 저절로 지워집니다.
      </p>
    </section>
  );
}
