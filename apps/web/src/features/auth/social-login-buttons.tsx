import { useEffect, useState } from "react";
import { beginSocialLogin, getSocialProviders, type SocialProvider } from "../../api/social-auth";

/*
 * 2026-10-01 사용자 요청: "구글로 계속" 글자 버튼 대신 각 회사 로그인 버튼 지침의 모양을 따른다.
 * 구글 = 흰 바탕·회색 테두리·네 색 G, 카카오 = #FEE500 바탕·검은 말풍선·85% 검정 글씨,
 * 네이버 = #03C75A 바탕·흰 N·흰 글씨. 로고는 외부 요청 없이 그린다(공식 로고 모양).
 */
const PROVIDER_BUTTONS: Record<
  SocialProvider,
  { className: string; label: string; short: string; logo: React.JSX.Element }
> = {
  google: {
    className: "border border-[#747775] bg-white text-[#1f1f1f] hover:bg-[#f8f9fa]",
    label: "Google 계정으로 로그인",
    short: "Google",
    logo: (
      <svg aria-hidden="true" height="18" viewBox="0 0 48 48" width="18">
        <path
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          fill="#EA4335"
        />
        <path
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          fill="#4285F4"
        />
        <path
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          fill="#FBBC05"
        />
        <path
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          fill="#34A853"
        />
      </svg>
    ),
  },
  kakao: {
    className: "bg-[#FEE500] text-black/85 hover:bg-[#f5dc00]",
    label: "카카오 로그인",
    short: "카카오",
    logo: (
      <svg aria-hidden="true" height="18" viewBox="0 0 24 24" width="18">
        <path
          d="M12 3C6.48 3 2 6.51 2 10.84c0 2.8 1.86 5.25 4.66 6.63l-.95 3.47c-.08.3.26.54.52.37l4.13-2.73c.54.07 1.09.11 1.64.11 5.52 0 10-3.51 10-7.85S17.52 3 12 3z"
          fill="#000000"
        />
      </svg>
    ),
  },
  naver: {
    className: "bg-[#03C75A] text-white hover:bg-[#02b350]",
    label: "네이버 로그인",
    short: "네이버",
    logo: (
      <svg aria-hidden="true" height="15" viewBox="0 0 24 24" width="15">
        <path d="M16.27 12.85 7.38 0H0v24h7.73V11.15L16.62 24H24V0h-7.73z" fill="#ffffff" />
      </svg>
    ),
  },
};

export { PROVIDER_BUTTONS };

export function SocialLoginButtons(): React.JSX.Element | null {
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void getSocialProviders(controller.signal)
      .then(setProviders)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    // 브라우저 '뒤로'로 이 화면이 캐시에서 되살아나면 누른 상태(버튼 꺼짐)가 남는다(총검수 B3-16).
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  if (!providers.length) return null;
  async function begin(provider: SocialProvider, intent: "login" | "signup_over_14") {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      window.location.assign(await beginSocialLogin(provider, intent));
    } catch {
      setError("빠른 로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
      setBusy(false);
    }
  }
  return (
    <section aria-label="빠른 로그인" className="mt-5 space-y-3">
      <div className="flex items-center gap-3 text-xs text-app-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-app-border" />
        간편 로그인
        <span className="h-px flex-1 bg-app-border" />
      </div>
      {/* 2026-10-01 사용자 요청: 버튼이 위아래로 쌓여 카드·칠판이 길어지지 않게 한 줄에 나란히 둔다.
          두 개 이상이면 로고+짧은 이름, 하나면 회사 지침의 전체 문구. 읽기 프로그램에는 전체 문구. */}
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))`,
        }}
      >
        {providers.map((provider) => {
          const button = PROVIDER_BUTTONS[provider];
          return (
            <button
              key={provider}
              aria-label={button.label}
              className={`flex min-h-11 w-full min-w-0 items-center justify-center gap-1 rounded-xl px-1 text-[14px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2 disabled:opacity-60 sm:gap-2 sm:px-2 ${button.className}`}
              data-social-provider={provider}
              type="button"
              disabled={busy}
              // 2026-10-01 사용자 요청: 누르면 바로 로그인. 연결 안 된 계정이면 다음 화면에서 처음 가입을 고른다.
              onClick={() => void begin(provider, "login")}
            >
              <span className="flex shrink-0 items-center">{button.logo}</span>
              <span className="whitespace-nowrap">
                {providers.length > 1 ? button.short : button.label}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}
