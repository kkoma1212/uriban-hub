import { useState } from "react";
import { useLocation } from "react-router";
import {
  ApiRequestError,
  confirmSignupApproval,
  confirmSignupRole,
  resendSignupApproval,
} from "../../api/auth";
import { clearRequestCooldown } from "../../lib/request-cooldown";
import { useRequestCooldown } from "../auth/request-cooldown";

export function SignupApprovalForm({
  onApproved,
  signupRole,
  emailMasked,
  emailVerified = false,
}: {
  onApproved: () => Promise<void>;
  signupRole: "student" | "teacher" | null;
  /** 번호를 보낸 메일(앞 두 글자만 보이게 가린 값). 어디서 찾을지·주소를 잘못 넣었는지 알게 한다. */
  emailMasked?: string | undefined;
  emailVerified?: boolean;
}): React.JSX.Element {
  const { pathname } = useLocation();
  const [code, setCode] = useState("");
  const cooldownSeconds = useRequestCooldown();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [role, setRole] = useState<"student" | "teacher">();
  const waitingForTeacherApproval = signupRole === "teacher" && emailVerified;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || cooldownSeconds > 0) return;
    if (signupRole === null) {
      if (role === undefined) {
        setError("가입할 계정 유형을 선택해 주세요.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await confirmSignupRole(role);
        await onApproved();
      } catch (requestError) {
        setError(
          requestError instanceof Error ? requestError.message : "가입 유형을 확인하지 못했어요.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!/^[0-9]{6}$/u.test(code)) {
      setError("이메일로 받은 6자리 인증번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await confirmSignupApproval(code);
      clearRequestCooldown(pathname);
      setCode("");
      await onApproved();
    } catch (requestError) {
      setError(codeErrorMessage(requestError, waitingForTeacherApproval));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" noValidate onSubmit={(event) => void submit(event)}>
      {signupRole === null ? (
        <>
          <p className="text-sm leading-6 text-app-muted">
            기존 가입 기록에 계정 유형이 누락되어 있어요. 가입할 때 선택한 유형을 한 번 확인해
            주세요. 유형 확인 후 인증번호 메일을 받을 수 있어요.
          </p>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="auth-label">가입 유형 확인</legend>
            {(
              [
                ["student", "학생"],
                ["teacher", "선생님"],
              ] as const
            ).map(([value, label]) => (
              <label className="flex min-h-11 items-center gap-2" key={value}>
                <input
                  type="radio"
                  name="signup-role"
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <>
          <p className="text-sm leading-6 text-app-muted" id="signup-approval-help">
            {/* 번호를 보낸 메일 주소가 안 보였다(2026-10-21 첫 사용 점검 18). */}
            {emailMasked === undefined ? null : (
              <span className="mb-1 block font-bold text-app-text">받는 메일: {emailMasked}</span>
            )}
            {waitingForTeacherApproval ? (
              <>
                이메일 인증을 마쳤어요. 관리자가 선생님임을 확인한 뒤 이메일로 보낸 6자리 교사
                승인번호를 입력해 주세요. 승인 전에는 반을 만들거나 참여할 수 없어요.
              </>
            ) : (
              <>
                {/* 화면 제목 설명('가입한 이메일로 보낸 6자리 번호로…')과 같은 문장이 반복됐다
                    (2026-10-21 첫 사용 점검 18). */}
                메일이 보이지 않으면 스팸함을 확인하거나 다시 보내기를 눌러 주세요.
                {signupRole === "teacher"
                  ? " 선생님은 이메일 인증 후 별도 관리자 승인이 필요해요."
                  : ""}
              </>
            )}{" "}
            번호는 {waitingForTeacherApproval ? "48시간" : "10분"} 동안 유효하고, 5회 틀리면 새
            번호가 필요해요.
          </p>
          <label className="auth-label" htmlFor="signup-approval-code">
            {waitingForTeacherApproval ? "교사 승인번호" : "가입 인증번호"}
          </label>
          <input
            aria-describedby={`signup-approval-help${error === undefined ? "" : " signup-approval-error"}`}
            aria-invalid={error !== undefined}
            autoComplete="one-time-code"
            className="auth-input"
            disabled={busy}
            id="signup-approval-code"
            inputMode="numeric"
            // 메일에서 '123 456'·'123-456'처럼 붙여 넣어도 숫자만 남긴다. maxLength는 정리 전에 잘라 버려
            // 두지 않는다(총검수 B3-09).
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/gu, "").slice(0, 6))}
            pattern="[0-9]{6}"
            placeholder={waitingForTeacherApproval ? "6자리 승인번호" : "6자리 인증번호"}
            value={code}
          />
        </>
      )}
      {error === undefined ? null : (
        <p className="text-sm text-rose-600" id="signup-approval-error" role="alert">
          {error}
        </p>
      )}
      {notice ? (
        <p className="text-sm leading-6 text-app-muted" role="status">
          {notice}
        </p>
      ) : null}
      <button
        className="ui-button ui-button-primary w-full"
        disabled={busy || cooldownSeconds > 0}
        type="submit"
      >
        {busy
          ? "확인 중"
          : signupRole === null
            ? "가입 유형 확정"
            : waitingForTeacherApproval
              ? "교사 승인 확인"
              : "가입 인증 완료"}
      </button>
      {signupRole === null || waitingForTeacherApproval ? null : (
        <button
          className="ui-button ui-button-secondary w-full"
          type="button"
          disabled={busy || cooldownSeconds > 0}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            setNotice(undefined);
            void resendSignupApproval()
              .then((result) =>
                setNotice(
                  result.email_delivery_status === "sent"
                    ? "가입한 이메일로 인증번호를 보냈어요. 유효한 번호는 그대로 유지돼요."
                    : "메일을 보내지 못했어요. 화면 아래 문의 이메일로 인증번호를 문의해 주세요.",
                ),
              )
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "메일을 보내지 못했어요."),
              )
              .finally(() => setBusy(false));
          }}
        >
          인증번호 메일 다시 보내기
        </button>
      )}
    </form>
  );
}

// 메일 인증번호와 교사 승인번호는 같은 확인 경로라 서버 문구가 '관리자에게 새 번호를 요청'으로 같다.
// 메일 인증 단계의 학생·선생님은 관리자가 아니라 다시 보내기로 새 번호를 받으므로 그 안내로 바꾼다
// (2026-10-21 첫 사용 점검에서 발견).
function codeErrorMessage(failure: unknown, waitingForTeacherApproval: boolean): string {
  if (
    !waitingForTeacherApproval &&
    failure instanceof ApiRequestError &&
    failure.code === "SIGNUP_APPROVAL_INVALID"
  )
    return "인증번호가 맞지 않거나 만료됐어요. 메일의 번호를 다시 확인하거나 아래 '인증번호 메일 다시 보내기'로 새 번호를 받아 주세요.";
  return failure instanceof Error ? failure.message : "승인번호를 확인하지 못했어요.";
}
