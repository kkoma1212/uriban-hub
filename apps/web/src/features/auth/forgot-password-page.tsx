import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { ApiRequestError } from "../../api/auth";
import { requestPasswordReset } from "../../api/password-reset";
import { PUBLIC_OPERATOR } from "../legal/legal-documents";
import { PageHeader } from "../layout/page-header";
import { AuthShell, LoginMobileHeader } from "./auth-shell";
import { useRequestCooldown } from "./request-cooldown";

const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("이메일 형식을 확인해 주세요.")),
});

type ForgotPasswordForm = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const [requestAccepted, setRequestAccepted] = useState(false);
  const [resetUnavailable, setResetUnavailable] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ForgotPasswordForm>({
    defaultValues: { email: "" },
    resolver: zodResolver(forgotPasswordSchema),
  });

  const submit = handleSubmit(async (values) => {
    setSubmitError(undefined);
    setResetUnavailable(false);
    try {
      await requestPasswordReset({ email: values.email.trim().toLowerCase() });
      setRequestAccepted(true);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "PASSWORD_RESET_UNAVAILABLE") {
        setResetUnavailable(true);
        setSubmitError("현재 비밀번호 찾기를 이용할 수 없어요.");
        return;
      }
      if (error instanceof ApiRequestError && error.code === "RATE_LIMITED") {
        setSubmitError("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      if (error instanceof ApiRequestError && error.code === "RATE_LIMIT_SERVICE_UNAVAILABLE") {
        setSubmitError("요청 보호 서비스를 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setSubmitError("재설정 메일을 요청하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  });

  if (requestAccepted) {
    return (
      <AuthShell mobileTopAligned>
        <LoginMobileHeader />
        <PageHeader
          className="mb-5 border-b border-app-border pb-5"
          description="재설정 메일 요청 결과를 확인해요."
          eyebrow="계정 복구"
          title="비밀번호 찾기"
        />
        <div className="rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6">
          <div aria-live="polite" role="status">
            <div className="mx-auto grid size-12 place-items-center rounded-xl bg-emerald-50">
              <CheckCircle2 aria-hidden="true" className="text-emerald-600" size={24} />
            </div>
            <h2 className="mt-4 text-2xl font-extrabold tracking-[-0.04em] text-app-text">
              메일을 확인해 주세요
            </h2>
            <p className="mx-auto mt-3 max-w-sm break-keep text-sm leading-6 text-app-muted">
              입력한 이메일로 가입된 활성 계정이 있다면 재설정 메일을 보냈어요. 링크는 30분 동안 한
              번만 사용할 수 있어요.
            </p>
          </div>
          <Link className="ui-button ui-button-primary mt-6 min-h-12 rounded-2xl px-6" to="/login">
            로그인 화면으로
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell mobileTopAligned>
      <LoginMobileHeader />
      <PageHeader
        className="mb-5 border-b border-app-border pb-5"
        description="가입할 때 사용한 이메일을 입력하면 재설정 링크를 보내드려요."
        eyebrow="비밀번호 찾기"
        title="비밀번호 찾기"
      />

      <form
        className="space-y-4 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6"
        noValidate
        onSubmit={submit}
      >
        <div>
          <label className="auth-label" htmlFor="password-reset-email">
            이메일 <span aria-hidden="true">(필수)</span>
          </label>
          <input
            aria-describedby={
              errors.email === undefined
                ? "password-reset-email-help"
                : "password-reset-email-error"
            }
            aria-invalid={errors.email !== undefined}
            aria-required="true"
            autoComplete="email"
            className="auth-input"
            id="password-reset-email"
            inputMode="email"
            placeholder="가입한 이메일 주소"
            required
            {...register("email")}
          />
          {errors.email?.message === undefined ? (
            <p className="mt-2 text-sm text-app-muted" id="password-reset-email-help">
              메일이 도착하지 않으면 스팸함도 확인해 주세요.
            </p>
          ) : (
            <p
              className="mt-2 text-sm font-medium text-rose-600"
              id="password-reset-email-error"
              role="alert"
            >
              {errors.email.message}
            </p>
          )}
        </div>

        {submitError === undefined ? null : (
          <p
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {submitError}
            {resetUnavailable ? (
              <a
                className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
                href={`mailto:${PUBLIC_OPERATOR.email}`}
              >
                운영자에게 문의하기
              </a>
            ) : null}
          </p>
        )}

        <button
          aria-busy={isSubmitting}
          className="ui-button ui-button-primary h-12 w-full"
          disabled={isSubmitting || cooldownSeconds > 0}
          type="submit"
        >
          {isSubmitting ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={19} />
          ) : (
            <KeyRound aria-hidden="true" size={19} />
          )}
          {isSubmitting ? "요청하는 중" : "재설정 메일 받기"}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-app-muted">
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold text-role-primary hover:underline"
          to="/login"
        >
          로그인으로 돌아가기
        </Link>
      </p>
    </AuthShell>
  );
}
