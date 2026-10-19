import { FileKey2, KeyRound, LoaderCircle, UserRoundCog } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

import type { AdminRole } from "../../api/admin-auth";
import {
  createAdminAccount,
  findAdminSignupAccount,
  issueAdminSignupApproval,
  listAdminAccounts,
  replaceAdminAccountRoles,
  resetAdminAccountCredentials,
  resetAdminAccountMfa,
  revokeAdminSignupApproval,
  updateAdminAccountStatus,
  type AdminAccountStatus,
  type AdminSignupRole,
  type ManagedAdminAccount,
  type SignupApprovalAccount,
} from "../../api/admin-management";
import {
  adminErrorMessage,
  formatDateTime,
  InlineNotice,
  LoadState,
  PanelFrame,
  ROLE_LABELS,
  StepUpHint,
} from "./admin-console-shared";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";

const ALL_ADMIN_ROLES: readonly AdminRole[] = [
  "super_admin",
  "account_manager",
  "support",
  "security_auditor",
];

const ADMIN_ACCOUNT_STATUS_LABELS: Record<AdminAccountStatus, string> = {
  active: "사용 중",
  pending_mfa: "MFA 등록 대기",
  revoked: "권한 폐기",
  suspended: "일시 정지",
};

function AdminRoleFields({
  idPrefix,
  onChange,
  roles,
}: {
  idPrefix: string;
  onChange: (roles: AdminRole[]) => void;
  roles: readonly AdminRole[];
}): React.JSX.Element {
  function toggle(role: AdminRole, checked: boolean): void {
    onChange(checked ? [...roles, role] : roles.filter((item) => item !== role));
  }

  return (
    <fieldset>
      <legend className="auth-label">관리자 역할</legend>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {ALL_ADMIN_ROLES.map((role) => (
          <label
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 text-sm font-bold text-app-text"
            htmlFor={`${idPrefix}-${role}`}
            key={role}
          >
            <input
              checked={roles.includes(role)}
              className="size-5 accent-role-primary"
              id={`${idPrefix}-${role}`}
              onChange={(event) => toggle(role, event.target.checked)}
              type="checkbox"
            />
            {ROLE_LABELS[role]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function InitialPasswordReveal({
  accountLabel,
  onDismiss,
  password,
}: {
  accountLabel: string;
  onDismiss: () => void;
  password: string;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="admin-initial-password-title"
      className="mt-5 rounded-2xl bg-slate-950 p-5 text-white"
      data-admin-initial-password="visible"
    >
      <p className="text-xs font-extrabold text-slate-300">응답 직후 한 번만 표시</p>
      <h3 className="mt-1 text-lg font-black" id="admin-initial-password-title">
        {accountLabel} 초기 비밀번호
      </h3>
      <code className="mt-4 block overflow-x-auto rounded-xl bg-slate-900 px-4 py-3 text-base font-black tracking-wide">
        {password}
      </code>
      <p className="mt-3 text-sm font-semibold leading-6 text-slate-300">
        안전한 방법으로 해당 관리자에게 전달하세요. 닫으면 이 화면과 앱 상태에서 즉시 제거되며 다시
        확인할 수 없습니다.
      </p>
      <button
        className="ui-button ui-button-on-dark mt-4 text-sm"
        onClick={onDismiss}
        type="button"
      >
        확인하고 닫기
      </button>
    </section>
  );
}

function AdminAccountEditor({
  account,
  currentAccountId,
  onClearPassword,
  onPassword,
  onUpdated,
}: {
  account: ManagedAdminAccount;
  currentAccountId: string;
  onClearPassword: () => void;
  onPassword: (password: string, accountLabel: string) => void;
  onUpdated: (account: ManagedAdminAccount) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<Exclude<AdminAccountStatus, "pending_mfa">>(
    account.status === "pending_mfa" ? "active" : account.status,
  );
  const [roles, setRoles] = useState<AdminRole[]>(account.roles);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"credentials" | "mfa" | "roles" | "status">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // 상태·역할·재설정은 대상 관리자에게 바로 영향을 준다 — 한 번 더 확인받는다(총검수 C2-03).
  const [confirming, setConfirming] = useState<"credentials" | "mfa" | "roles" | "status">();
  const lastActionButton = useRef<HTMLButtonElement | null>(null);
  const isSelf = account.id === currentAccountId;
  const reasonReady = reason.trim().length > 0;
  const resetAllowed = account.status === "active" || account.status === "pending_mfa";

  function begin(action: NonNullable<typeof busy>): void {
    onClearPassword();
    setBusy(action);
    setError(undefined);
    setNotice(undefined);
  }

  async function saveStatus(): Promise<void> {
    if (busy !== undefined || !reasonReady || (isSelf && status !== "active")) return;
    begin("status");
    try {
      const result = await updateAdminAccountStatus(account.id, {
        reason: reason.trim(),
        status,
      });
      onUpdated({ ...account, ...result.account });
      setReason((current) => (current === reason ? "" : current));
      setNotice("계정 상태를 저장했습니다.");
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "관리자 계정 상태를 변경하지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  async function saveRoles(): Promise<void> {
    if (busy !== undefined || !reasonReady || roles.length === 0) return;
    begin("roles");
    try {
      const result = await replaceAdminAccountRoles(account.id, {
        reason: reason.trim(),
        roles,
      });
      onUpdated({ ...account, roles: result.account.roles });
      setReason((current) => (current === reason ? "" : current));
      setNotice("관리자 역할을 저장했습니다.");
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "관리자 역할을 변경하지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  async function resetCredentials(): Promise<void> {
    if (!resetAllowed || busy !== undefined || !reasonReady) return;
    begin("credentials");
    try {
      const result = await resetAdminAccountCredentials(account.id, reason.trim());
      onUpdated({ ...account, status: result.status });
      setStatus("active");
      setReason((current) => (current === reason ? "" : current));
      onPassword(result.initial_password, account.display_name);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "비밀번호와 MFA를 재설정하지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  async function resetMfa(): Promise<void> {
    if (!resetAllowed || busy !== undefined || !reasonReady) return;
    begin("mfa");
    try {
      const result = await resetAdminAccountMfa(account.id, reason.trim());
      onUpdated({ ...account, status: result.status });
      setStatus("active");
      setReason((current) => (current === reason ? "" : current));
      setNotice("MFA를 재설정했습니다. 대상 관리자는 다음 로그인에서 다시 등록해야 합니다.");
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "MFA를 재설정하지 못했습니다."));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <li className="rounded-2xl border border-app-border bg-app-surface-raised p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="break-words font-black text-app-text">
            {account.display_name}
            {isSelf ? " · 현재 계정" : ""}
          </h3>
          <p className="mt-1 break-all text-sm font-semibold text-app-muted">{account.email}</p>
          <p className="mt-2 text-xs font-bold text-app-muted">
            마지막 로그인{" "}
            {account.last_login_at === null ? "없음" : formatDateTime(account.last_login_at)}
          </p>
        </div>
        <span className="w-fit shrink-0 rounded-full bg-role-soft px-3 py-1.5 text-xs font-extrabold text-role-primary">
          {ADMIN_ACCOUNT_STATUS_LABELS[account.status]}
        </span>
      </div>

      <div className="mt-4 border-t border-app-border pt-4">
        <AdminRoleFields
          idPrefix={`admin-account-role-${account.id}`}
          onChange={setRoles}
          roles={roles}
        />
        {roles.length === 0 ? (
          <p className="mt-2 text-sm font-bold text-danger-text" role="alert">
            역할을 하나 이상 선택해야 합니다.
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[180px_minmax(0,1fr)]">
        <div>
          <label className="auth-label" htmlFor={`admin-account-status-${account.id}`}>
            계정 상태
          </label>
          <select
            className="ui-input ui-input-compact"
            id={`admin-account-status-${account.id}`}
            onChange={(event) =>
              setStatus(event.target.value as Exclude<AdminAccountStatus, "pending_mfa">)
            }
            value={status}
          >
            <option value="active">사용 중</option>
            <option value="suspended">일시 정지</option>
            <option value="revoked">권한 폐기</option>
          </select>
        </div>
        <div>
          <label className="auth-label" htmlFor={`admin-account-reason-${account.id}`}>
            변경 사유
          </label>
          <input
            className="ui-input ui-input-compact"
            id={`admin-account-reason-${account.id}`}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            placeholder="모든 변경의 감사 기록에 남습니다."
            value={reason}
          />
        </div>
      </div>
      {isSelf && status !== "active" ? (
        <p className="mt-2 text-sm font-bold text-danger-text">
          현재 로그인한 계정은 정지하거나 폐기할 수 없습니다.
        </p>
      ) : null}
      {!resetAllowed ? (
        <p className="mt-2 text-sm font-bold text-danger-text">
          {account.status === "suspended"
            ? "일시 정지된 계정은 상태를 먼저 활성화한 뒤 자격 증명을 재설정할 수 있습니다."
            : "권한이 폐기된 계정의 자격 증명은 재설정할 수 없습니다."}
        </p>
      ) : null}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <button
          aria-busy={busy === "status"}
          className="ui-button ui-button-secondary min-w-0 whitespace-normal px-3 text-sm"
          disabled={busy !== undefined || !reasonReady || (isSelf && status !== "active")}
          onClick={(event) => {
            lastActionButton.current = event.currentTarget;
            setConfirming("status");
          }}
          type="button"
        >
          상태 저장
        </button>
        <button
          aria-busy={busy === "roles"}
          className="ui-button ui-button-secondary min-w-0 whitespace-normal px-3 text-sm"
          disabled={busy !== undefined || !reasonReady || roles.length === 0}
          onClick={(event) => {
            lastActionButton.current = event.currentTarget;
            setConfirming("roles");
          }}
          type="button"
        >
          역할 저장
        </button>
        <button
          aria-busy={busy === "credentials"}
          className="ui-button ui-button-danger min-w-0 whitespace-normal px-3 text-sm"
          disabled={!resetAllowed || busy !== undefined || !reasonReady}
          onClick={(event) => {
            lastActionButton.current = event.currentTarget;
            setConfirming("credentials");
          }}
          type="button"
        >
          비밀번호·MFA 재설정
        </button>
        <button
          aria-busy={busy === "mfa"}
          className="ui-button ui-button-danger min-w-0 whitespace-normal px-3 text-sm"
          disabled={!resetAllowed || busy !== undefined || !reasonReady}
          onClick={(event) => {
            lastActionButton.current = event.currentTarget;
            setConfirming("mfa");
          }}
          type="button"
        >
          MFA만 재설정
        </button>
      </div>
      <ConfirmDialog
        confirmLabel={
          confirming === "status"
            ? "상태 저장"
            : confirming === "roles"
              ? "역할 저장"
              : confirming === "credentials"
                ? "비밀번호·MFA 재설정"
                : "MFA만 재설정"
        }
        description={
          confirming === "status"
            ? status === "revoked"
              ? "권한을 폐기한 관리자 계정은 다시 쓸 수 없어요."
              : "나중에 다시 바꿀 수 있어요."
            : confirming === "roles"
              ? "바뀐 역할은 다음 요청부터 적용돼요. 나중에 다시 바꿀 수 있어요."
              : confirming === "credentials"
                ? "대상 관리자는 새 임시 비밀번호로 다시 로그인하고 2단계 인증을 다시 등록해야 해요. 패스키·복구 코드도 쓸 수 없게 돼요."
                : "대상 관리자는 다음 로그인에서 2단계 인증을 다시 등록해야 해요. 패스키·복구 코드도 쓸 수 없게 돼요."
        }
        onCancel={() => setConfirming(undefined)}
        onConfirm={() => {
          const action = confirming;
          setConfirming(undefined);
          if (action === "status") void saveStatus();
          else if (action === "roles") void saveRoles();
          else if (action === "credentials") void resetCredentials();
          else if (action === "mfa") void resetMfa();
        }}
        open={confirming !== undefined}
        returnFocusTo={lastActionButton.current}
        title={
          confirming === "status"
            ? `${account.display_name} 계정을 '${ADMIN_ACCOUNT_STATUS_LABELS[status]}' 상태로 바꿀까요?`
            : confirming === "roles"
              ? `${account.display_name}의 관리자 역할을 바꿀까요?`
              : confirming === "credentials"
                ? `${account.display_name}의 비밀번호와 MFA를 재설정할까요?`
                : `${account.display_name}의 MFA를 재설정할까요?`
        }
      />
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function AccountsPanel({
  currentAccountId,
}: {
  currentAccountId: string;
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<ManagedAdminAccount[]>();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<AdminRole[]>(["support"]);
  const [passwordReveal, setPasswordReveal] = useState<{
    accountLabel: string;
    password: string;
  }>();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    setPasswordReveal(undefined);
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await listAdminAccounts();
      setAccounts(result.accounts);
    } catch (requestError) {
      setLoadError(adminErrorMessage(requestError, "관리자 계정 목록을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      creating ||
      displayName.trim().length < 2 ||
      email.trim().length === 0 ||
      roles.length === 0
    )
      return;
    setPasswordReveal(undefined);
    setCreating(true);
    setActionError(undefined);
    setNotice(undefined);
    const nextDisplayName = displayName.trim();
    const nextEmail = email.trim().toLowerCase();
    try {
      const result = await createAdminAccount({
        display_name: nextDisplayName,
        email: nextEmail,
        roles,
      });
      if (result.created === false) {
        await load();
        setNotice(
          "동일한 이메일과 역할의 기존 관리자 계정을 확인했습니다. 초기 비밀번호는 다시 표시하지 않습니다.",
        );
        return;
      }
      if (typeof result.initial_password !== "string" || result.initial_password.length === 0) {
        throw new Error("초기 비밀번호 응답을 확인하지 못했습니다. 계정 목록을 확인해 주세요.");
      }
      const now = new Date().toISOString();
      setAccounts((current) => [
        {
          created_at: now,
          display_name: nextDisplayName,
          email: nextEmail,
          id: result.account.id,
          last_login_at: null,
          roles: result.account.roles,
          status: result.account.status,
          updated_at: now,
        },
        ...(current ?? []),
      ]);
      setDisplayName((current) => (current === displayName ? "" : current));
      setEmail((current) => (current === email ? "" : current));
      setRoles((current) => (current === roles ? ["support"] : current));
      setPasswordReveal({ accountLabel: nextDisplayName, password: result.initial_password });
    } catch (requestError) {
      setActionError(adminErrorMessage(requestError, "관리자 계정을 만들지 못했습니다."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <PanelFrame
      description="관리자 계정을 만들고 상태·역할·비밀번호·MFA 복구 작업을 관리합니다. 모든 변경에는 보안 확인과 사유가 필요합니다."
      icon={UserRoundCog}
      title="관리자 계정 관리"
    >
      <StepUpHint />
      <form
        className="mt-5 grid gap-4 rounded-2xl border border-app-border bg-app-surface-raised p-4 sm:p-5"
        onSubmit={create}
      >
        <h3 className="font-black text-app-text">새 관리자 계정</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="auth-label" htmlFor="new-admin-display-name">
              표시명
            </label>
            <input
              className="ui-input"
              id="new-admin-display-name"
              maxLength={40}
              minLength={2}
              onChange={(event) => setDisplayName(event.target.value)}
              value={displayName}
            />
          </div>
          <div>
            <label className="auth-label" htmlFor="new-admin-email">
              관리자 이메일
            </label>
            <input
              className="ui-input"
              id="new-admin-email"
              inputMode="email"
              maxLength={320}
              onChange={(event) => setEmail(event.target.value)}
              value={email}
            />
          </div>
        </div>
        <AdminRoleFields idPrefix="new-admin-role" onChange={setRoles} roles={roles} />
        <button
          aria-busy={creating}
          className="ui-button ui-button-primary w-full sm:w-fit"
          disabled={
            creating ||
            displayName.trim().length < 2 ||
            email.trim().length === 0 ||
            roles.length === 0
          }
          type="submit"
        >
          {creating ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
          ) : (
            <UserRoundCog aria-hidden="true" size={17} />
          )}
          관리자 계정 만들기
        </button>
      </form>

      {passwordReveal === undefined ? null : (
        <InitialPasswordReveal
          accountLabel={passwordReveal.accountLabel}
          onDismiss={() => setPasswordReveal(undefined)}
          password={passwordReveal.password}
        />
      )}
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      {actionError === undefined ? null : (
        <p
          className="mt-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-semibold text-danger-text"
          role="alert"
        >
          {actionError}
        </p>
      )}
      <LoadState error={loadError} loading={loading} onRetry={() => void load()} />
      {!loading && loadError === undefined ? (
        <p className="mt-5 text-sm font-bold text-app-muted">
          관리자 계정 {accounts?.length ?? 0}개
        </p>
      ) : null}
      {accounts?.length === 0 ? (
        <p className="mt-3 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
          등록된 관리자 계정이 없습니다.
        </p>
      ) : null}
      {accounts === undefined ? null : (
        <ul className="mt-3 grid gap-4">
          {accounts.map((account) => (
            <AdminAccountEditor
              account={account}
              currentAccountId={currentAccountId}
              key={account.id}
              onClearPassword={() => setPasswordReveal(undefined)}
              onPassword={(password, accountLabel) => setPasswordReveal({ accountLabel, password })}
              onUpdated={(updated) => {
                setAccounts((current) =>
                  current?.map((item) => (item.id === updated.id ? updated : item)),
                );
                setNotice(`${updated.display_name} 계정 정보를 갱신했습니다.`);
              }}
            />
          ))}
        </ul>
      )}
    </PanelFrame>
  );
}

export function ApprovalPanel(): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminSignupRole>("teacher");
  const [issued, setIssued] = useState<Awaited<ReturnType<typeof issueAdminSignupApproval>>>();
  const [previouslyIssuedId, setPreviouslyIssuedId] = useState<string>();
  const [confirmReissue, setConfirmReissue] = useState(false);
  const issueBusyRef = useRef(false);
  const issueButtonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [found, setFound] = useState<SignupApprovalAccount | null>();
  const matchesSelection =
    found !== undefined &&
    found !== null &&
    found.email === email.trim().toLowerCase() &&
    found.signup_role === role;

  function clearSelection(): void {
    setFound(undefined);
    setIssued(undefined);
    setPreviouslyIssuedId(undefined);
    setConfirmReissue(false);
    setError(undefined);
    setNotice(undefined);
  }

  async function search(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || email.trim().length === 0) return;
    clearSelection();
    setBusy(true);
    try {
      const result = await findAdminSignupAccount(email, role);
      setFound(result.account);
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "가입 계정을 검색하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function issue(): Promise<void> {
    if (issueBusyRef.current || busy || !matchesSelection || !found?.email_verified) return;
    issueBusyRef.current = true;
    const replacing = previouslyIssuedId !== undefined;
    setIssued(undefined);
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await issueAdminSignupApproval({
        email: found.email,
        role: found.signup_role,
      });
      setIssued(result);
      setPreviouslyIssuedId(result.id);
      setNotice(
        result.email_delivery_status === "failed"
          ? "승인번호는 발급됐지만 이메일 전송에 실패했어요. 아래 번호를 안전한 방법으로 가입자에게 전달해 주세요. 자동으로 다시 발급하지 않습니다."
          : result.email_delivery_status === "sent"
            ? "새 승인번호를 발급하고 이메일을 전송했습니다. 이 화면을 닫으면 번호를 다시 볼 수 없습니다."
            : "새 승인번호를 발급했습니다. 이메일 전송 결과는 확인되지 않았어요. 이 화면을 닫으면 번호를 다시 볼 수 없습니다.",
      );
    } catch (requestError) {
      setError(
        isMutationOutcomeUnknown(requestError)
          ? "이미 승인번호가 발급됐을 수 있어요. 발급 결과를 확인하지 못했습니다. 다시 발급하기 전에 현재 발급 상태를 확인해 주세요." +
              (replacing ? " 이전 번호는 다시 전달하지 말고 현재 발급 상태를 확인해 주세요." : "")
          : adminErrorMessage(requestError, "승인번호를 발급하지 못했습니다."),
      );
    } finally {
      issueBusyRef.current = false;
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    if (busy || issued === undefined) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await revokeAdminSignupApproval(issued.id);
      setIssued(undefined);
      setPreviouslyIssuedId(undefined);
      setNotice(
        result.revoked ? "승인번호를 폐기했습니다." : "이미 사용되었거나 폐기된 승인번호입니다.",
      );
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "승인번호를 폐기하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelFrame
      description="이메일 인증을 마친 계정을 검색합니다. 선생님은 교사 여부를 확인한 후 승인번호를 발급해 주세요."
      icon={FileKey2}
      title="가입 승인번호"
    >
      <StepUpHint />
      <form
        className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end"
        onSubmit={(event) => void search(event)}
      >
        <div>
          <label className="auth-label" htmlFor="approval-email">
            가입 이메일
          </label>
          <input
            className="auth-input"
            id="approval-email"
            disabled={busy}
            inputMode="email"
            onChange={(event) => {
              setEmail(event.target.value);
              clearSelection();
            }}
            placeholder="name@example.com"
            required
            value={email}
          />
        </div>
        <div>
          <label className="auth-label" htmlFor="approval-role">
            계정 유형
          </label>
          <select
            className="ui-input"
            id="approval-role"
            disabled={busy}
            onChange={(event) => {
              setRole(event.target.value as AdminSignupRole);
              clearSelection();
            }}
            value={role}
          >
            <option value="teacher">선생님 계정</option>
            <option value="student">학생 계정</option>
          </select>
        </div>
        <button
          aria-busy={busy}
          className="ui-button ui-button-primary h-[3.375rem]"
          disabled={busy || email.trim().length === 0}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : (
            <KeyRound aria-hidden="true" size={18} />
          )}{" "}
          계정 검색
        </button>
      </form>
      {found === null ? (
        <InlineNotice>
          입력한 전체 이메일과 계정 유형에 일치하는 승인 대기 계정이 없습니다. 가입 유형이 누락된
          기존 계정은 가입자가 로그인해 유형을 먼저 확인해 주세요.
        </InlineNotice>
      ) : null}
      {matchesSelection && found ? (
        <div className="mt-5 rounded-2xl border border-app-border bg-app-surface-raised p-4">
          <p className="font-bold text-app-text">
            {found.display_name} · {found.signup_role === "student" ? "학생 계정" : "선생님 계정"}
          </p>
          <p className="mt-1 break-all text-sm text-app-muted">{found.email}</p>
          <p className="mt-2 text-sm text-app-muted">
            {found.email_verified
              ? "이메일 인증 완료 · 선생님은 교사 여부 확인 후 발급해 주세요."
              : "이메일 인증 대기 · 가입자가 로그인해 이메일 인증을 먼저 마쳐야 합니다."}
          </p>
          <button
            className="ui-button ui-button-primary mt-3"
            disabled={busy || !found.email_verified}
            onClick={() => {
              if (previouslyIssuedId !== undefined) setConfirmReissue(true);
              else void issue();
            }}
            ref={issueButtonRef}
            type="button"
          >
            {previouslyIssuedId === undefined ? "발급" : "재발급"}
          </button>
          <p className="mt-2 text-xs leading-5 text-app-muted">
            기존에 사용하지 않은 승인번호가 있으면 새 번호 발급 시 폐기됩니다.
          </p>
        </div>
      ) : null}
      <ConfirmDialog
        confirmLabel="재발급"
        description="새 번호를 발급하면 기존에 사용하지 않은 승인번호가 즉시 폐기됩니다. 가입자에게 새 번호를 전달해 주세요."
        onCancel={() => setConfirmReissue(false)}
        onConfirm={() => {
          setConfirmReissue(false);
          void issue();
        }}
        open={confirmReissue}
        returnFocusTo={issueButtonRef.current}
        title="승인번호를 다시 발급할까요?"
      />
      {error === undefined ? null : (
        <p
          className="mt-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-semibold text-danger-text"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice === undefined ? null : <InlineNotice>{notice}</InlineNotice>}
      {issued === undefined ? null : (
        <div className="mt-5 rounded-2xl bg-slate-950 p-5 text-white">
          <p className="text-xs font-extrabold text-slate-300">한 번만 표시되는 승인번호</p>
          <code className="mt-2 block text-3xl font-black tracking-[0.28em]">{issued.code}</code>
          <p className="mt-3 text-sm font-semibold text-slate-300">
            {formatDateTime(issued.expires_at)}까지 유효 · 재발급하면 이 번호는 즉시 폐기됩니다.
          </p>
          <button
            className="ui-button ui-button-on-dark mt-4 text-sm"
            disabled={busy}
            onClick={() => void revoke()}
            type="button"
          >
            번호 폐기
          </button>
        </div>
      )}
    </PanelFrame>
  );
}
