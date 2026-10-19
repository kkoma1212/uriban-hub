import { KeyRound, LoaderCircle, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  changeAdminPassword,
  getAdminSession,
  logoutAdmin,
  type AdminRole,
  type AdminSessionResponse,
} from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";
import { AdminFactorsPanel } from "./admin-factors-panel";
import { AlertDialog } from "../layout/alert-dialog";
import { PageHeader } from "../layout/page-header";
import { AdminShell } from "./admin-shell";
import { useRequestCooldown } from "../auth/request-cooldown";

const roleNames: Record<AdminRole, string> = {
  account_manager: "계정 관리자",
  security_auditor: "보안 감사자",
  super_admin: "최고 관리자",
  support: "지원 담당자",
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function AdminAccountPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const navigate = useNavigate();
  const [session, setSession] = useState<AdminSessionResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    void getAdminSession()
      .then((result) => {
        if (active) {
          setSession(result);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          void navigate("/admin/login", { replace: true });
          return;
        }
        setLoadError(error instanceof Error ? error.message : "관리자 세션을 확인하지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  async function logout(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErrorMessage(undefined);
    try {
      await logoutAdmin();
      void navigate("/admin/login", { replace: true });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "ADMIN_SESSION_REQUIRED") {
        void navigate("/admin/login", { replace: true });
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "로그아웃하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const length = Array.from(newPassword.normalize("NFC")).length;
    if (busy) return;
    // 2026-10-02 사용자 결정: 관리자 새 비밀번호는 12자 이상(서버 ADMIN_PASSWORD_MIN_CODE_POINTS와 같음).
    if (length < 12) {
      setErrorMessage(`새 비밀번호는 12자 이상 입력해 주세요. 현재 ${length}자입니다.`);
      return;
    }
    if (!/\p{L}/u.test(newPassword) || !/\p{N}/u.test(newPassword)) {
      setErrorMessage("비밀번호에 문자와 숫자를 모두 넣어 주세요.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage("새 비밀번호와 확인 입력이 일치하지 않습니다.");
      return;
    }
    setBusy(true);
    setSuccess(undefined);
    setErrorMessage(undefined);
    try {
      await changeAdminPassword(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("비밀번호를 변경하고 다른 관리자 세션을 종료했습니다.");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "ADMIN_SESSION_REQUIRED") {
        void navigate("/admin/login", { replace: true });
        return;
      }
      setErrorMessage(
        error instanceof ApiRequestError && error.code === "ADMIN_STEP_UP_REQUIRED"
          ? "먼저 중요 작업 보안 확인을 완료해 주세요."
          : error instanceof Error
            ? error.message
            : "비밀번호를 변경하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    // 로그인한 관리자에게 로고가 로그인 화면으로 가고 콘솔로 돌아갈 버튼이 없었다(총검수 C3-04).
    <AdminShell homeHref="/admin" session={session} onSessionChange={setSession}>
      <PageHeader
        actions={
          <Link className="ui-button ui-button-secondary text-sm" to="/admin">
            운영 콘솔로
          </Link>
        }
        className="mb-6 border-b border-app-border pb-5"
        description="관리자 로그인 상태를 확인하고 비밀번호를 변경할 수 있습니다."
        eyebrow="계정·보안"
        title={session?.account.display_name ?? "관리자 보안 상태"}
      />

      {loadError !== undefined ? (
        <div
          className="rounded-2xl border border-danger-border bg-danger-surface p-4 text-sm font-semibold text-danger-text"
          role="alert"
        >
          {loadError}
        </div>
      ) : session === undefined ? (
        <div
          className="flex min-h-36 items-center justify-center gap-2 text-sm font-bold text-app-muted"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="animate-spin" size={20} /> 관리자 세션 확인 중
        </div>
      ) : (
        <>
          <AdminFactorsPanel />
          <section
            aria-labelledby="admin-identity-title"
            className="rounded-2xl border border-app-border bg-app-surface-muted p-4 sm:p-5"
          >
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-role-soft text-role-primary">
                <ShieldCheck aria-hidden="true" size={21} />
              </span>
              <div className="min-w-0">
                <h2 className="font-extrabold" id="admin-identity-title">
                  관리자 로그인 완료
                </h2>
                <p className="mt-1 break-all text-sm font-semibold text-app-muted">
                  {session.account.email}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {session.account.roles.map((role) => (
                    <span
                      className="rounded-full border border-role-border bg-role-soft px-3 py-1 text-xs font-extrabold text-role-primary"
                      key={role}
                    >
                      {roleNames[role]}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <dl className="mt-4 grid gap-px overflow-hidden rounded-2xl border border-app-border bg-app-border sm:grid-cols-2">
            <div className="bg-app-surface p-4">
              <dt className="text-xs font-bold text-app-muted">2단계 인증 시각</dt>
              <dd className="mt-1 text-sm font-extrabold">
                {formatTimestamp(session.session.mfa_verified_at)}
              </dd>
            </div>
            <div className="bg-app-surface p-4">
              <dt className="text-xs font-bold text-app-muted">절대 만료 시각</dt>
              <dd className="mt-1 text-sm font-extrabold">
                {formatTimestamp(session.session.absolute_expires_at)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs font-semibold leading-5 text-app-muted">
            로그인은 30분 동안 유지되며 위에서 연장할 수 있습니다. 비밀번호 변경 등 중요 작업에는
            별도 보안 확인이 필요하고, 확인 후 5분 동안 유효합니다.
          </p>

          <section
            aria-labelledby="admin-password-change-title"
            className="mt-6 border-t border-app-border pt-6"
          >
            <h2 className="font-extrabold" id="admin-password-change-title">
              비밀번호 변경
            </h2>
            <p className="mt-1 text-sm font-semibold leading-6 text-app-muted">
              새 비밀번호를 입력하면 현재 비밀번호와 인증 앱의 새 번호로 보안 확인을 진행합니다.
              최근 5분 이내에 확인했다면 바로 변경합니다.
            </p>
            <p className="mt-2 text-sm text-app-muted" id="admin-password-requirements">
              문자와 숫자를 포함해 12자 이상 입력해 주세요. 길이 상한은 없으며, 두 칸을 똑같이
              입력해 주세요.
            </p>
            <form className="mt-4 space-y-4" noValidate onSubmit={changePassword}>
              <div>
                <label className="auth-label" htmlFor="admin-new-password">
                  새 비밀번호
                </label>
                <input
                  aria-describedby="admin-password-requirements"
                  autoComplete="new-password"
                  className="auth-input"
                  id="admin-new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  type="password"
                  value={newPassword}
                />
              </div>
              <div>
                <label className="auth-label" htmlFor="admin-confirm-password">
                  새 비밀번호 확인
                </label>
                <input
                  autoComplete="new-password"
                  className="auth-input"
                  id="admin-confirm-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type="password"
                  value={confirmPassword}
                />
              </div>
              <button
                aria-busy={busy}
                className="ui-button ui-button-secondary h-12 w-full"
                disabled={busy || cooldownSeconds > 0}
                ref={actionRef}
                type="submit"
              >
                <KeyRound aria-hidden="true" size={18} /> 비밀번호 변경
              </button>
            </form>
            {success === undefined ? null : (
              <p className="mt-3 text-sm font-bold text-success-text" role="status">
                {success}
              </p>
            )}
          </section>

          <button
            className="ui-button ui-button-secondary mt-6 h-12 w-full"
            disabled={busy}
            onClick={() => void logout()}
            type="button"
          >
            <LogOut aria-hidden="true" size={18} /> 관리자 로그아웃
          </button>
        </>
      )}

      <AlertDialog
        description={errorMessage}
        onClose={() => setErrorMessage(undefined)}
        open={errorMessage !== undefined}
        returnFocusTo={actionRef.current}
        title="관리자 보안 요청을 완료할 수 없어요"
      />
    </AdminShell>
  );
}
