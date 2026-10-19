import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { confirmEmail } from "../../api/auth";
import { PageHeader } from "../layout/page-header";
import { AuthShell, LoginMobileHeader } from "./auth-shell";

type VerificationState = "failed" | "loading" | "missing" | "success";

export function readAndClearVerificationToken(): string | null {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get("token");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

export function VerifyEmailPage(): React.JSX.Element {
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const [state, setState] = useState<VerificationState>("loading");

  if (tokenRef.current === null && window.location.hash !== "") {
    tokenRef.current = readAndClearVerificationToken();
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const token = tokenRef.current;
    if (token === null || token.length === 0) {
      setState("missing");
      return;
    }

    void confirmEmail(token)
      .then(() => setState("success"))
      .catch(() => setState("failed"));
  }, []);

  const content = {
    loading: {
      icon: (
        <LoaderCircle aria-hidden="true" className="animate-spin text-role-primary" size={30} />
      ),
      title: "이메일을 인증하고 있어요",
      description: "잠시만 기다려 주세요. 이 화면은 자동으로 처리됩니다.",
    },
    success: {
      icon: <CheckCircle2 aria-hidden="true" className="text-emerald-600" size={32} />,
      title: "이메일 확인이 완료됐어요!",
      description: "이제 로그인하면 선생님이 알려준 반 초대 코드로 참여를 요청할 수 있어요.",
    },
    failed: {
      icon: <CircleAlert aria-hidden="true" className="text-rose-600" size={32} />,
      title: "인증 링크를 사용할 수 없어요",
      // 지금 가입 인증은 로그인 뒤 6자리 인증번호 입력이다. 옛 링크 안내를 그 흐름에 맞춘다(총검수 B3-08).
      description:
        "링크가 만료됐거나 이미 사용됐어요. 로그인하면 이메일로 받은 6자리 인증번호를 입력하는 화면이 나와요.",
    },
    missing: {
      icon: <CircleAlert aria-hidden="true" className="text-amber-600" size={32} />,
      title: "인증 정보가 없어요",
      description: "로그인하면 이메일로 받은 6자리 인증번호를 입력하는\u00a0화면이 나와요.",
    },
  }[state];

  return (
    <AuthShell mobileTopAligned>
      <LoginMobileHeader />
      <PageHeader
        className="mb-5 border-b border-app-border pb-5"
        description="이메일 소유 확인 상태와 다음 행동을 확인해요."
        eyebrow="계정 확인"
        title="이메일 확인"
      />
      <div
        aria-busy={state === "loading"}
        className="rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6"
      >
        <div
          aria-live={state === "failed" || state === "missing" ? "assertive" : "polite"}
          role={state === "failed" || state === "missing" ? "alert" : "status"}
        >
          <div className="mx-auto grid size-12 place-items-center rounded-xl bg-app-surface-muted">
            {content.icon}
          </div>
          <h2 className="mt-4 text-2xl font-extrabold tracking-[-0.04em] text-app-text">
            {content.title}
          </h2>
          <p className="mx-auto mt-3 max-w-sm break-keep text-sm leading-6 text-app-muted">
            {content.description}
          </p>
        </div>
        {state !== "loading" && (
          <Link className="ui-button ui-button-primary mt-6 h-12 rounded-2xl px-6" to="/login">
            {state === "missing" ? "로그인 화면에서 다시 시작" : "로그인 화면으로"}
          </Link>
        )}
      </div>
    </AuthShell>
  );
}
