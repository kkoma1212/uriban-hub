import { useEffect, useState } from "react";
import { Link } from "react-router";

import { beginSocialLogin, socialProviderLabels, type SocialProvider } from "../../api/social-auth";

/*
 * 2026-10-01 사용자 결정: 자동 연결 없이 직접 연결. 연결 안 된 회사 계정으로 로그인하면 두 갈래를 보여 준다.
 * 같은 날 사용자 요청: 안내가 길어 카드·칠판이 늘어나지 않게 핵심 한 줄 + 처음 가입 버튼만 두고,
 * 기존 계정 연결 방법은 접어 둔다. 14세 미만은 보호자 동의 가입이 먼저다.
 */
export function SocialUnlinkedNotice({
  provider,
}: {
  provider: SocialProvider | undefined;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const label = provider === undefined ? undefined : socialProviderLabels[provider];
  useEffect(() => {
    // 브라우저 '뒤로'로 이 화면이 캐시에서 되살아나면 누른 상태(버튼 꺼짐)가 남는다(총검수 B3-16).
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  async function startSignup(): Promise<void> {
    if (provider === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      window.location.assign(await beginSocialLogin(provider, "signup_over_14"));
    } catch {
      setError("가입을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setBusy(false);
    }
  }
  return (
    <div
      role="alert"
      className="mt-4 rounded-xl border border-app-border bg-app-surface-muted px-4 py-3 text-sm leading-6 text-app-text"
      data-social-unlinked
    >
      <p className="font-bold">
        {label === undefined ? "이 계정은" : `이 ${label} 계정은`} 아직 연결되지 않았어요.
      </p>
      {provider === undefined ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            aria-busy={busy}
            className="ui-button ui-button-primary min-h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void startSignup()}
            type="button"
          >
            만 14세 이상 · {label}로 처음 가입
          </button>
          <Link
            className="inline-flex min-h-10 items-center text-xs font-bold text-role-primary underline"
            to="/sign-up"
          >
            만 14세 미만 가입
          </Link>
        </div>
      )}
      <details className="mt-2 text-xs leading-5 text-app-muted">
        <summary className="inline-flex min-h-8 cursor-pointer items-center font-bold text-app-text">
          기존 계정이 있다면?
        </summary>
        <p className="mt-1">
          위에서 이메일로 로그인한 뒤 <b className="text-app-text">설정 → 빠른 로그인 연결</b>에서
          연결해 주세요. 다음부터는 버튼 하나로 들어와요.
        </p>
      </details>
      {error ? <p className="mt-2 text-danger-text">{error}</p> : null}
    </div>
  );
}
