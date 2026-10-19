import { Clock3, LoaderCircle, MailWarning } from "lucide-react";
import type { FieldErrors, UseFormRegister } from "react-hook-form";

import { SignUpFieldError as FieldError } from "./sign-up-field-error";
import type { GuardianRequestState, SignUpForm } from "./sign-up-form";

function formatExpiration(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** 만 14세 미만 가입의 첫 관문: 보호자에게 동의 메일만 먼저 보낸다. */
export function GuardianConsentSection({
  cooldownSeconds,
  errors,
  guardianRequest,
  guardianRequestError,
  isGuardianChecking,
  isGuardianRequesting,
  legalReady,
  onCheck,
  onRequest,
  register,
}: {
  cooldownSeconds: number;
  errors: FieldErrors<SignUpForm>;
  guardianRequest: GuardianRequestState | undefined;
  guardianRequestError: string | undefined;
  isGuardianChecking: boolean;
  isGuardianRequesting: boolean;
  legalReady: boolean;
  onCheck: () => void;
  onRequest: () => void;
  register: UseFormRegister<SignUpForm>;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="guardian-consent-request-title"
      className="min-w-0 rounded-2xl border border-app-border p-4"
    >
      <h2 className="font-bold text-app-text" id="guardian-consent-request-title">
        보호자 동의 요청
      </h2>
      <p className="mt-1 break-keep text-sm leading-6 text-app-muted">
        먼저 보호자에게 동의 메일만 보내요. 승인 전에는 학생의 이메일, 기본 이름, 비밀번호를 서버로
        보내지 않습니다.
      </p>

      <div className="mt-4">
        <label className="auth-label" htmlFor="guardian-email">
          보호자 이메일
        </label>
        <input
          aria-describedby={
            errors.guardian_email === undefined ? undefined : "sign-up-guardian-email-error"
          }
          aria-invalid={errors.guardian_email === undefined ? undefined : true}
          autoComplete="email"
          className="auth-input"
          disabled={guardianRequest?.status === "pending" || isGuardianChecking}
          id="guardian-email"
          inputMode="email"
          placeholder="guardian@example.com"
          type="email"
          {...register("guardian_email")}
        />
        <FieldError id="sign-up-guardian-email-error" message={errors.guardian_email?.message} />
      </div>

      <div aria-live="polite" className="mt-4 min-w-0">
        {guardianRequest?.status === "pending" && (
          <div className="rounded-xl bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-800">
            <p className="flex min-w-0 items-start gap-2 font-semibold">
              <Clock3 aria-hidden="true" className="mt-1 shrink-0" size={16} />
              <span className="min-w-0 break-keep">보호자 동의를 기다리고 있어요.</span>
            </p>
            <p className="mt-1 break-words text-xs">
              유효 시간: {formatExpiration(guardianRequest.expiresAt)}
            </p>
            {/* 동의 진행 정보는 이 화면에만 있어 새로고침하면 사라진다(총검수 B3-01, 사용자 결정: 안내만). */}
            <p className="mt-1 break-keep text-xs font-semibold" data-guardian-keep-open>
              보호자가 동의할 때까지 이 화면을 열어 두세요. 닫거나 새로고침하면 처음부터 다시
              요청해야 해요.
            </p>
          </div>
        )}
        {guardianRequest?.status === "delivery_failed" && (
          <div
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm font-medium leading-6 text-rose-700"
            role="alert"
          >
            <p className="flex min-w-0 items-start gap-2">
              <MailWarning aria-hidden="true" className="mt-1 shrink-0" size={16} />
              <span className="min-w-0 break-keep">
                메일 발송에 실패했습니다. 다시 요청해 주세요.
              </span>
            </p>
          </div>
        )}
        {guardianRequest?.status === "expired" && (
          <div
            className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm font-medium leading-6 text-rose-700"
            role="alert"
          >
            동의 요청이 만료됐어요. 새 메일을 요청해 주세요.
          </div>
        )}
        {guardianRequestError !== undefined && (
          <div
            className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm font-medium leading-6 text-rose-700"
            role="alert"
          >
            {guardianRequestError}
          </div>
        )}
      </div>

      <div className="mt-4 grid min-w-0 gap-2">
        {(guardianRequest === undefined ||
          guardianRequest.status === "delivery_failed" ||
          guardianRequest.status === "expired") && (
          <button
            aria-busy={isGuardianRequesting}
            className="ui-button ui-button-primary min-h-11 w-full whitespace-normal rounded-xl px-4 text-center"
            disabled={!legalReady || isGuardianRequesting || cooldownSeconds > 0}
            onClick={onRequest}
            type="button"
          >
            {isGuardianRequesting && (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            )}
            {guardianRequest === undefined ? "보호자 동의 요청하기" : "다시 요청하기"}
          </button>
        )}
        {guardianRequest?.status === "pending" && (
          <button
            aria-busy={isGuardianChecking}
            className="ui-button ui-button-secondary min-h-11 w-full whitespace-normal rounded-xl px-4 text-center"
            disabled={isGuardianChecking}
            onClick={onCheck}
            type="button"
          >
            {isGuardianChecking && (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            )}
            동의 상태 확인
          </button>
        )}
      </div>
    </section>
  );
}
