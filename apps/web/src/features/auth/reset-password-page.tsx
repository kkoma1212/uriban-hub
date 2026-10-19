import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { z } from "zod";

import { ApiRequestError } from "../../api/auth";
import { confirmPasswordReset } from "../../api/password-reset";
import { newPasswordSchema, passwordConfirmationSchema } from "../../lib/password-policy";
import { PageHeader } from "../layout/page-header";
import { AuthShell, LoginMobileHeader } from "./auth-shell";
import { useRequestCooldown } from "./request-cooldown";

const resetPasswordSchema = z
  .object({
    confirm_password: passwordConfirmationSchema,
    new_password: newPasswordSchema,
  })
  .refine(({ confirm_password, new_password }) => confirm_password === new_password, {
    message: "새 비밀번호가 서로 일치하지 않아요.",
    path: ["confirm_password"],
  });

type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;

export function readAndClearPasswordResetToken(): string | null {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get("token");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

export function ResetPasswordPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const navigate = useNavigate();
  const tokenRef = useRef<string | null>(null);
  const [showPasswords, setShowPasswords] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<ResetPasswordForm>({
    defaultValues: { confirm_password: "", new_password: "" },
    resolver: zodResolver(resetPasswordSchema),
  });

  if (tokenRef.current === null && window.location.hash !== "") {
    tokenRef.current = readAndClearPasswordResetToken();
  }

  const submit = handleSubmit(async (values) => {
    const token = tokenRef.current;
    if (token === null || token.length === 0) return;

    setSubmitError(undefined);
    try {
      await confirmPasswordReset({ new_password: values.new_password, token });
      void navigate("/login", { replace: true, state: { passwordChanged: true } });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "TOKEN_INVALID_OR_EXPIRED") {
        setSubmitError("재설정 링크가 만료됐거나 이미 사용됐어요. 새 재설정 링크를 요청해 주세요.");
        return;
      }
      if (error instanceof ApiRequestError && error.code === "VALIDATION_FAILED") {
        setSubmitError(error.message);
        return;
      }
      setSubmitError("비밀번호를 재설정하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  });

  const hasToken = tokenRef.current !== null && tokenRef.current.length > 0;
  if (!hasToken) {
    return (
      <AuthShell mobileTopAligned>
        <LoginMobileHeader />
        <PageHeader
          className="mb-5 border-b border-app-border pb-5"
          description="메일에서 받은 재설정 정보를 확인해 주세요."
          eyebrow="계정 보호"
          title="새 비밀번호 설정"
        />
        <div className="rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6">
          <div aria-live="assertive" role="alert">
            <div className="mx-auto grid size-12 place-items-center rounded-xl bg-amber-50">
              <CircleAlert aria-hidden="true" className="text-amber-600" size={24} />
            </div>
            <h2 className="mt-4 text-2xl font-extrabold tracking-[-0.04em] text-app-text">
              재설정 정보가 없어요
            </h2>
            <p className="mx-auto mt-3 max-w-sm break-keep text-sm leading-6 text-app-muted">
              메일에 있는 비밀번호 재설정 버튼을 다시 눌러 주세요.
            </p>
          </div>
          <Link
            className="ui-button ui-button-primary mt-6 min-h-12 rounded-2xl px-6"
            to="/forgot-password"
          >
            새 링크 요청하기
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
        description="변경이 완료되면 모든 기기에서 로그아웃되고 새 비밀번호로 다시 로그인해야 해요."
        eyebrow="계정 보호"
        title="새 비밀번호 설정"
      />

      <form
        className="space-y-4 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6"
        noValidate
        onSubmit={submit}
      >
        <div>
          <label className="auth-label" htmlFor="reset-new-password">
            새 비밀번호 <span aria-hidden="true">(필수)</span>
          </label>
          <div className="relative">
            <input
              aria-describedby={
                errors.new_password === undefined
                  ? "reset-password-rules"
                  : "reset-password-rules reset-new-password-error"
              }
              aria-invalid={errors.new_password !== undefined}
              aria-required="true"
              autoComplete="new-password"
              className="auth-input pr-12"
              id="reset-new-password"
              required
              type={showPasswords ? "text" : "password"}
              {...register("new_password")}
            />
            <button
              aria-label={showPasswords ? "새 비밀번호 숨기기" : "새 비밀번호 보기"}
              className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-app-muted hover:text-app-text"
              onClick={() => setShowPasswords((visible) => !visible)}
              type="button"
            >
              {showPasswords ? (
                <EyeOff aria-hidden="true" size={20} />
              ) : (
                <Eye aria-hidden="true" size={20} />
              )}
            </button>
          </div>
          <p className="mt-2 text-sm text-app-muted" id="reset-password-rules">
            문자와 숫자를 모두 포함해 6자 이상 입력해 주세요. 길이 상한은 없으며 한글·공백·기호도
            사용할 수 있어요.
          </p>
          {errors.new_password?.message === undefined ? null : (
            <p
              className="mt-2 text-sm font-medium text-rose-600"
              id="reset-new-password-error"
              role="alert"
            >
              {errors.new_password.message}
            </p>
          )}
        </div>

        <div>
          <label className="auth-label" htmlFor="reset-confirm-password">
            새 비밀번호 확인 <span aria-hidden="true">(필수)</span>
          </label>
          <input
            aria-describedby={
              errors.confirm_password === undefined ? undefined : "reset-confirm-password-error"
            }
            aria-invalid={errors.confirm_password !== undefined}
            aria-required="true"
            autoComplete="new-password"
            className="auth-input"
            id="reset-confirm-password"
            required
            type={showPasswords ? "text" : "password"}
            {...register("confirm_password")}
          />
          {errors.confirm_password?.message === undefined ? null : (
            <p
              className="mt-2 text-sm font-medium text-rose-600"
              id="reset-confirm-password-error"
              role="alert"
            >
              {errors.confirm_password.message}
            </p>
          )}
        </div>

        {submitError === undefined ? null : (
          <div
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            <p>{submitError}</p>
            <Link
              className="mt-2 inline-flex min-h-11 items-center rounded-lg font-bold underline"
              to="/forgot-password"
            >
              새 링크 요청하기
            </Link>
          </div>
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
          {isSubmitting ? "변경하는 중" : "새 비밀번호로 변경"}
        </button>
      </form>
    </AuthShell>
  );
}
