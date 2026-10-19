import { KeyRound, LoaderCircle, LogOut, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiRequestError } from "../../api/auth";
import {
  createLocalTestAccount,
  deleteLocalTestAccount,
  listLocalTestAccounts,
  loginLocalAdmin,
  logoutLocalAdmin,
  type LocalTestAccount,
} from "../../api/local-test-admin";
import { codePointLength } from "../../lib/text";
import { ConfirmDialog } from "../layout/confirm-dialog";

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}

type BusyAction = "create" | "login" | "logout" | "refresh" | `delete:${string}`;

interface DeletionConfirmation {
  account: LocalTestAccount;
  trigger: HTMLButtonElement;
}

export function LocalTestAdminPage(): React.JSX.Element {
  const [authenticated, setAuthenticated] = useState(false);
  const [accounts, setAccounts] = useState<LocalTestAccount[]>([]);
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("");
  const [displayName, setDisplayName] = useState("테스트 학생");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("classhub123");
  const [emailVerified, setEmailVerified] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [deletionConfirmation, setDeletionConfirmation] = useState<DeletionConfirmation>();
  const [error, setError] = useState<string>();
  const busy = busyAction !== undefined;

  const refresh = useCallback(async (trackBusy = true) => {
    if (trackBusy) {
      setBusyAction("refresh");
      setError(undefined);
    }
    try {
      setAccounts(await listLocalTestAccounts());
      setAuthenticated(true);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        setAuthenticated(false);
        setAccounts([]);
        return;
      }
      setError(errorMessage(requestError));
    } finally {
      if (trackBusy) {
        setBusyAction((current) => (current === "refresh" ? undefined : current));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submitLogin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusyAction("login");
    setError(undefined);
    try {
      await loginLocalAdmin(adminUsername.trim(), adminPassword);
      setAdminPassword("");
      await refresh(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function submitCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalizedDisplayName = displayName.trim();
    const displayNameLength = codePointLength(normalizedDisplayName);
    if (displayNameLength < 2 || displayNameLength > 20) {
      setError("표시명은 2자 이상 20자 이하로 입력해 주세요.");
      return;
    }
    setBusyAction("create");
    setError(undefined);
    try {
      await createLocalTestAccount({
        display_name: normalizedDisplayName,
        email: email.trim().toLowerCase(),
        email_verified: emailVerified,
        password,
      });
      setEmail("");
      await refresh(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function removeAccount(account: LocalTestAccount): Promise<void> {
    setDeletionConfirmation(undefined);
    setBusyAction(`delete:${account.id}`);
    setError(undefined);
    try {
      await deleteLocalTestAccount(account);
      await refresh(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function logout(): Promise<void> {
    setBusyAction("logout");
    try {
      await logoutLocalAdmin();
    } finally {
      setAuthenticated(false);
      setAccounts([]);
      setBusyAction(undefined);
    }
  }

  return (
    <main className="min-h-dvh bg-slate-950 px-5 py-8 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-sm font-bold text-amber-300">
              <ShieldAlert size={16} /> 로컬 테스트 전용 · 배포 금지
            </div>
            <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
              테스트 계정 관리
            </h1>
            <p className="mt-2 text-slate-400">@example.com 계정만 생성·삭제할 수 있습니다.</p>
          </div>
          {authenticated ? (
            <button
              aria-busy={busyAction === "logout"}
              className="ui-button ui-button-on-dark"
              disabled={busy}
              onClick={() => void logout()}
              type="button"
            >
              <LogOut size={17} /> 로그아웃
            </button>
          ) : null}
        </div>

        {error === undefined ? null : (
          <div
            className="mb-5 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-rose-200"
            role="alert"
          >
            {error}
          </div>
        )}

        {!authenticated ? (
          <form
            aria-busy={busyAction === "login" || busyAction === "refresh"}
            className="max-w-xl space-y-5 rounded-card border border-slate-800 bg-slate-900 p-6 shadow-2xl"
            onSubmit={(event) => void submitLogin(event)}
          >
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-blue-500/15 text-blue-300">
                <KeyRound size={22} />
              </span>
              <div>
                <h2 className="text-xl font-black">운영자 로그인</h2>
                <p className="text-sm text-slate-400">로컬 전용 아이디와 비밀번호를 사용합니다.</p>
              </div>
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-300">관리자 아이디</span>
              <input
                autoComplete="username"
                className="auth-input ui-input-dark border-slate-700 bg-slate-950 text-white"
                onChange={(event) => setAdminUsername(event.target.value)}
                value={adminUsername}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-300">관리자 비밀번호</span>
              <input
                autoComplete="current-password"
                className="auth-input ui-input-dark border-slate-700 bg-slate-950 text-white"
                onChange={(event) => setAdminPassword(event.target.value)}
                type="password"
                value={adminPassword}
              />
            </label>
            <button
              aria-busy={busyAction === "login"}
              className="ui-button ui-button-primary h-13 w-full"
              disabled={busy}
              type="submit"
            >
              {busyAction === "login" ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <KeyRound size={18} />
              )}
              관리자 로그인
            </button>
          </form>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <form
              aria-busy={busyAction === "create"}
              className="h-fit space-y-4 rounded-card border border-slate-800 bg-slate-900 p-6"
              onSubmit={(event) => void submitCreate(event)}
            >
              <h2 className="flex items-center gap-2 text-xl font-black">
                <Plus size={20} /> 테스트 계정 추가
              </h2>
              <label className="block text-sm font-bold text-slate-300">
                표시명
                <input
                  className="auth-input ui-input-dark mt-2 border-slate-700 bg-slate-950 text-white"
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </label>
              <label className="block text-sm font-bold text-slate-300">
                이메일
                <input
                  className="auth-input ui-input-dark mt-2 border-slate-700 bg-slate-950 text-white"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="student1@example.com"
                  required
                  type="email"
                  value={email}
                />
              </label>
              <label className="block text-sm font-bold text-slate-300">
                비밀번호
                <input
                  className="auth-input ui-input-dark mt-2 border-slate-700 bg-slate-950 text-white"
                  onChange={(event) => setPassword(event.target.value)}
                  type="text"
                  value={password}
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm font-bold text-slate-300">
                <input
                  checked={emailVerified}
                  className="auth-checkbox"
                  onChange={(event) => setEmailVerified(event.target.checked)}
                  type="checkbox"
                />
                이메일 인증 완료 상태로 생성
              </label>
              <button
                aria-busy={busyAction === "create"}
                className="ui-button ui-button-primary h-12 w-full border-emerald-600 bg-emerald-600 hover:border-emerald-500 hover:bg-emerald-500"
                disabled={busy}
                type="submit"
              >
                <Plus size={18} /> 계정 생성
              </button>
            </form>

            <section
              aria-busy={busy}
              className="rounded-card border border-slate-800 bg-slate-900 p-6"
            >
              <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                  <h2 aria-live="polite" className="text-xl font-black">
                    테스트 계정 {accounts.length}개
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    멤버십이 있는 계정은 삭제가 차단됩니다.
                  </p>
                </div>
                <button
                  aria-label="목록 새로고침"
                  aria-busy={busyAction === "refresh"}
                  className="ui-icon-button ui-button-on-dark"
                  disabled={busy}
                  onClick={() => void refresh()}
                  type="button"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={busyAction === "refresh" ? "animate-spin" : ""}
                    size={18}
                  />
                </button>
              </div>
              <div className="space-y-3">
                {accounts.map((account) => (
                  <article
                    className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-800 bg-slate-950 px-4 py-4"
                    key={account.id}
                  >
                    <div>
                      <p className="font-bold text-white">{account.display_name}</p>
                      <p className="mt-1 text-sm text-slate-400">{account.email}</p>
                      <p className="mt-2 text-xs text-slate-400">
                        인증 {account.email_verified ? "완료" : "대기"} · 세션{" "}
                        {account.session_count} · 멤버십 {account.membership_count}
                      </p>
                    </div>
                    <button
                      aria-busy={busyAction === `delete:${account.id}`}
                      className="ui-button ui-button-danger border-rose-500/30 bg-transparent px-3 text-sm text-rose-300 hover:bg-rose-500/10"
                      disabled={busy || account.membership_count > 0}
                      onClick={(event) =>
                        setDeletionConfirmation({ account, trigger: event.currentTarget })
                      }
                      type="button"
                    >
                      <Trash2 size={16} /> 삭제
                    </button>
                  </article>
                ))}
                {accounts.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-slate-700 px-4 py-10 text-center text-slate-400">
                    생성된 테스트 계정이 없습니다.
                  </p>
                ) : null}
              </div>
            </section>
          </div>
        )}
      </div>
      <ConfirmDialog
        appearance="dark"
        confirmLabel="테스트 계정 삭제"
        description={
          <>
            <strong className="font-bold text-white">{deletionConfirmation?.account.email}</strong>{" "}
            계정과 연결된 동의, 인증·재설정 토큰, 세션이 함께 삭제됩니다. 이 작업은 되돌릴 수
            없습니다.
          </>
        }
        onCancel={() => setDeletionConfirmation(undefined)}
        onConfirm={() => {
          if (deletionConfirmation !== undefined) void removeAccount(deletionConfirmation.account);
        }}
        open={deletionConfirmation !== undefined}
        returnFocusTo={deletionConfirmation?.trigger ?? null}
        title="테스트 계정을 삭제할까요?"
      />
    </main>
  );
}
