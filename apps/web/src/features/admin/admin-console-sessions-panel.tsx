import { ChevronLeft, ChevronRight, KeyRound, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  listAdminSessions,
  revokeAdminSession,
  type AdminSessionKind,
  type AdminSessionList,
} from "../../api/admin-operations";
import {
  adminErrorMessage,
  formatDateTime,
  InlineNotice,
  LoadState,
  PanelFrame,
  StepUpHint,
} from "./admin-console-shared";

const Th = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <th className="px-3 py-2.5" scope="col">
    {children}
  </th>
);

interface RevokeTarget {
  id: string;
  kind: AdminSessionKind;
  label: string;
}

/**
 * 로그인 세션(2026-09-30): 지금 열려 있는 관리자·사용자 세션. 강제 종료는 최고 관리자만, 운영 DB에
 * 종료 기록값(원장 98)이 설치된 뒤에만 보인다. 사유는 관리자 작업 기록에 남는다.
 */
export function SessionsPanel({ canRevoke = false }: { canRevoke?: boolean }): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [list, setList] = useState<AdminSessionList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState<RevokeTarget>();
  const [reason, setReason] = useState("");
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setList(await listAdminSessions(page));
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "로그인 세션을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [page]);
  useEffect(() => {
    void load();
  }, [load]);

  const revokable = canRevoke && list?.revoke_enabled === true;
  const trimmedReason = reason.trim();

  async function submitRevoke(): Promise<void> {
    if (target === undefined || trimmedReason.length === 0) return;
    setRevoking(true);
    setRevokeError(undefined);
    try {
      await revokeAdminSession(target.id, { kind: target.kind, reason: trimmedReason });
      setNotice(`${target.label} 세션을 끝냈습니다. 그 기기는 다음 요청부터 로그아웃됩니다.`);
      setTarget(undefined);
      setReason("");
      await load();
    } catch (requestError) {
      setRevokeError(adminErrorMessage(requestError, "세션을 끝내지 못했습니다."));
    } finally {
      setRevoking(false);
    }
  }

  const revokeButton = (next: RevokeTarget): React.JSX.Element => (
    <button
      aria-label={`${next.label} 세션 종료`}
      className="ui-button ui-button-secondary text-xs"
      onClick={() => {
        setNotice(undefined);
        setRevokeError(undefined);
        setReason("");
        setTarget(next);
      }}
      type="button"
    >
      <LogOut aria-hidden="true" size={14} /> 종료
    </button>
  );

  const lastPage =
    list === undefined ? 1 : Math.max(1, Math.ceil(list.user_total / list.page_size));

  return (
    <PanelFrame
      description="지금 로그인 중인 관리자·사용자 세션입니다. 접속 주소는 보이지 않고 기기는 브라우저·운영체제만 줄여 보입니다."
      icon={KeyRound}
      title="로그인 세션"
    >
      <LoadState
        error={error}
        loading={loading && list === undefined}
        onRetry={() => void load()}
      />
      {list === undefined ? null : (
        <>
          <div className="mt-4 flex justify-end">
            <button
              aria-busy={loading}
              className="ui-button ui-button-secondary text-xs"
              disabled={loading}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} /> 새로 보기
            </button>
          </div>
          {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
          {revokable ? <StepUpHint /> : null}
          {target === undefined ? null : (
            <form
              aria-label="세션 종료 확인"
              className="mt-4 rounded-card border border-danger-border bg-danger-surface p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRevoke();
              }}
            >
              <p className="text-sm font-bold text-danger-text">
                {target.label} 세션을 끝낼까요? 그 기기는 다음 요청부터 로그아웃됩니다.
              </p>
              <label className="auth-label mt-3" htmlFor="session-revoke-reason">
                사유(작업 기록에 남아요)
              </label>
              <input
                className="ui-input"
                id="session-revoke-reason"
                maxLength={300}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
              {revokeError === undefined ? null : (
                <p className="mt-2 text-sm font-bold text-danger-text" role="alert">
                  {revokeError}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="ui-button ui-button-danger text-sm"
                  disabled={revoking || trimmedReason.length === 0}
                  type="submit"
                >
                  세션 끝내기
                </button>
                <button
                  className="ui-button ui-button-secondary text-sm"
                  disabled={revoking}
                  onClick={() => setTarget(undefined)}
                  type="button"
                >
                  취소
                </button>
              </div>
            </form>
          )}
          <section aria-label="관리자 세션" className="mt-2">
            <h3 className="text-sm font-extrabold text-app-text">
              관리자 {list.admin_sessions.length}개
            </h3>
            <div
              aria-label="관리자 세션 표"
              data-admin-table-scroll
              role="region"
              tabIndex={0}
              className="mt-2 overflow-x-auto rounded-card border border-app-border"
            >
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                  <tr>
                    <Th>관리자</Th>
                    <Th>기기</Th>
                    <Th>로그인</Th>
                    <Th>마지막 활동</Th>
                    <Th>최대 유지</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.admin_sessions.map((row) => (
                    <tr className="border-t border-app-border" key={row.id}>
                      <td className="px-3 py-2.5 font-semibold text-app-text">
                        <span className="flex flex-wrap items-center gap-2">
                          {row.display_name}
                          {row.is_current ? (
                            <span className="rounded-full bg-role-soft px-2 py-0.5 text-xs font-bold text-role-primary">
                              지금 이 세션
                            </span>
                          ) : revokable ? (
                            revokeButton({ id: row.id, kind: "admin", label: row.display_name })
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">{row.device}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {formatDateTime(row.issued_at)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {formatDateTime(row.last_seen_at)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                        {formatDateTime(row.absolute_expires_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-label="사용자 세션" className="mt-5">
            <h3 className="text-sm font-extrabold text-app-text" role="status">
              선생님·학생 {list.user_total}개{list.user_total > 0 ? ` · ${page}/${lastPage}쪽` : ""}
            </h3>
            {list.user_sessions.length === 0 ? (
              <p className="mt-2 rounded-2xl bg-app-surface-muted px-4 py-6 text-center text-sm font-semibold text-app-muted">
                지금 로그인 중인 선생님·학생이 없습니다.
              </p>
            ) : (
              <div
                aria-label="사용자 세션 표"
                data-admin-table-scroll
                role="region"
                tabIndex={0}
                className="mt-2 overflow-x-auto rounded-card border border-app-border"
              >
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="bg-app-surface-muted text-xs font-bold text-app-muted">
                    <tr>
                      <Th>이름</Th>
                      <Th>메일(가림)</Th>
                      <Th>기기</Th>
                      <Th>로그인</Th>
                      <Th>만료</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.user_sessions.map((row) => (
                      <tr className="border-t border-app-border" key={row.id}>
                        <td className="min-w-[10rem] break-words px-3 py-2.5 font-semibold text-app-text">
                          {/* 종료 버튼을 이름 옆에 둬 휴대폰에서 표를 옆으로 밀지 않아도 보이게 한다. */}
                          <span className="flex flex-wrap items-center gap-2">
                            {row.display_name}
                            {revokable
                              ? revokeButton({ id: row.id, kind: "user", label: row.display_name })
                              : null}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-app-muted">{row.email_masked}</td>
                        <td className="px-3 py-2.5">{row.device}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                          {formatDateTime(row.issued_at)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-app-muted">
                          {formatDateTime(row.expires_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {lastPage > 1 ? (
              <nav aria-label="사용자 세션 쪽" className="mt-3 flex items-center justify-end gap-2">
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
          </section>
        </>
      )}
    </PanelFrame>
  );
}
