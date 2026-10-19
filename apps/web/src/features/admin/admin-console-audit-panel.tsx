import { Search, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type * as React from "react";

import {
  listAdminAuditLogs,
  listAdminAuthAuditLogs,
  listAdminOperationAuditLogs,
  type AdminAuditLog,
  type AdminAuthAuditLog,
  type AdminOperationAuditLog,
} from "../../api/admin-management";
import { AUDIT_ACTION_LABELS, auditActionLabel } from "./admin-audit-labels";
import {
  ActionError,
  adminErrorMessage,
  formatDateTime,
  LoadState,
  PanelFrame,
} from "./admin-console-shared";

type AuditView = "auth" | "operations" | "security";
interface AuditFilters {
  action: string;
  actor: string;
  from: string;
  resource: string;
  target: string;
  to: string;
}
const EMPTY_FILTERS: AuditFilters = {
  action: "",
  actor: "",
  from: "",
  resource: "",
  target: "",
  to: "",
};
const isEmptyFilters = (filters: AuditFilters): boolean =>
  Object.values(filters).every((value) => value === "");

export function AuditPanel(): React.JSX.Element {
  const [view, setView] = useState<AuditView>("security");
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [securityLogs, setSecurityLogs] = useState<AdminAuditLog[]>();
  const [authLogs, setAuthLogs] = useState<AdminAuthAuditLog[]>();
  const [operationLogs, setOperationLogs] = useState<AdminOperationAuditLog[]>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [moreError, setMoreError] = useState<string>();
  // 기록 종류를 바꾸면 그 종류에 없는 조건이 남지 않게 비운다.
  useEffect(() => {
    setDraft(EMPTY_FILTERS);
    // 이미 비어 있으면 같은 객체를 그대로 둬 다시 불러오지 않는다.
    setFilters((current) => (isEmptyFilters(current) ? current : EMPTY_FILTERS));
  }, [view]);

  /** offset 0은 처음부터 다시, 그 밖은 지금 목록 뒤에 다음 50건을 붙인다. */
  const load = useCallback(
    async (offset: number): Promise<void> => {
      const append = offset > 0;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      setMoreError(undefined);
      const common = {
        action: filters.action,
        from: filters.from,
        to: filters.to,
        ...(append ? { offset: String(offset) } : {}),
      };
      const merge = <T,>(current: T[] | undefined, next: T[]): T[] =>
        append && current !== undefined ? [...current, ...next] : next;
      try {
        if (view === "security") {
          const result = await listAdminAuditLogs({
            ...common,
            resource: filters.resource,
            target: filters.target,
          });
          setSecurityLogs((current) => merge(current, result.logs));
          setHasMore(result.has_more === true);
        } else if (view === "auth") {
          const result = await listAdminAuthAuditLogs({ ...common, actor: filters.actor });
          setAuthLogs((current) => merge(current, result.logs));
          setHasMore(result.has_more === true);
        } else {
          const result = await listAdminOperationAuditLogs({
            ...common,
            actor: filters.actor,
            target: filters.target,
          });
          setOperationLogs((current) => merge(current, result.logs));
          setHasMore(result.has_more === true);
        }
      } catch (requestError) {
        const message = adminErrorMessage(
          requestError,
          view === "security"
            ? "보안 이벤트를 불러오지 못했습니다."
            : view === "auth"
              ? "관리자 인증 기록을 불러오지 못했습니다."
              : "관리자 운영 기록을 불러오지 못했습니다.",
        );
        // 더 보기 실패는 이미 보이는 목록을 지우지 않고 버튼 아래에 알린다.
        if (append) setMoreError(message);
        else setError(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filters, view],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const visibleLogCount =
    view === "security"
      ? securityLogs?.length
      : view === "auth"
        ? authLogs?.length
        : operationLogs?.length;
  const visibleLogLabel =
    view === "security" ? "보안 이벤트" : view === "auth" ? "관리자 인증 기록" : "관리자 운영 기록";
  const updateDraft = (key: keyof AuditFilters, value: string): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  // 번호 칸은 숫자만 받는다(서버도 숫자만 허용).
  const digitsOnly = (value: string): string => value.replace(/[^0-9]/gu, "");

  return (
    <PanelFrame
      description="권한 차단, 로그인·MFA·보안 확인, 관리자 변경 이력을 세 원장으로 구분해 확인합니다."
      icon={ShieldAlert}
      title="감사·보안 기록"
    >
      <div
        aria-label="감사 기록 종류"
        className="mt-5 grid gap-2 rounded-2xl bg-app-surface-muted p-1.5 sm:grid-cols-3"
        role="group"
      >
        <button
          aria-pressed={view === "security"}
          className={`min-h-11 rounded-xl px-4 text-sm font-extrabold transition ${
            view === "security"
              ? "bg-app-surface text-role-primary shadow-sm"
              : "text-app-muted hover:text-app-text"
          }`}
          onClick={() => setView("security")}
          type="button"
        >
          보안 이벤트
        </button>
        <button
          aria-pressed={view === "auth"}
          className={`min-h-11 rounded-xl px-4 text-sm font-extrabold transition ${
            view === "auth"
              ? "bg-app-surface text-role-primary shadow-sm"
              : "text-app-muted hover:text-app-text"
          }`}
          onClick={() => setView("auth")}
          type="button"
        >
          관리자 인증 기록
        </button>
        <button
          aria-pressed={view === "operations"}
          className={`min-h-11 rounded-xl px-4 text-sm font-extrabold transition ${
            view === "operations"
              ? "bg-app-surface text-role-primary shadow-sm"
              : "text-app-muted hover:text-app-text"
          }`}
          onClick={() => setView("operations")}
          type="button"
        >
          관리자 운영 기록
        </button>
      </div>
      <form
        className="mt-5 grid gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({
            action: draft.action,
            actor: view === "security" ? "" : draft.actor,
            from: draft.from,
            resource: view === "security" ? draft.resource.trim() : "",
            target: view === "auth" ? "" : draft.target.trim(),
            to: draft.to,
          });
        }}
      >
        <div>
          <label className="auth-label" htmlFor="audit-action">
            작업
          </label>
          {/* 영문 내부 코드를 직접 치지 않고 한국어 이름으로 고른다(총검수 C3-12). */}
          <select
            className="ui-input"
            id="audit-action"
            onChange={(event) => updateDraft("action", event.target.value)}
            value={draft.action}
          >
            <option value="">전체</option>
            {Object.entries(AUDIT_ACTION_LABELS[view]).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {view === "security" ? (
          <div>
            <label className="auth-label" htmlFor="audit-resource">
              자원
            </label>
            <input
              className="ui-input"
              id="audit-resource"
              onChange={(event) => updateDraft("resource", event.target.value)}
              placeholder="예: admin_session (관리자 세션)"
              value={draft.resource}
            />
          </div>
        ) : (
          <div>
            <label className="auth-label" htmlFor="audit-actor">
              관리자 번호
            </label>
            <input
              className="ui-input"
              id="audit-actor"
              inputMode="numeric"
              onChange={(event) => updateDraft("actor", digitsOnly(event.target.value))}
              placeholder="예: 17"
              value={draft.actor}
            />
          </div>
        )}
        {view === "auth" ? null : (
          <div>
            <label className="auth-label" htmlFor="audit-target">
              {view === "security" ? "대상 반 번호" : "대상 ID"}
            </label>
            <input
              className="ui-input"
              id="audit-target"
              inputMode={view === "security" ? "numeric" : undefined}
              maxLength={80}
              onChange={(event) =>
                updateDraft(
                  "target",
                  view === "security" ? digitsOnly(event.target.value) : event.target.value,
                )
              }
              placeholder={view === "security" ? "예: 12" : "계정·약관·세션 번호"}
              value={draft.target}
            />
          </div>
        )}
        <div>
          <label className="auth-label" htmlFor="audit-from">
            시작일
          </label>
          <input
            className="ui-input"
            id="audit-from"
            max={draft.to || undefined}
            onChange={(event) => updateDraft("from", event.target.value)}
            type="date"
            value={draft.from}
          />
        </div>
        <div>
          <label className="auth-label" htmlFor="audit-to">
            종료일
          </label>
          <input
            className="ui-input"
            id="audit-to"
            min={draft.from || undefined}
            onChange={(event) => updateDraft("to", event.target.value)}
            type="date"
            value={draft.to}
          />
        </div>
        <button className="ui-button ui-button-primary h-[3.375rem]" type="submit">
          <Search aria-hidden="true" size={18} /> 조회
        </button>
      </form>
      <LoadState error={error} loading={loading} onRetry={() => void load(0)} />
      {!loading && error === undefined ? (
        <p className="mt-5 text-sm font-bold text-app-muted">
          {visibleLogLabel} {visibleLogCount ?? 0}건{hasMore ? " · 더 있음" : ""}
        </p>
      ) : null}
      {visibleLogCount === 0 ? (
        <p className="mt-5 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
          조건에 맞는 기록이 없습니다.
        </p>
      ) : null}
      {view !== "security" || securityLogs === undefined ? null : (
        <ol className="mt-5 grid gap-3">
          {securityLogs.map((log) => (
            <li
              className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
              key={log.id}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-black text-app-text">
                    {auditActionLabel("security", log.action)}
                  </p>
                  <p className="mt-1 break-all text-sm font-semibold text-app-muted">
                    {log.method} {log.sanitized_path}
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs font-bold text-app-muted"
                  dateTime={log.created_at}
                >
                  {formatDateTime(log.created_at)}
                </time>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">자원</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">{log.resource}</dd>
                </div>
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">실패 코드</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">
                    {log.failure_code ?? "없음"}
                  </dd>
                </div>
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">차단 사유</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">
                    {log.deny_reason ?? "없음"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
      {view !== "auth" || authLogs === undefined ? null : (
        <ol className="mt-5 grid gap-3">
          {authLogs.map((log) => (
            <li
              className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
              key={log.id}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-black text-app-text">
                    {auditActionLabel("auth", log.action)}
                  </p>
                  <p className="mt-1 break-all text-sm font-semibold text-app-muted">
                    {log.admin_account_id === null
                      ? "관리자 확인 불가"
                      : `${log.actor_display_name ?? "이름 없음"} · 관리자 번호 ${log.admin_account_id}`}
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs font-bold text-app-muted"
                  dateTime={log.created_at}
                >
                  {formatDateTime(log.created_at)}
                </time>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">거부 사유</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">
                    {log.deny_reason ?? "없음"}
                  </dd>
                </div>
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">요청 ID</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">{log.request_id}</dd>
                </div>
              </dl>
              <p className="mt-3 break-all text-xs font-semibold text-app-muted">
                이벤트 ID {log.event_id}
              </p>
            </li>
          ))}
        </ol>
      )}
      {view !== "operations" || operationLogs === undefined ? null : (
        <ol className="mt-5 grid gap-3">
          {operationLogs.map((log) => (
            <li
              className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
              key={log.id}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="break-all font-black text-app-text">
                    {auditActionLabel("operations", log.action)}
                  </p>
                  <p className="mt-1 break-all text-sm font-semibold text-app-muted">
                    {log.target_type} · {log.target_id}
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs font-bold text-app-muted"
                  dateTime={log.created_at}
                >
                  {formatDateTime(log.created_at)}
                </time>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-xl bg-app-surface-muted p-3">
                  <dt className="font-bold text-app-muted">작업 관리자</dt>
                  <dd className="mt-1 break-all font-extrabold text-app-text">
                    {log.actor_display_name ?? "이름 없음"} · 번호 {log.actor_admin_account_id}
                  </dd>
                </div>
                <div className="rounded-xl bg-app-surface-muted p-3 sm:col-span-2">
                  <dt className="font-bold text-app-muted">변경 사유</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words font-extrabold text-app-text">
                    {log.reason ?? "기록 없음"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 break-all text-xs font-semibold text-app-muted">
                요청 ID {log.request_id} · 이벤트 ID {log.event_id}
              </p>
            </li>
          ))}
        </ol>
      )}
      {hasMore && !loading && error === undefined ? (
        <div className="mt-4">
          <button
            className="ui-button ui-button-secondary min-h-11 w-full"
            disabled={loadingMore}
            onClick={() => void load(visibleLogCount ?? 0)}
            type="button"
          >
            {loadingMore ? "불러오는 중…" : "50건 더 보기"}
          </button>
          <ActionError message={moreError} />
        </div>
      ) : null}
    </PanelFrame>
  );
}
