import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { ApiRequestError } from "../../api/auth";
import {
  getSocialConnections,
  linkSocialAccount,
  unlinkSocialAccount,
  isSocialProvider,
  socialProviderLabels,
  type SocialConnections,
  type SocialProvider,
} from "../../api/social-auth";

export function SocialConnectionsPanel(): React.JSX.Element | null {
  const [data, setData] = useState<SocialConnections>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // 2026-10-02 사용자 결정(총검수 I1-03): 비밀번호가 있는 계정은 연결 전에 현재 비밀번호를 다시 묻는다.
  const [confirming, setConfirming] = useState<SocialProvider>();
  const [password, setPassword] = useState("");
  const { search } = useLocation();
  // 2026-10-01 사용자 요청: 연결하고 돌아오면 결과와, 막혔다면 이유를 보여 준다(어느 계정인지는 숨김).
  useEffect(() => {
    const params = new URLSearchParams(search);
    const value = params.get("provider") ?? "";
    const label = isSocialProvider(value) ? socialProviderLabels[value] : "이 회사";
    if (params.get("social_error") === "linked_elsewhere")
      setError(
        `이 ${label} 계정은 이미 다른 우리반 허브 계정에 연결돼 있어요. 그 계정에서 연결을 해제한 뒤 다시 연결해 주세요.`,
      );
    else if (params.get("social_error") === "provider_taken")
      setError(
        `이 계정에는 이미 다른 ${label} 계정이 연결돼 있어요. 아래에서 연결을 해제한 뒤 다시 연결해 주세요.`,
      );
    else if (params.get("social_linked") === "1") setNotice("빠른 로그인을 연결했어요.");
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    void getSocialConnections(controller.signal)
      .then(setData)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!data?.enabled) return null;
  const passwordRequired = data.password_required === true;
  async function change(provider: SocialProvider, linked: boolean, currentPassword?: string) {
    if (busy) return;
    if (!linked && passwordRequired && currentPassword === undefined) {
      setConfirming(provider);
      setPassword("");
      setError(undefined);
      setNotice(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (linked) {
        await unlinkSocialAccount(provider);
        setData(await getSocialConnections());
        setNotice(`${socialProviderLabels[provider]} 연결을 해제했어요.`);
      } else {
        window.location.assign(await linkSocialAccount(provider, currentPassword));
      }
    } catch (failure) {
      setError(connectionErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="social-connections-title" className="surface-panel mt-6 p-5 sm:p-6">
      <h2 className="text-lg font-bold text-app-text" id="social-connections-title">
        빠른 로그인 연결
      </h2>
      <p className="mt-2 text-sm leading-6 text-app-muted">
        직접 연결한 계정으로 로그인할 수 있어요. 마지막 로그인 방법은 해제할 수 없어요.
      </p>
      <p className="mt-2 text-sm leading-6 text-app-muted">
        빠른 가입으로 비밀번호를 만들지 않았다면,{" "}
        <Link
          className="inline-flex min-h-11 items-center font-bold underline"
          to="/forgot-password"
        >
          이메일로 비밀번호 설정
        </Link>
        을 할 수 있어요. 비밀번호 변경·탈퇴 시에는 설정한 비밀번호로 확인해요.
      </p>
      <ul className="mt-4 space-y-3">
        {data.providers?.map((provider) => {
          const linked = data.connections.includes(provider);
          return (
            <li key={provider} className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {socialProviderLabels[provider]} · {linked ? "연결됨" : "연결 안 됨"}
              </span>
              <button
                type="button"
                className="ui-button ui-button-secondary min-h-11"
                disabled={busy}
                onClick={() => void change(provider, linked)}
                aria-label={`${socialProviderLabels[provider]} ${linked ? "연결 해제" : "연결"}`}
              >
                {linked ? "연결 해제" : "연결"}
              </button>
              {confirming === provider ? (
                <form
                  className="basis-full space-y-2 rounded-xl border border-app-border p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (password.length > 0) void change(provider, false, password);
                  }}
                >
                  <label
                    className="block text-sm font-bold text-app-text"
                    htmlFor={`social-link-password-${provider}`}
                  >
                    본인 확인을 위해 현재 비밀번호를 입력해 주세요
                  </label>
                  <input
                    autoComplete="current-password"
                    autoFocus
                    className="auth-input h-11"
                    id={`social-link-password-${provider}`}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    value={password}
                  />
                  <div className="flex gap-2">
                    <button
                      className="ui-button ui-button-primary min-h-11"
                      disabled={busy || password.length === 0}
                      type="submit"
                    >
                      확인하고 {socialProviderLabels[provider]} 연결
                    </button>
                    <button
                      className="ui-button ui-button-secondary min-h-11"
                      onClick={() => setConfirming(undefined)}
                      type="button"
                    >
                      취소
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-success-text">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

function connectionErrorMessage(failure: unknown): string {
  if (failure instanceof ApiRequestError) {
    if (failure.code === "SOCIAL_LAST_LOGIN_METHOD")
      return "마지막 로그인 방법은 해제할 수 없어요. 다른 계정을 먼저 연결해 주세요.";
    if (failure.code === "INVALID_CREDENTIALS") return "현재 비밀번호가 맞지 않아요.";
    if (failure.code === "SOCIAL_RECENT_LOGIN_REQUIRED")
      return "보안을 위해 로그아웃 후 다시 로그인하고, 10분 안에 연결해 주세요.";
  }
  return failure instanceof Error ? failure.message : "계정 연결을 변경하지 못했어요.";
}
