import { LoaderCircle, Search, UserRoundCog, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";

import {
  listAdminMembers,
  listAdminUsers,
  resetAdminUserPassword,
  updateAdminMemberStatus,
  updateAdminUserStatus,
  type AdminMember,
  type AdminMemberStatus,
  type AdminUser,
} from "../../api/admin-management";
import {
  adminErrorMessage,
  formatDateTime,
  InlineNotice,
  LoadState,
  PanelFrame,
  StepUpHint,
} from "./admin-console-shared";
import { ConfirmDialog } from "../layout/confirm-dialog";

const MEMBER_STATUS_LABELS: Record<AdminMemberStatus, string> = {
  approved: "승인",
  pending: "반 참여 승인 대기",
  rejected: "거절",
  rejoin_allowed: "다시 참여 허용",
  removed: "이용 중지",
};

const MEMBER_STATUS_TRANSITIONS: Record<
  AdminMemberStatus,
  readonly Exclude<AdminMemberStatus, "pending">[]
> = {
  approved: ["removed"],
  pending: ["approved", "rejected"],
  rejected: [],
  rejoin_allowed: [],
  removed: ["rejoin_allowed"],
};
function MemberEditor({
  canWrite,
  member,
  onUpdated,
  compact = false,
}: {
  canWrite: boolean;
  member: AdminMember;
  onUpdated: (member: AdminMember) => void;
  compact?: boolean;
}): React.JSX.Element {
  const allowedStatuses = useMemo(
    () => (member.role === "student" ? MEMBER_STATUS_TRANSITIONS[member.status] : []),
    [member.role, member.status],
  );
  const [status, setStatus] = useState<Exclude<AdminMemberStatus, "pending"> | undefined>(
    allowedStatuses[0],
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 반 구성원 상태 변경은 학생의 반 자료 접근을 바꾼다 — 한 번 더 확인받는다(총검수 C2-03).
  const [confirming, setConfirming] = useState(false);
  const applyButton = useRef<HTMLButtonElement>(null);
  const reasonRequired = status !== undefined && status !== "approved";

  useEffect(() => {
    setStatus(allowedStatuses[0]);
    setReason("");
  }, [allowedStatuses]);

  async function save(): Promise<void> {
    if (
      !canWrite ||
      busy ||
      status === undefined ||
      !allowedStatuses.includes(status) ||
      (reasonRequired && reason.trim().length === 0)
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await updateAdminMemberStatus(member.id, {
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        status,
      });
      onUpdated({ ...member, ...result.member });
      setReason("");
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "학급 소속 상태를 변경하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={
        compact
          ? "border-t border-app-border py-3 first:border-t-0 first:pt-0"
          : "rounded-2xl border border-app-border bg-app-surface-raised p-4"
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {compact ? null : (
            <p className="truncate font-black text-app-text">{member.display_name}</p>
          )}
          {compact ? null : (
            <p className="mt-1 break-all text-sm font-semibold text-app-muted">{member.email}</p>
          )}
          {member.class_label === undefined ? null : (
            // 어느 반 소속인지(총검수 C2-08).
            <p className="mt-1 break-words text-sm font-bold text-app-text" data-member-class>
              {member.school_name ? `${member.school_name} · ` : ""}
              {member.class_label}
            </p>
          )}
          <p className="mt-2 text-xs font-bold text-app-muted">
            {member.role === "teacher" ? "선생님" : "학생"} · {MEMBER_STATUS_LABELS[member.status]}{" "}
            · {formatDateTime(member.status_changed_at)}
          </p>
        </div>
        {compact ? null : (
          <span
            className={`w-fit rounded-full px-3 py-1.5 text-xs font-extrabold ${member.account_active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}
          >
            {member.account_active ? "계정 사용 중" : "계정 비활성"}
          </span>
        )}
      </div>
      {canWrite && member.role === "student" && allowedStatuses.length > 0 ? (
        <details className="mt-3 border-t border-app-border">
          <summary
            className="min-h-11 cursor-pointer py-3 text-sm font-extrabold text-app-text"
            aria-label={`${member.display_name} · ${member.class_label ?? member.email} 소속 상태 변경`}
          >
            소속 상태 변경
          </summary>
          <div className="grid gap-3 pt-2 md:grid-cols-[170px_minmax(0,1fr)_auto] md:items-end">
            <div>
              <label className="auth-label" htmlFor={`member-status-${member.id}`}>
                변경할 상태
              </label>
              <select
                className="ui-input ui-input-compact"
                id={`member-status-${member.id}`}
                onChange={(event) =>
                  setStatus(event.target.value as Exclude<AdminMemberStatus, "pending">)
                }
                value={status ?? ""}
              >
                {allowedStatuses.map((nextStatus) => (
                  <option key={nextStatus} value={nextStatus}>
                    {MEMBER_STATUS_LABELS[nextStatus]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="auth-label" htmlFor={`member-reason-${member.id}`}>
                사유{reasonRequired ? " (필수)" : " (선택)"}
              </label>
              <input
                className="ui-input ui-input-compact"
                id={`member-reason-${member.id}`}
                maxLength={300}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  reasonRequired ? "이 작업에는 사유가 필요합니다." : "감사 기록에 남길 사유"
                }
                required={reasonRequired}
                value={reason}
              />
            </div>
            <button
              aria-busy={busy}
              className="ui-button ui-button-secondary min-h-11 text-sm"
              disabled={
                busy || status === undefined || (reasonRequired && reason.trim().length === 0)
              }
              onClick={() => setConfirming(true)}
              ref={applyButton}
              type="button"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <UserRoundCog aria-hidden="true" size={17} />
              )}{" "}
              적용
            </button>
          </div>
        </details>
      ) : null}
      <ConfirmDialog
        confirmLabel="적용"
        description={
          status === "approved"
            ? "학생이 반 자료를 볼 수 있게 돼요."
            : "학생은 이 반 자료를 더 볼 수 없게 돼요. 다시 바꾸려면 상태를 새로 적용해야 해요."
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void save();
        }}
        open={confirming}
        returnFocusTo={applyButton.current}
        title={`${member.display_name}을(를) '${status === undefined ? "" : MEMBER_STATUS_LABELS[status]}' 상태로 바꿀까요?`}
      />
      {canWrite && member.role === "teacher" ? (
        <p className="mt-4 rounded-xl bg-app-surface-muted px-4 py-3 text-sm font-semibold text-app-muted">
          선생님 소속 상태는 이 콘솔에서 변경하지 않습니다.
        </p>
      ) : null}
      {canWrite && member.role === "student" && allowedStatuses.length === 0 ? (
        <p className="mt-4 rounded-xl bg-app-surface-muted px-4 py-3 text-sm font-semibold text-app-muted">
          현재 상태에서 허용된 다음 학급 소속 작업이 없습니다.
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/*
 * 2026-10-02 사용자 결정(총검수 C2-05): 재설정 링크는 서버가 사용자의 가입 메일로 바로 보낸다.
 * 관리자는 링크를 보거나 복사할 수 없고, 보냈는지와 가린 주소만 확인한다.
 */
interface ResetMailResult {
  accountLabel: string;
  emailMasked: string;
  expiresAt: string;
  mail: "sent" | "failed";
}

function PasswordResetMailNotice({
  accountLabel,
  emailMasked,
  expiresAt,
  mail,
  onDismiss,
}: {
  accountLabel: string;
  emailMasked: string;
  expiresAt: string;
  mail: "sent" | "failed";
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="user-password-reset-title"
      className={`mt-5 rounded-2xl p-5 ${mail === "sent" ? "bg-success-surface text-success-text" : "bg-danger-surface text-danger-text"}`}
      data-user-password-reset={mail}
      role="status"
    >
      <h3 className="text-lg font-black" id="user-password-reset-title">
        {mail === "sent"
          ? `${accountLabel} 님에게 재설정 메일을 보냈어요`
          : `${accountLabel} 님에게 재설정 메일을 보내지 못했어요`}
      </h3>
      <p className="mt-2 text-sm font-semibold leading-6">
        {mail === "sent"
          ? `가입 메일(${emailMasked})로 보냈어요. 링크는 ${formatDateTime(expiresAt)}까지 한 번만 쓸 수 있어요.`
          : "메일 설정을 확인한 뒤 다시 보내 주세요. 다시 보내면 이전 링크는 쓸 수 없게 돼요."}
      </p>
      <button
        className="ui-button ui-button-secondary mt-4 text-sm"
        onClick={onDismiss}
        type="button"
      >
        확인
      </button>
    </section>
  );
}

function UserAccountEditor({
  canWrite,
  onClearPassword,
  onResetLink,
  onUpdated,
  user,
  children,
}: {
  canWrite: boolean;
  onClearPassword: () => void;
  onResetLink: (value: ResetMailResult) => void;
  onUpdated: (user: AdminUser) => void;
  user: AdminUser;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [status, setStatus] = useState<"active" | "inactive">(
    user.is_active ? "active" : "inactive",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"password" | "status">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const reasonReady = reason.trim().length > 0;
  const statusChanged = status !== (user.is_active ? "active" : "inactive");
  // 계정 정지·재설정 메일은 사용자에게 바로 영향을 준다(총검수 C2-03).
  const [confirming, setConfirming] = useState<"password" | "status">();
  const lastActionButton = useRef<HTMLButtonElement | null>(null);

  async function saveStatus(): Promise<void> {
    if (!canWrite || busy !== undefined || !reasonReady || !statusChanged) return;
    onClearPassword();
    setBusy("status");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateAdminUserStatus(user.id, {
        reason: reason.trim(),
        status,
      });
      onUpdated(result.user);
      setReason("");
      setNotice("사용자 계정 상태를 저장했습니다.");
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "사용자 계정 상태를 변경하지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  async function resetPassword(): Promise<void> {
    if (!canWrite || busy !== undefined || !reasonReady) return;
    onClearPassword();
    setBusy("password");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await resetAdminUserPassword(user.id, reason.trim());
      setReason("");
      onResetLink({
        accountLabel: user.display_name,
        emailMasked: result.email_masked,
        expiresAt: result.expires_at,
        mail: result.mail,
      });
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "비밀번호 재설정 메일을 보내지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <li
      className="rounded-2xl border border-app-border bg-app-surface-raised p-4"
      data-admin-person={user.id}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h4 className="break-words font-black text-app-text">{user.display_name}</h4>
          <p className="mt-1 break-all text-sm font-semibold text-app-muted">{user.email}</p>
          <p className="mt-2 text-xs font-bold text-app-muted">
            이메일 {user.email_verified ? "인증" : "미인증"} · 가입 승인{" "}
            {user.signup_approved ? "완료" : "대기"} · 생성 {formatDateTime(user.created_at)}
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1.5 text-xs font-extrabold ${
            user.is_active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
          }`}
        >
          {user.is_active ? "계정 사용 중" : "계정 비활성"}
        </span>
      </div>
      {canWrite ? (
        <details className="mt-3 border-t border-app-border">
          <summary
            className="min-h-11 cursor-pointer py-3 text-sm font-extrabold text-app-text"
            aria-label={`${user.display_name} · ${user.email} 계정 관리 작업`}
          >
            계정 관리 작업
          </summary>
          <div className="grid gap-3 pt-2 md:grid-cols-[170px_minmax(0,1fr)] md:items-end">
            <div>
              <label className="auth-label" htmlFor={`user-account-status-${user.id}`}>
                계정 상태
              </label>
              <select
                className="ui-input ui-input-compact"
                id={`user-account-status-${user.id}`}
                onChange={(event) => setStatus(event.target.value as "active" | "inactive")}
                value={status}
              >
                <option value="active">사용</option>
                <option value="inactive">비활성</option>
              </select>
            </div>
            <div>
              <label className="auth-label" htmlFor={`user-account-reason-${user.id}`}>
                작업 사유 (필수)
              </label>
              <input
                className="ui-input ui-input-compact"
                id={`user-account-reason-${user.id}`}
                maxLength={300}
                onChange={(event) => setReason(event.target.value)}
                placeholder="상태 변경과 비밀번호 발급 감사 기록에 남습니다."
                required
                value={reason}
              />
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              aria-busy={busy === "status"}
              className="ui-button ui-button-secondary text-sm"
              disabled={busy !== undefined || !reasonReady || !statusChanged}
              onClick={(event) => {
                lastActionButton.current = event.currentTarget;
                setConfirming("status");
              }}
              type="button"
            >
              계정 상태 저장
            </button>
            <button
              aria-busy={busy === "password"}
              className="ui-button ui-button-danger text-sm"
              disabled={busy !== undefined || !reasonReady}
              onClick={(event) => {
                lastActionButton.current = event.currentTarget;
                setConfirming("password");
              }}
              type="button"
            >
              비밀번호 재설정 메일 보내기
            </button>
          </div>
        </details>
      ) : null}
      <ConfirmDialog
        confirmLabel={confirming === "password" ? "메일 보내기" : "계정 상태 저장"}
        description={
          confirming === "password"
            ? "사용자 본인 이메일로 1회용 재설정 링크를 보내요. 지금 비밀번호는 링크로 바꿀 때까지 그대로예요."
            : status === "inactive"
              ? "정지하면 이 사용자는 로그인할 수 없어요. 나중에 다시 사용 중으로 바꿀 수 있어요."
              : "이 사용자가 다시 로그인할 수 있게 돼요."
        }
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          const action = confirming;
          setConfirming(undefined);
          if (action === "password") void resetPassword();
          else if (action === "status") void saveStatus();
        }}
        open={confirming !== undefined}
        returnFocusTo={lastActionButton.current}
        title={
          confirming === "password"
            ? `${user.display_name}에게 비밀번호 재설정 메일을 보낼까요?`
            : `${user.display_name} 계정을 '${status === "inactive" ? "정지" : "사용 중"}'으로 바꿀까요?`
        }
      />
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
          {error}
        </p>
      )}
      {children}
    </li>
  );
}

export function MembersPanel({
  canViewMemberships,
  canWrite,
  initialSearch,
}: {
  canViewMemberships: boolean;
  canWrite: boolean;
  /** 관리자 위쪽 검색창에서 넘어온 검색어 — 처음 열 때 한 번 검색한다. */
  initialSearch?: string | undefined;
}): React.JSX.Element {
  const [members, setMembers] = useState<AdminMember[]>();
  const [membersTruncated, setMembersTruncated] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>();
  const [usersTruncated, setUsersTruncated] = useState(false);
  const [searchDraft, setSearchDraft] = useState(initialSearch ?? "");
  const [status, setStatus] = useState<AdminMemberStatus | "">("");
  const [searched, setSearched] = useState(false);
  const [resetLink, setResetLink] = useState<ResetMailResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const runSearch = useCallback(async (): Promise<void> => {
    const search = searchDraft.trim();
    if (search.length < 2) return;
    setResetLink(undefined);
    setLoading(true);
    setError(undefined);
    setSearched(true);
    try {
      if (!canViewMemberships) {
        const userResult = await listAdminUsers(search);
        setUsers(userResult.users);
        setUsersTruncated(userResult.truncated === true);
        setMembers(undefined);
        return;
      }
      const [userResult, memberResult] = await Promise.all([
        listAdminUsers(search),
        listAdminMembers({
          search,
          ...(status === "" ? {} : { status }),
        }),
      ]);
      setUsers(userResult.users);
      setUsersTruncated(userResult.truncated === true);
      setMembers(memberResult.members);
      setMembersTruncated(memberResult.truncated === true);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "사용자와 학급 소속을 검색하지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [canViewMemberships, searchDraft, status]);

  // 위쪽 검색창에서 넘어온 검색어는 처음 한 번만 자동 검색한다(이후 입력은 사용자가 직접 검색).
  const initialSearchRun = useRef(false);
  useEffect(() => {
    if (initialSearchRun.current || initialSearch === undefined) return;
    initialSearchRun.current = true;
    void runSearch();
  }, [initialSearch, runSearch]);

  // The API currently exposes no user_id on memberships. Group only an exact,
  // unique account email match; ambiguous/unmatched memberships remain visible.
  // Grouping is presentation only: mutations still use their own account/member IDs.
  const accountForMember = (member: AdminMember) => {
    const matches = users?.filter((user) => user.email === member.email) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const unmatchedMembers =
    members?.filter((member) => accountForMember(member) === undefined) ?? [];
  const updateMember = (updated: AdminMember) =>
    setMembers((current) => current?.map((item) => (item.id === updated.id ? updated : item)));

  return (
    <PanelFrame
      description={
        canViewMemberships
          ? "이름이나 이메일로 계정과 학급 소속을 찾아 관리합니다."
          : "문의 처리에 필요한 계정을 이름이나 이메일로 찾습니다."
      }
      icon={UsersRound}
      title="계정 관리"
    >
      {!canViewMemberships ? (
        <InlineNotice>
          지원 담당자는 계정 정보를 읽기 전용으로 확인할 수 있으며, 계정과 학급 소속은 변경할 수
          없습니다.
        </InlineNotice>
      ) : null}
      <form
        className={`mt-5 grid gap-3 sm:items-end ${
          canViewMemberships
            ? "sm:grid-cols-[minmax(0,1fr)_180px_auto]"
            : "sm:grid-cols-[minmax(0,1fr)_auto]"
        }`}
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div>
          <label className="auth-label" htmlFor="member-search">
            이름 또는 이메일 · 2자 이상
          </label>
          <input
            className="ui-input"
            id="member-search"
            onChange={(event) => setSearchDraft(event.target.value)}
            required
            value={searchDraft}
          />
        </div>
        {canViewMemberships ? (
          <div>
            <label className="auth-label" htmlFor="member-status-filter">
              학급 소속 상태
            </label>
            <select
              className="ui-input"
              id="member-status-filter"
              onChange={(event) => setStatus(event.target.value as AdminMemberStatus | "")}
              value={status}
            >
              <option value="">전체</option>
              <option value="pending">반 참여 승인 대기</option>
              <option value="approved">승인</option>
              <option value="rejected">거절</option>
              <option value="removed">이용 중지</option>
              <option value="rejoin_allowed">다시 참여 허용</option>
            </select>
          </div>
        ) : null}
        <button
          className="ui-button ui-button-primary h-[3.375rem]"
          disabled={loading || searchDraft.trim().length < 2}
          type="submit"
        >
          <Search aria-hidden="true" size={18} /> 검색
        </button>
      </form>
      {canWrite ? (
        <div data-member-security-entry>
          <StepUpHint />
        </div>
      ) : null}
      {!searched ? (
        <p className="mt-5 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
          개인정보 보호를 위해 전체 목록은 자동으로 불러오지 않습니다. 검색어를 입력해 주세요.
        </p>
      ) : null}
      <LoadState error={error} loading={loading} onRetry={() => void runSearch()} />
      {resetLink === undefined ? null : (
        <PasswordResetMailNotice {...resetLink} onDismiss={() => setResetLink(undefined)} />
      )}
      {!loading && error === undefined && searched ? (
        <div className="mt-5 grid gap-5">
          {canViewMemberships ? (
            <nav aria-label="검색 결과 바로가기" className="flex flex-wrap gap-2">
              <a
                className="ui-button ui-button-secondary text-sm"
                href="#user-account-results-title"
              >
                사용자 계정 {users?.length ?? 0}개 표시 중
              </a>
              <a className="ui-button ui-button-secondary text-sm" href="#membership-results-title">
                학급 소속 {members?.length ?? 0}개 표시 중
              </a>
            </nav>
          ) : null}
          <section aria-labelledby="user-account-results-title">
            <h3
              className="scroll-mt-6 font-black text-app-text"
              id="user-account-results-title"
              tabIndex={-1}
            >
              사용자 계정 {users?.length ?? 0}개
            </h3>
            {canViewMemberships ? (
              <p
                id="membership-results-title"
                className="mt-1 scroll-mt-6 text-sm text-app-muted"
                tabIndex={-1}
              >
                학급 소속 {members?.length ?? 0}개 · 계정별로 함께 표시합니다.
              </p>
            ) : null}
            {canViewMemberships && membersTruncated ? (
              <p className="mt-2 text-sm font-semibold text-app-muted">
                최근 100개만 보여요. 검색어를 더 자세히 넣어 주세요.
              </p>
            ) : null}
            {usersTruncated ? (
              <p className="mt-2 text-sm font-semibold text-app-muted">
                사용자 계정은 최근 50개만 보여요. 검색어를 더 자세히 넣어 주세요.
              </p>
            ) : null}
            {users?.length === 0 ? (
              <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-6 text-center text-sm font-semibold text-app-muted">
                조건에 맞는 사용자 계정이 없습니다.
              </p>
            ) : (
              <ul className="mt-3 grid gap-3 xl:grid-cols-2">
                {users?.map((user) => (
                  <UserAccountEditor
                    canWrite={canWrite}
                    key={user.id}
                    onClearPassword={() => setResetLink(undefined)}
                    onResetLink={setResetLink}
                    onUpdated={(updated) =>
                      setUsers((current) =>
                        current?.map((item) => (item.id === updated.id ? updated : item)),
                      )
                    }
                    user={user}
                  >
                    {canViewMemberships ? (
                      <section
                        className="mt-4 border-t border-app-border pt-4"
                        aria-label={`${user.display_name} 학급 소속`}
                      >
                        <h4 className="text-sm font-extrabold text-app-text">학급 소속</h4>
                        {members?.some((member) => accountForMember(member)?.id === user.id) ? (
                          <ul className="mt-2 grid gap-2">
                            {members
                              .filter((member) => accountForMember(member)?.id === user.id)
                              .map((member) => (
                                <MemberEditor
                                  canWrite={canWrite}
                                  compact
                                  key={member.id}
                                  member={member}
                                  onUpdated={updateMember}
                                />
                              ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-sm text-app-muted">
                            현재 검색 조건에 맞는 학급 소속이 없습니다.
                          </p>
                        )}
                      </section>
                    ) : null}
                  </UserAccountEditor>
                ))}
              </ul>
            )}
          </section>
          {canViewMemberships && unmatchedMembers.length > 0 ? (
            <section aria-labelledby="unmatched-membership-results-title">
              <h3
                className="scroll-mt-6 font-black text-app-text"
                id="unmatched-membership-results-title"
                tabIndex={-1}
              >
                계정 검색에 포함되지 않은 학급 소속 {unmatchedMembers.length}개
              </h3>
              <ul className="mt-3 grid gap-3 xl:grid-cols-2">
                {unmatchedMembers.map((member) => (
                  <MemberEditor
                    canWrite={canWrite}
                    key={member.id}
                    member={member}
                    onUpdated={updateMember}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </PanelFrame>
  );
}
