import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, LoaderCircle, Mail } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";

import { requestAccountRecovery } from "../../api/account-recovery";
import { ApiRequestError } from "../../api/auth";
import { PageHeader } from "../layout/page-header";
import { AuthShell, LoginMobileHeader } from "./auth-shell";
import { useRequestCooldown } from "./request-cooldown";

const schema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("이메일 형식을 확인해 주세요.")),
});

export function ForgotAccountPage(): React.JSX.Element {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const requestInFlight = useRef(false);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const cooldown = useRequestCooldown();
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<z.infer<typeof schema>>({
    defaultValues: { email: "" },
    resolver: zodResolver(schema),
  });

  const submit = handleSubmit(async ({ email }) => {
    if (requestInFlight.current || cooldown > 0) return;
    requestInFlight.current = true;
    setRequesting(true);
    setError(undefined);
    try {
      await requestAccountRecovery(email);
      setAccepted(true);
    } catch (failure) {
      setError(
        failure instanceof ApiRequestError && failure.code === "RATE_LIMITED"
          ? failure.message
          : "아이디 안내를 요청하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      requestInFlight.current = false;
      setRequesting(false);
    }
  });

  useEffect(() => {
    if (accepted) successHeading.current?.focus();
  }, [accepted]);
  const busy = isSubmitting || requesting;

  return (
    <AuthShell mobileTopAligned>
      <LoginMobileHeader />
      <PageHeader
        className="mb-6"
        description="우리반 허브의 아이디는 가입할 때 사용한 이메일입니다."
        eyebrow="계정 찾기"
        title="아이디 찾기"
      />
      {accepted ? (
        <section className="ui-panel text-center">
          <div aria-live="polite" role="status">
            <CheckCircle2 aria-hidden="true" className="mx-auto text-success-text" size={32} />
            <h2 className="ui-section-title mt-4" ref={successHeading} tabIndex={-1}>
              안내 메일을 확인해 주세요
            </h2>
            <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
              입력한 이메일로 아이디 안내를 요청했어요. 받은편지함과 스팸함을 확인해 주세요. 메일이
              오지 않으면 이메일 주소를 다시 확인하거나 담임 선생님이나 화면 아래 문의 이메일로 알려
              주세요.
            </p>
          </div>
          <Link className="ui-button ui-button-primary mt-6" to="/login">
            로그인 화면으로
          </Link>
        </section>
      ) : (
        <form className="ui-panel space-y-4" noValidate onSubmit={submit}>
          <div>
            <label className="auth-label" htmlFor="account-recovery-email">
              이메일 <span aria-hidden="true">(필수)</span>
            </label>
            <input
              aria-describedby={
                errors.email === undefined ? "account-recovery-help" : "account-recovery-error"
              }
              aria-invalid={errors.email !== undefined}
              aria-required="true"
              autoComplete="email"
              className="auth-input"
              id="account-recovery-email"
              inputMode="email"
              placeholder="가입할 때 사용한 이메일"
              required
              type="email"
              {...register("email")}
            />
            {errors.email?.message === undefined ? (
              <p className="mt-2 text-sm leading-6 text-app-muted" id="account-recovery-help">
                가입한 이메일이 기억나지 않으면 담임 선생님이나 화면 아래 문의 이메일로 알려 주세요.
              </p>
            ) : (
              <p className="mt-2 text-sm text-danger-text" id="account-recovery-error" role="alert">
                {errors.email.message}
              </p>
            )}
          </div>
          {error === undefined ? null : (
            <p
              className="rounded-control border border-danger-border bg-danger-surface p-3 text-sm leading-6 text-danger-text"
              role="alert"
            >
              {error}
            </p>
          )}
          <button
            aria-busy={busy}
            className="ui-button ui-button-primary w-full"
            disabled={busy || cooldown > 0}
            type="submit"
          >
            {busy ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <Mail aria-hidden="true" size={18} />
            )}
            {busy ? "요청하는 중" : "아이디 안내 메일 받기"}
          </button>
        </form>
      )}
      <nav aria-label="계정 복구 메뉴" className="mt-4 flex flex-wrap justify-center gap-2">
        <Link className="ui-button ui-button-tertiary" to="/login">
          로그인으로 돌아가기
        </Link>
        <Link className="ui-button ui-button-tertiary" to="/forgot-password">
          비밀번호 찾기
        </Link>
      </nav>
    </AuthShell>
  );
}
