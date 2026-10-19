import { CheckCircle2, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { ApiRequestError, confirmGuardianConsent } from "../../api/auth";
import { PageHeader } from "../layout/page-header";
import { LegalDocumentLinks } from "../legal/legal-document-links";
import { useConsentDocuments } from "../legal/use-consent-documents";
import { AuthShell, LoginMobileHeader } from "./auth-shell";

type ConfirmationState = "failed" | "idle" | "missing" | "submitting" | "success";

export function readAndClearGuardianConsentToken(): string | null {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get("token");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

export function GuardianConsentPage(): React.JSX.Element {
  const tokenRef = useRef<string | null>(null);
  const tokenReadRef = useRef(false);
  const submittingRef = useRef(false);
  if (!tokenReadRef.current) {
    tokenReadRef.current = true;
    tokenRef.current = window.location.hash === "" ? null : readAndClearGuardianConsentToken();
  }

  const hasToken = tokenRef.current !== null && tokenRef.current.length > 0;
  const legal = useConsentDocuments(hasToken);
  const [state, setState] = useState<ConfirmationState>(hasToken ? "idle" : "missing");
  const [errorMessage, setErrorMessage] = useState<string>();

  async function confirm(): Promise<void> {
    const token = tokenRef.current;
    if (!legal.ready || token === null || token.length === 0 || submittingRef.current) return;

    submittingRef.current = true;
    setErrorMessage(undefined);
    setState("submitting");
    try {
      await confirmGuardianConsent(token, legal.documents);
      setState("success");
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        ["TOKEN_INVALID_OR_EXPIRED", "LEGAL_DOCUMENTS_CHANGED"].includes(error.code)
      ) {
        setErrorMessage(
          "동의 링크가 만료됐거나 이미 사용됐어요. 학생에게 새 요청을 부탁해 주세요.",
        );
      } else {
        setErrorMessage("보호자 동의를 완료하지 못했어요. 잠시 후 다시 시도해 주세요.");
      }
      setState("failed");
    } finally {
      submittingRef.current = false;
    }
  }

  if (state === "missing") {
    return (
      <AuthShell mobileTopAligned>
        <LoginMobileHeader />
        <PageHeader
          className="mb-5 border-b border-app-border pb-5"
          description="보호자 동의 요청 정보를 확인해 주세요."
          eyebrow="학생 가입 보호"
          title="보호자 동의"
        />
        <div className="min-w-0 rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6">
          <div aria-live="assertive" role="alert">
            <div className="mx-auto grid size-12 place-items-center rounded-xl bg-amber-50">
              <CircleAlert aria-hidden="true" className="text-amber-600" size={26} />
            </div>
            <h2 className="mt-4 break-keep text-2xl font-extrabold tracking-[-0.04em] text-app-text">
              동의 정보가 없어요
            </h2>
            <p className="mx-auto mt-3 max-w-sm break-keep text-sm leading-6 text-app-muted">
              보호자 이메일에 있는 동의 버튼을 다시 눌러 주세요.
            </p>
          </div>
          <Link
            className="ui-button ui-button-secondary mt-6 min-h-11 whitespace-normal rounded-2xl px-6 text-center"
            to="/sign-up"
          >
            가입 화면으로
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (state === "success") {
    return (
      <AuthShell mobileTopAligned>
        <LoginMobileHeader />
        <PageHeader
          className="mb-5 border-b border-app-border pb-5"
          description="보호자 동의 처리 결과를 확인해요."
          eyebrow="학생 가입 보호"
          title="보호자 동의"
        />
        <div className="min-w-0 rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6">
          <div aria-live="polite" role="status">
            <div className="mx-auto grid size-12 place-items-center rounded-xl bg-emerald-50">
              <CheckCircle2 aria-hidden="true" className="text-emerald-600" size={28} />
            </div>
            <h2 className="mt-4 break-keep text-2xl font-extrabold tracking-[-0.04em] text-app-text">
              보호자 동의가 완료됐어요
            </h2>
            <p className="mx-auto mt-3 max-w-sm break-keep text-sm leading-6 text-app-muted">
              학생이 가입 화면에서 동의 상태를 확인한 뒤 계정 정보를 입력할 수 있어요. 이제 이 창을
              닫아도 됩니다.
            </p>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell mobileTopAligned>
      <LoginMobileHeader />
      <PageHeader
        className="mb-5 border-b border-app-border pb-5"
        description="메일을 연 것만으로는 동의되지 않아요. 아래 내용을 확인하고 직접 동의해 주세요."
        eyebrow="학생 가입 보호"
        title="보호자 동의"
      />

      <div className="min-w-0 space-y-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6">
        <div className="flex min-w-0 items-start gap-3 rounded-2xl bg-app-surface-muted p-4">
          <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-role-primary" size={23} />
          <div className="min-w-0 text-sm leading-6 text-app-text">
            <p className="break-keep font-semibold">
              법정대리인(보호자)으로서 학생이 우리반 허브 계정을 만드는 것에 동의합니다.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-app-muted">
              <li className="break-keep">
                동의 후 학생이 기본 이름·이메일·비밀번호로 가입하고, 로그인한 뒤 이메일로 받은 6자리
                인증번호를 입력해요.
              </li>
              <li className="break-keep">
                보호자 이메일·동의 상태·시점만 기록하며 보호자의 이름·전화번호·생년월일·증빙서류는
                받지 않아요.
              </li>
              {/* 학생 생년월일 수집이 요약에서 빠져 있었다(총검수 B3-14). */}
              <li className="break-keep">
                학생이 생년월일을 입력하면 만 14세 확인과 담임 선생님의 학생 확인에 쓰고, 생일
                알림은 학생이 켤 때만 보여요.
              </li>
            </ul>
          </div>
        </div>

        <section
          aria-label="보호자 동의 대상 문서"
          className="rounded-2xl border border-app-border p-4 text-sm leading-6 text-app-muted"
        >
          <h2 className="font-bold text-app-text">동의 대상 문서</h2>
          <p className="mt-2">
            학생·보호자의 개인정보 항목, 목적, 보유기간과 거부권을 확인해 주세요. 동의하지 않으면
            학생 계정을 만들 수 없어요.
          </p>
          <LegalDocumentLinks documents={legal.documents} />
          <p className="mt-2 text-xs">
            전문은 새 탭에서 열립니다. 문서를 여는 것만으로는 동의되지 않습니다.
          </p>
          {(import.meta.env.DEV || import.meta.env.MODE === "preview") && (
            <p className="mt-2 text-xs">
              현재는 테스트용 동의 화면이며, 정식 문서 게시 전에는 실제 보호자 동의를 받지 않습니다.
            </p>
          )}
        </section>

        {legal.error && (
          <div role="alert" className="text-sm text-danger-text">
            <p>{legal.error}</p>
            <button
              type="button"
              className="ui-button ui-button-secondary mt-2"
              onClick={legal.reload}
            >
              다시 불러오기
            </button>
          </div>
        )}
        {!legal.ready && !legal.error && (
          <p role="status" className="text-sm text-app-muted">
            동의 대상 문서를 확인하고 있어요.
          </p>
        )}
        {state === "failed" && errorMessage !== undefined && (
          <div
            aria-live="assertive"
            className="min-w-0 break-keep rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium leading-6 text-rose-700"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <button
          aria-busy={state === "submitting"}
          className="ui-button ui-button-primary min-h-12 w-full whitespace-normal rounded-2xl px-5 text-center"
          disabled={!legal.ready || state === "submitting"}
          onClick={() => void confirm()}
          type="button"
        >
          {state === "submitting" && (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />
          )}
          {state === "submitting" ? "동의 처리 중" : "동의합니다"}
        </button>
      </div>
    </AuthShell>
  );
}
