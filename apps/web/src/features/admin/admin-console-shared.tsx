import { CheckCircle2, LoaderCircle, RefreshCw, type LucideIcon } from "lucide-react";
import type * as React from "react";
import { Link } from "react-router";

import type { AdminRole } from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";

export const ROLE_LABELS: Record<AdminRole, string> = {
  account_manager: "계정 관리자",
  security_auditor: "보안 감사자",
  super_admin: "최고 관리자",
  support: "지원 담당자",
};
export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function adminErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "ADMIN_STEP_UP_REQUIRED") {
      return "중요 작업 보안 확인이 만료됐습니다. 작성한 내용을 확인하고 다시 시도해 주세요.";
    }
    if (error.status === 401) return "관리자 세션이 끝났습니다. 다시 로그인해 주세요.";
    if (error.status === 403) return "이 작업을 수행할 관리자 권한이 없습니다.";
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function PanelFrame({
  children,
  description,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  description: string;
  icon: LucideIcon;
  title: string;
}): React.JSX.Element {
  return (
    <section className="ui-panel">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-control bg-role-soft text-role-primary">
          <Icon aria-hidden="true" size={21} />
        </span>
        <div className="min-w-0">
          <h2 className="ui-section-title">{title}</h2>
          <p className="mt-1 break-keep text-sm leading-6 text-app-muted [overflow-wrap:anywhere]">
            {description}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function LoadState({
  error,
  loading,
  onRetry,
}: {
  error: string | undefined;
  loading: boolean;
  onRetry: () => void;
}): React.JSX.Element | null {
  if (loading) {
    return (
      <p
        className="mt-6 flex min-h-28 items-center justify-center gap-2 rounded-card bg-app-surface-muted px-4 py-6 text-sm font-semibold text-app-muted"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="animate-spin" size={19} /> 자료를 불러오고
        있어요.
      </p>
    );
  }
  if (error === undefined) return null;
  return (
    <div
      className="mt-6 rounded-card border border-danger-border bg-danger-surface p-4 text-sm font-semibold leading-6 text-danger-text"
      role="alert"
    >
      <p>{error}</p>
      <button
        className="ui-button ui-button-secondary mt-3 text-sm"
        onClick={onRetry}
        type="button"
      >
        <RefreshCw aria-hidden="true" size={17} /> 다시 시도
      </button>
    </div>
  );
}

export function InlineNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      aria-live="polite"
      className="mt-4 flex items-start gap-2 rounded-card border border-success-border bg-success-surface px-4 py-3 text-sm font-semibold leading-6 text-success-text"
      role="status"
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={18} /> {children}
    </p>
  );
}

/**
 * 저장 실패는 양식 옆에만 보인다. 불러오기 실패(LoadState)와 같은 상자를 쓰면 목록·양식이 통째로
 * 사라지고 '다시 시도'가 저장이 아니라 새로고침이 됐다(총검수 C3-03).
 */
export function ActionError({
  message,
}: {
  message: string | undefined;
}): React.JSX.Element | null {
  if (message === undefined) return null;
  return (
    <p
      className="mt-3 rounded-card border border-danger-border bg-danger-surface px-4 py-3 text-sm font-semibold leading-6 text-danger-text"
      role="alert"
    >
      {message}
    </p>
  );
}

export function StepUpHint(): React.JSX.Element {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-card border border-warning-border bg-warning-surface px-4 py-3 text-sm leading-6 text-warning-text sm:flex-row sm:items-center sm:justify-between">
      <p className="hidden break-keep sm:block">
        로그인은 상단에서 30분씩 연장할 수 있습니다. 중요 변경에는 별도 보안 확인이 필요하며 확인 후
        5분 동안 유효합니다.
      </p>
      {/* 메뉴의 '관리자 계정'(다른 관리자 관리)과 헷갈리지 않게 상단 메뉴와 같은 이름(총검수 C3-05). */}
      <Link className="ui-button ui-button-secondary shrink-0 text-sm" to="/admin/account">
        계정·보안
      </Link>
    </div>
  );
}
