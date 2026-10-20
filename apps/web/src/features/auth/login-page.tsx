import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Eye, EyeOff, LoaderCircle, LogIn, QrCode } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation, useNavigate } from "react-router";
import { z } from "zod";

import { ApiRequestError, login } from "../../api/auth";
import { readPendingInviteCode } from "../../lib/invite-link";
import { AlertDialog } from "../layout/alert-dialog";
import { AuthShell, LoginMobileHeader } from "./auth-shell";
import { useRequestCooldown } from "./request-cooldown";
import { SocialLoginButtons } from "./social-login-buttons";
import { SocialUnlinkedNotice } from "./social-unlinked-notice";
import { isSocialProvider, type SocialProvider } from "../../api/social-auth";

interface LoginLocationState {
  accountDeleted?: boolean;
  passwordChanged?: boolean;
  signupRequested?: boolean;
  signupEmail?: string;
}

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    // 관리자 로그인은 관리자 화면 묶음(/admin/login)에만 있다(T-ADMIN-SPLIT, 2026-10-07).
    .refine(
      (identifier) => z.email().safeParse(identifier).success,
      "이메일 형식을 확인해 주세요.",
    ),
  password: z.string().min(1, "비밀번호를 입력해 주세요."),
});

type LoginForm = z.infer<typeof loginSchema>;

function providerFromQuery(search: string): SocialProvider | undefined {
  const value = new URLSearchParams(search).get("provider");
  return value !== null && isSocialProvider(value) ? value : undefined;
}

export function LoginPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as LoginLocationState | null;
  useEffect(() => {
    if (state?.accountDeleted !== true) return;
    const timer = window.setTimeout(() => {
      void navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: { ...state, accountDeleted: false } },
      );
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [location.hash, location.pathname, location.search, navigate, state]);
  const signupEmail =
    state?.signupRequested === true && z.email().safeParse(state.signupEmail).success
      ? state.signupEmail!
      : "";
  // 담임 QR(/join)로 들어온 학생은 로그인 화면에서 처음 멈춘다. 초대가 확인됐고 처음이면 가입하면 된다고
  // 알려 화면 사이를 헤매지 않게 한다(ux2 2026-10-15).
  const [invitePending] = useState(() => readPendingInviteCode() !== null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [showAttemptNotice, setShowAttemptNotice] = useState(false);
  useEffect(() => {
    if (!showAttemptNotice || submitError !== undefined) return;
    const timer = window.setTimeout(() => setShowAttemptNotice(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [showAttemptNotice, submitError]);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<LoginForm>({
    defaultValues: { email: signupEmail, password: "" },
    resolver: zodResolver(loginSchema),
  });

  const submit = handleSubmit(async (values) => {
    setSubmitError(undefined);
    setShowAttemptNotice(false);

    try {
      await login({ email: values.email.trim().toLowerCase(), password: values.password });
      void navigate("/bootstrap", { replace: true });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "INVALID_CREDENTIALS") {
        setShowAttemptNotice(true);
        setSubmitError("이메일 또는 비밀번호를 확인해 주세요.");
        return;
      }

      if (error instanceof ApiRequestError && error.code === "ACCOUNT_LOCKED") {
        setShowAttemptNotice(true);
        setSubmitError("로그인 시도가 잠시 제한됐어요. 잠시 후 다시 시도해 주세요.");
        return;
      }

      if (error instanceof ApiRequestError && error.code === "RATE_LIMITED") {
        setShowAttemptNotice(true);
        setSubmitError(error.message);
        return;
      }

      setSubmitError(error instanceof Error ? error.message : "로그인하지 못했습니다.");
    }
  });

  return (
    <AuthShell
      fixedContextPanel
      mobileTopAligned
      showRequestCooldownNotice={showAttemptNotice && submitError === undefined}
    >
      <LoginMobileHeader chalkboard />
      {/* 확정 시안: 제목 한 번 + 짧은 한 줄. 공용 PageHeader는 작은 머리글("로그인")이 제목과 겹쳐 쓰지 않는다. */}
      <header className="mb-5 sm:mb-6" data-page-header="compact">
        <h1 className="app-page-title">로그인</h1>
        <p className="app-page-description">가입한 이메일로 들어와요.</p>
      </header>

      {invitePending && state?.signupRequested !== true ? (
        <div
          className="mb-5 flex gap-3 rounded-2xl border border-role-border bg-role-soft px-4 py-4 text-sm leading-6 text-app-text"
          data-invite-pending="true"
          role="status"
        >
          <QrCode aria-hidden="true" className="mt-0.5 shrink-0 text-role-primary" size={20} />
          <div>
            <p className="font-bold">반 초대를 확인했어요.</p>
            <p className="mt-1">
              처음이면 아래 &lsquo;선생님·학생 가입&rsquo;에서 학생으로 가입하고, 계정이 있으면
              로그인해 주세요. 이 창에서 이어 가면 반 참여 화면에 초대 코드가 미리 채워져요.
            </p>
          </div>
        </div>
      ) : null}

      {state?.signupRequested === true ? (
        <div
          aria-live="polite"
          className="mb-5 flex gap-3 rounded-2xl border border-success-border bg-success-surface px-4 py-4 text-sm leading-6 text-success-text"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <div>
            <p>가입 요청을 접수했어요. 로그인해 다음 단계를 확인해 주세요.</p>
            <p className="mt-2">
              이미 가입했다면 기존 비밀번호로 로그인해 주세요. 기억나지 않으면 아래 비밀번호 찾기를
              이용해 주세요.
            </p>
          </div>
        </div>
      ) : null}

      {state?.passwordChanged === true ? (
        <div
          aria-live="polite"
          className="mb-5 flex gap-3 rounded-2xl border border-success-border bg-success-surface px-4 py-4 text-sm leading-6 text-success-text"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <p>비밀번호가 변경됐어요. 새 비밀번호로 다시 로그인해 주세요.</p>
        </div>
      ) : null}

      {state?.accountDeleted === true ? (
        <div
          aria-live="polite"
          className="mb-5 flex gap-3 rounded-2xl border border-success-border bg-success-surface px-4 py-4 text-sm leading-6 text-success-text"
          role="status"
        >
          <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <p>계정 삭제가 완료됐어요. 다시 이용하려면 새 계정을 만들어 주세요.</p>
        </div>
      ) : null}

      <form className="space-y-4" noValidate onSubmit={submit}>
        <div>
          <label className="auth-label" htmlFor="login-email">
            이메일
          </label>
          <input
            aria-describedby={errors.email === undefined ? undefined : "login-email-error"}
            aria-invalid={errors.email !== undefined}
            autoComplete="username"
            className="auth-input h-[3.375rem]"
            id="login-email"
            inputMode="email"
            autoCapitalize="none"
            placeholder="student@example.com"
            {...register("email")}
          />
          {errors.email?.message === undefined ? null : (
            <p
              className="mt-2 text-sm font-medium text-danger-text"
              id="login-email-error"
              role="alert"
            >
              {errors.email.message}
            </p>
          )}
        </div>

        <div>
          <label className="auth-label" htmlFor="login-password">
            비밀번호
          </label>
          <div className="relative">
            <input
              aria-describedby={errors.password === undefined ? undefined : "login-password-error"}
              aria-invalid={errors.password !== undefined}
              autoComplete="current-password"
              autoFocus={signupEmail !== ""}
              className="auth-input h-[3.375rem] pr-12"
              id="login-password"
              placeholder="비밀번호 입력"
              type={showPassword ? "text" : "password"}
              {...register("password")}
            />
            <button
              aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
              className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-app-muted hover:text-app-text"
              onClick={() => setShowPassword((visible) => !visible)}
              type="button"
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" size={20} />
              ) : (
                <Eye aria-hidden="true" size={20} />
              )}
            </button>
          </div>
          {errors.password?.message === undefined ? null : (
            <p
              className="mt-2 text-sm font-medium text-danger-text"
              id="login-password-error"
              role="alert"
            >
              {errors.password.message}
            </p>
          )}
        </div>

        <button
          aria-busy={isSubmitting}
          className="ui-button ui-button-primary h-[3.375rem] w-full text-base"
          disabled={isSubmitting || cooldownSeconds > 0}
          ref={submitButtonRef}
          type="submit"
        >
          {isSubmitting ? (
            <>
              <LoaderCircle aria-hidden="true" className="animate-spin" size={19} /> 로그인 중
            </>
          ) : cooldownSeconds > 0 ? (
            <>다시 시도까지 {cooldownSeconds}초</>
          ) : (
            <>
              <LogIn aria-hidden="true" size={19} /> 로그인
            </>
          )}
        </button>
      </form>

      {new URLSearchParams(location.search).get("social_error") === "signup_required" ? (
        <SocialUnlinkedNotice provider={providerFromQuery(location.search)} />
      ) : new URLSearchParams(location.search).has("social_error") ? (
        <p role="alert" className="mt-4 text-sm text-danger-text">
          빠른 로그인을 확인하지 못했어요. 다시 시작해 주세요.
        </p>
      ) : null}
      <SocialLoginButtons />

      <p className="mt-5 text-center text-sm text-app-muted sm:mt-7">
        아직 계정이 없나요?{" "}
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold text-role-primary hover:underline"
          to="/sign-up"
        >
          선생님·학생 가입
        </Link>
      </p>
      <p className="mt-1 flex flex-wrap items-center justify-center gap-x-3 text-center text-sm text-app-muted">
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold text-role-primary hover:underline"
          to="/forgot-account"
        >
          아이디 찾기
        </Link>
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold text-role-primary hover:underline"
          to="/forgot-password"
        >
          비밀번호를 잊으셨나요?
        </Link>
      </p>
      <p className="mt-3 border-t border-app-border pt-3 text-center text-sm text-app-muted">
        처음 오셨나요?{" "}
        <Link
          className="inline-flex min-h-11 items-center rounded-lg px-2 font-bold text-role-primary hover:underline"
          to="/demo"
        >
          가입 없이 예시 체험
        </Link>
      </p>
      <AlertDialog
        description={submitError}
        onClose={() => setSubmitError(undefined)}
        open={submitError !== undefined}
        returnFocusTo={submitButtonRef.current}
        title="로그인할 수 없어요"
      />
    </AuthShell>
  );
}
