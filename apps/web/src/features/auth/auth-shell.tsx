import { ProductWordmark } from "../layout/app-shell";
import { SiteFooter } from "../layout/site-footer";
import { AuthDesktopChalkboard, AuthMobileChalkboard } from "./auth-chalkboard";
import { RequestCooldownNotice } from "./request-cooldown";

interface AuthShellProps {
  children: React.ReactNode;
  desktopBottomAligned?: boolean;
  desktopVisual?: React.ReactNode;
  /** 오른쪽 카드 길이가 바뀌는 화면(가입·로그인 안내): 평소엔 카드와 같은 높이로 맞추고, 길어지면 44rem에서 멈춘다. */
  fixedContextPanel?: boolean;
  mobileTopAligned?: boolean;
  showRequestCooldownNotice?: boolean;
}

export function AuthShell({
  children,
  desktopBottomAligned = false,
  desktopVisual,
  fixedContextPanel = false,
  mobileTopAligned = false,
  showRequestCooldownNotice = true,
}: AuthShellProps): React.JSX.Element {
  return (
    <main className="flex min-h-dvh flex-col bg-app-canvas text-app-text">
      {/*
       * 2026-09-27 확정 시안: PC는 제품 이름(위) → 칠판 한 장(왼쪽) + 흰 카드(오른쪽)를 한 줄에 두고
       * 두 칸의 윗선 · 아랫선을 맞춘다(같은 높이로 늘림). 약관 · 저작권은 맨 아래 전체 폭 한 줄.
       */}
      <div
        className="relative mx-auto flex w-full max-w-[1280px] flex-1 flex-col min-[900px]:px-12 min-[900px]:pb-8 min-[900px]:pt-9 xl:px-16"
        data-auth-desktop-alignment={desktopBottomAligned ? "bottom" : "center"}
      >
        {/* ProductWordmark 자체가 inline-flex라 hidden을 감싸는 쪽에 둔다(휴대폰은 칠판 머리가 이름을 보여 줌). */}
        <div className="hidden self-start min-[900px]:block">
          <ProductWordmark size="lg" to="/" />
        </div>
        <div className="flex-1 min-[900px]:my-auto min-[900px]:grid min-[900px]:flex-none min-[900px]:grid-cols-[minmax(0,1fr)_minmax(24rem,28rem)] min-[900px]:items-stretch min-[900px]:gap-8 min-[900px]:pt-8">
          <aside
            className={`hidden min-w-0 min-[900px]:flex ${
              fixedContextPanel ? "min-[900px]:max-h-[44rem]" : ""
            }`}
            data-auth-context-panel="compact"
          >
            {desktopVisual ?? <AuthDesktopChalkboard />}
          </aside>

          <section
            className={`relative flex justify-center px-5 sm:px-8 min-[900px]:px-0 min-[900px]:py-0 ${
              mobileTopAligned
                ? "items-start pb-6 pt-[max(1.25rem,env(safe-area-inset-top))] sm:max-[900px]:py-8"
                : "items-center py-8"
            }`}
            data-auth-mobile-alignment={mobileTopAligned ? "top" : "center"}
          >
            <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-role-soft to-transparent min-[900px]:hidden" />
            <div
              className="relative w-full max-w-[560px] min-[900px]:max-w-none min-[900px]:rounded-[1.6rem] min-[900px]:bg-app-surface min-[900px]:px-9 min-[900px]:py-9 min-[900px]:shadow-card"
              data-auth-card
            >
              {showRequestCooldownNotice ? <RequestCooldownNotice /> : null}
              {children}
            </div>
          </section>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1280px] px-5 pb-6 sm:px-8 min-[900px]:px-12 xl:px-16">
        {/* 약관 · 저작권 · 문의 한 줄 배치는 공용 SiteFooter가 모든 화면에 같게 적용한다. */}
        <SiteFooter />
      </div>
    </main>
  );
}

/** 휴대폰 머리. 로그인 첫 화면만 칠판(확정 시안), 가입 등 이어지는 화면은 작은 이름 줄. */
export function LoginMobileHeader({
  chalkboard = false,
}: {
  chalkboard?: boolean;
}): React.JSX.Element {
  return (
    <div className="mb-5 min-[900px]:hidden" data-login-mobile-header="compact">
      {chalkboard ? (
        <>
          <AuthMobileChalkboard wordmark={<ProductWordmark tone="dark" to="/" />} />
          <p className="sr-only">학생과 선생님이 함께 쓰는 우리 반 공간이에요.</p>
        </>
      ) : (
        <>
          <ProductWordmark to="/" />
          <p className="mt-2 break-keep text-sm font-semibold leading-5 text-app-muted">
            학생과 선생님이 함께 쓰는 우리 반 공간이에요.
          </p>
        </>
      )}
    </div>
  );
}
