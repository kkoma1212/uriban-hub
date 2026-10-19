import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, EyeOff, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";

import {
  ApiRequestError,
  changePassword,
  getBootstrap,
  type BootstrapResponse,
} from "../../api/auth";
import { newPasswordSchema, passwordConfirmationSchema } from "../../lib/password-policy";
import { AppShell, AppShellBar, type AppNavigationRole } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";
import { useRequestCooldown } from "../auth/request-cooldown";

const changePasswordSchema = z
  .object({
    confirm_password: passwordConfirmationSchema,
    current_password: z.string().min(1, "현재 비밀번호를 입력해 주세요."),
    new_password: newPasswordSchema,
  })
  .refine(({ confirm_password, new_password }) => confirm_password === new_password, {
    message: "새 비밀번호가 서로 일치하지 않아요.",
    path: ["confirm_password"],
  });

type ChangePasswordForm = z.infer<typeof changePasswordSchema>;

interface PageContext {
  backLabel: string;
  backTo: string;
  forced: boolean;
  navigationRole?: AppNavigationRole;
}

function contextFromBootstrap(bootstrap: BootstrapResponse): PageContext {
  const forced = ["CHANGE_TEMPORARY_PASSWORD", "TEACHER_REVOKED"].includes(bootstrap.destination);
  const role: AppNavigationRole =
    bootstrap.current_membership?.role ??
    (bootstrap.teacher_profile === null ? "student" : "teacher");

  if (bootstrap.destination !== "HOME") {
    return { backLabel: "계정 안내로", backTo: "/bootstrap", forced };
  }

  return role === "teacher"
    ? {
        backLabel: "관리로",
        backTo: "/class/manage",
        forced,
        navigationRole: "teacher",
      }
    : {
        backLabel: "설정으로",
        backTo: "/settings",
        forced,
        navigationRole: "student",
      };
}

export function ChangePasswordPage(): React.JSX.Element {
  const cooldownSeconds = useRequestCooldown();
  const navigate = useNavigate();
  const [pageContext, setPageContext] = useState<PageContext>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitError, setSubmitError] = useState<string>();
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPasswords, setShowNewPasswords] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    setError: setFieldError,
  } = useForm<ChangePasswordForm>({
    defaultValues: { confirm_password: "", current_password: "", new_password: "" },
    resolver: zodResolver(changePasswordSchema),
  });

  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void getBootstrap()
      .then((bootstrap) => {
        if (!active) return;
        if (!bootstrap.allowed_actions.includes("CHANGE_PASSWORD")) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setPageContext(contextFromBootstrap(bootstrap));
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadError(
          requestError instanceof Error ? requestError.message : "계정 상태를 불러오지 못했습니다.",
        );
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, navigate]);

  const submit = handleSubmit(async (values) => {
    setSubmitError(undefined);
    try {
      await changePassword({
        current_password: values.current_password,
        new_password: values.new_password,
      });
      void navigate("/login", { replace: true, state: { passwordChanged: true } });
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        if (requestError.code === "INVALID_CREDENTIALS") {
          setFieldError(
            "current_password",
            { message: "현재 비밀번호가 올바르지 않아요." },
            { shouldFocus: true },
          );
          return;
        }
        void navigate("/login", { replace: true });
        return;
      }

      if (requestError instanceof ApiRequestError && requestError.code === "RATE_LIMITED") {
        setSubmitError("현재 비밀번호 확인을 너무 많이 시도했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }

      setSubmitError(
        requestError instanceof Error ? requestError.message : "비밀번호를 변경하지 못했습니다.",
      );
    }
  });

  if (pageContext === undefined) {
    return (
      <AppShell width="narrow">
        <AppShellBar brandTo="/bootstrap" context="비밀번호 변경" />
        <PageHeader
          description="계정 보호 상태를 확인한 뒤 비밀번호를 변경해요."
          eyebrow="내 계정"
          title="비밀번호 변경"
        />
        {loadError === undefined ? (
          <div aria-live="polite" className="mt-6 text-center" role="status">
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
            <p className="mt-4 font-bold">계정 보호 정보를 확인하고 있어요.</p>
          </div>
        ) : (
          <div aria-live="assertive" className="mt-6 text-center" role="alert">
            <AlertCircle aria-hidden="true" className="mx-auto text-rose-500" size={32} />
            <p className="mt-4 font-bold text-rose-700">{loadError}</p>
            <button
              className="ui-button ui-button-primary mt-5 text-sm"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              type="button"
            >
              다시 시도
            </button>
          </div>
        )}
      </AppShell>
    );
  }

  return (
    <AppShell
      {...(pageContext.navigationRole === undefined
        ? {}
        : { navigationRole: pageContext.navigationRole })}
      width="narrow"
    >
      <AppShellBar
        backLabel={pageContext.backLabel}
        backTo={pageContext.backTo}
        brandTo={pageContext.navigationRole === undefined ? "/bootstrap" : "/home"}
        context="비밀번호 변경"
      />
      <PageHeader
        description="문자와 숫자를 포함해 6자 이상 입력해 주세요. 길이 상한은 없어요. 변경하면 모든 기기에서 로그아웃됩니다."
        eyebrow={pageContext.forced ? "계정 보호 필수 단계" : "내 계정"}
        title={pageContext.forced ? "임시 비밀번호를 바꿔 주세요" : "비밀번호 변경"}
      />

      <section className="mt-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-7">
        <form className="space-y-4" noValidate onSubmit={submit}>
          <div>
            <label className="auth-label" htmlFor="current-password">
              현재 비밀번호
            </label>
            <div className="relative">
              <input
                aria-describedby={
                  errors.current_password === undefined ? undefined : "current-password-error"
                }
                aria-invalid={errors.current_password !== undefined}
                autoComplete="current-password"
                className="auth-input pr-12"
                id="current-password"
                readOnly={isSubmitting}
                type={showCurrentPassword ? "text" : "password"}
                {...register("current_password")}
              />
              <button
                aria-label={showCurrentPassword ? "현재 비밀번호 숨기기" : "현재 비밀번호 보기"}
                className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-app-muted hover:text-app-text"
                onClick={() => setShowCurrentPassword((visible) => !visible)}
                type="button"
              >
                {showCurrentPassword ? (
                  <EyeOff aria-hidden="true" size={20} />
                ) : (
                  <Eye aria-hidden="true" size={20} />
                )}
              </button>
            </div>
            {errors.current_password?.message === undefined ? null : (
              <p
                className="mt-2 text-sm font-medium text-rose-600"
                id="current-password-error"
                role="alert"
              >
                {errors.current_password.message}
              </p>
            )}
          </div>

          <div>
            <label className="auth-label" htmlFor="new-password">
              새 비밀번호
            </label>
            <div className="relative">
              <input
                aria-describedby={
                  errors.new_password === undefined
                    ? "new-password-rules"
                    : "new-password-rules new-password-error"
                }
                aria-invalid={errors.new_password !== undefined}
                autoComplete="new-password"
                className="auth-input pr-12"
                id="new-password"
                readOnly={isSubmitting}
                type={showNewPasswords ? "text" : "password"}
                {...register("new_password")}
              />
              <button
                aria-label={showNewPasswords ? "새 비밀번호 숨기기" : "새 비밀번호 보기"}
                className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-app-muted hover:text-app-text"
                onClick={() => setShowNewPasswords((visible) => !visible)}
                type="button"
              >
                {showNewPasswords ? (
                  <EyeOff aria-hidden="true" size={20} />
                ) : (
                  <Eye aria-hidden="true" size={20} />
                )}
              </button>
            </div>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted" id="new-password-rules">
              외우기 쉬운 긴 문장을 권장해요. 영문·숫자·특수문자 조합은 강제하지 않아요.
            </p>
            {errors.new_password?.message === undefined ? null : (
              <p
                className="mt-2 text-sm font-medium text-rose-600"
                id="new-password-error"
                role="alert"
              >
                {errors.new_password.message}
              </p>
            )}
          </div>

          <div>
            <label className="auth-label" htmlFor="confirm-password">
              새 비밀번호 확인
            </label>
            <input
              aria-describedby={
                errors.confirm_password === undefined ? undefined : "confirm-password-error"
              }
              aria-invalid={errors.confirm_password !== undefined}
              autoComplete="new-password"
              className="auth-input"
              id="confirm-password"
              readOnly={isSubmitting}
              type={showNewPasswords ? "text" : "password"}
              {...register("confirm_password")}
            />
            {errors.confirm_password?.message === undefined ? null : (
              <p
                className="mt-2 text-sm font-medium text-rose-600"
                id="confirm-password-error"
                role="alert"
              >
                {errors.confirm_password.message}
              </p>
            )}
          </div>

          {submitError === undefined ? null : (
            <p
              className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
              role="alert"
            >
              {submitError}
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
            {isSubmitting ? "변경하는 중" : "비밀번호 변경"}
          </button>
        </form>
      </section>
    </AppShell>
  );
}
