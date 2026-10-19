import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { FieldErrors, UseFormClearErrors, UseFormRegister } from "react-hook-form";

import { getPasswordStrength, PASSWORD_STRENGTH_GUIDE } from "../../lib/password-strength";
import { PasswordCopyButton } from "./password-copy-button";
import { SignUpFieldError as FieldError } from "./sign-up-field-error";
import type { SignUpForm } from "./sign-up-form";

/** 가입 3단계: 이메일 · 기본 이름 · 비밀번호(빠른 로그인 가입은 비밀번호 없음). */
export function SignUpAccountFields({
  clearErrors,
  errors,
  password,
  register,
  role,
  social,
}: {
  clearErrors: UseFormClearErrors<SignUpForm>;
  errors: FieldErrors<SignUpForm>;
  password: string;
  register: UseFormRegister<SignUpForm>;
  role?: SignUpForm["role"];
  social: boolean;
}): React.JSX.Element {
  const [showPassword, setShowPassword] = useState(false);
  const passwordStrength = getPasswordStrength(password);
  const strengthPresentation =
    passwordStrength === null
      ? null
      : {
          safe: { label: "안전", className: "text-success-text" },
          moderate: { label: "보통", className: "text-warning-text" },
          weak: { label: "위험", className: "text-danger-text" },
        }[passwordStrength];

  return (
    <>
      <div>
        <label className="auth-label" htmlFor="email">
          이메일
        </label>
        <input
          aria-describedby={errors.email === undefined ? undefined : "sign-up-email-error"}
          aria-invalid={errors.email === undefined ? undefined : true}
          autoComplete="email"
          className="auth-input"
          id="email"
          inputMode="email"
          placeholder={role === "teacher" ? "teacher@example.com" : "student@example.com"}
          type="email"
          {...register("email", {
            onChange: () => {
              if (errors.email?.type === "server") clearErrors("email");
            },
          })}
        />
        <FieldError id="sign-up-email-error" message={errors.email?.message} />
      </div>

      <div>
        <label className="auth-label" htmlFor="display-name">
          기본 이름
        </label>
        <input
          aria-describedby={
            errors.display_name === undefined ? undefined : "sign-up-display-name-error"
          }
          aria-invalid={errors.display_name === undefined ? undefined : true}
          autoComplete="nickname"
          className="auth-input"
          id="display-name"
          placeholder={
            role === "teacher" ? "학생에게 보일 선생님 이름" : "친구와 선생님에게 보일 이름"
          }
          {...register("display_name")}
        />
        <FieldError id="sign-up-display-name-error" message={errors.display_name?.message} />
      </div>

      {!social ? (
        <>
          <div>
            <label className="auth-label" htmlFor="password">
              비밀번호
            </label>
            <div className="relative">
              <input
                aria-describedby={[
                  "sign-up-password-rules",
                  strengthPresentation === null ? null : "sign-up-password-strength",
                  errors.password === undefined ? null : "sign-up-password-error",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-invalid={errors.password === undefined ? undefined : true}
                autoComplete="new-password"
                className="auth-input pr-12"
                id="password"
                placeholder="문자와 숫자를 포함해 6자 이상"
                type={showPassword ? "text" : "password"}
                {...register("password")}
              />
              <button
                aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2 bg-transparent text-app-muted hover:bg-app-surface-muted hover:text-app-text"
                onClick={() => setShowPassword((visible) => !visible)}
                type="button"
              >
                {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
            <PasswordCopyButton label="비밀번호" value={password} />
            {strengthPresentation !== null && (
              <p
                aria-label={`비밀번호 안전 등급: ${strengthPresentation.label}`}
                className={`mt-2 text-xs font-semibold ${strengthPresentation.className}`}
                id="sign-up-password-strength"
                role="status"
                title={PASSWORD_STRENGTH_GUIDE}
              >
                <span className="sr-only">비밀번호 안전 등급: </span>
                {strengthPresentation.label}
                <span className="sr-only">. {PASSWORD_STRENGTH_GUIDE}</span>
              </p>
            )}
            <p
              className="mt-2 break-keep text-sm leading-6 text-app-muted"
              id="sign-up-password-rules"
            >
              문자와 숫자를 모두 포함해 6자 이상 입력해 주세요. 길이 상한은 없으며 한글·공백·기호도
              사용할 수 있어요. 안전 등급은 참고용이에요.
            </p>
            <FieldError id="sign-up-password-error" message={errors.password?.message} />
          </div>

          <div>
            <label className="auth-label" htmlFor="confirm-password">
              비밀번호 확인
            </label>
            <input
              aria-describedby={
                errors.confirm_password === undefined ? undefined : "sign-up-confirm-password-error"
              }
              aria-invalid={errors.confirm_password === undefined ? undefined : true}
              autoComplete="new-password"
              className="auth-input"
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              {...register("confirm_password")}
            />
            <FieldError
              id="sign-up-confirm-password-error"
              message={errors.confirm_password?.message}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
