import { Eye, EyeOff, KeyRound, LoaderCircle, LogIn, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { beginAdminLogin, completeAdminTotp, type AdminLoginResponse } from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";
import { completeAdminPasskey, completeAdminRecovery } from "../../api/admin-passkeys";
import { AlertDialog } from "../layout/alert-dialog";
import { PageHeader } from "../layout/page-header";
import { AdminShell } from "./admin-shell";
import { useRequestCooldown } from "../auth/request-cooldown";

type LoginStep = "credentials" | "enroll_totp" | "verify_totp";

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 404 || error.code === "ADMIN_UNAVAILABLE") {
      return "관리자 로그인이 아직 활성화되지 않았어요. 다른 관리자에게 문의해 주세요.";
    }
    if (error.code === "ADMIN_INVALID_CREDENTIALS") {
      return "아이디 또는 비밀번호를 확인해 주세요.";
    }
    if (error.code === "ADMIN_ACCOUNT_LOCKED" || error.code === "RATE_LIMITED") {
      return "로그인 시도가 잠시 제한됐어요. 잠시 후 다시 시도해 주세요.";
    }
    if (error.code === "ADMIN_CHALLENGE_INVALID") {
      return "인증 시간이 끝났어요. 아이디와 비밀번호부터 다시 확인해 주세요.";
    }
    if (error.code === "ADMIN_MFA_INVALID")
      return "인증 수단을 확인해 주세요. 이미 사용한 코드는 다시 사용할 수 없습니다.";
  }
  return error instanceof Error ? error.message : "관리자 로그인을 완료하지 못했습니다.";
}

export function AdminLoginPage({
  initialChallenge,
  initialIdentifier = "",
}: {
  initialChallenge?: AdminLoginResponse;
  initialIdentifier?: string;
} = {}): React.JSX.Element {
  const navigate = useNavigate();
  const sharedCooldownSeconds = useRequestCooldown();
  const [accountDeadline, setAccountDeadline] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const cooldownSeconds = Math.max(
    sharedCooldownSeconds,
    Math.max(0, Math.ceil((accountDeadline - Math.max(clock, Date.now())) / 1000)),
  );
  useEffect(() => {
    if (accountDeadline <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (accountDeadline <= now) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [accountDeadline]);
  const [email, setEmail] = useState(initialIdentifier);
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [methods, setMethods] = useState(initialChallenge?.methods ?? ["totp"]);
  const [method, setMethod] = useState<"totp" | "passkey" | "recovery">(
    initialChallenge?.methods?.includes("passkey") ? "passkey" : "totp",
  );
  const [step, setStep] = useState<LoginStep>(initialChallenge?.next_step ?? "credentials");
  const [setup, setSetup] = useState<AdminLoginResponse["setup"]>(initialChallenge?.setup);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [rateLimitContext, setRateLimitContext] = useState<{
    inChallenge: boolean;
  }>();
  const [copyMessage, setCopyMessage] = useState<string>();
  const submitRef = useRef<HTMLButtonElement>(null);
  const identifierRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const setupCopyRef = useRef<HTMLButtonElement>(null);
  const focusStage = step + ":" + method;
  const previousFocusStage = useRef(focusStage);

  useEffect(() => {
    // Wait for the dialog to release modal isolation before focusing the replacement form.
    if (previousFocusStage.current === focusStage || busy || errorMessage !== undefined) return;
    previousFocusStage.current = focusStage;
    const target =
      step === "credentials"
        ? identifierRef.current
        : step === "enroll_totp"
          ? (setupCopyRef.current ?? codeRef.current)
          : method === "passkey"
            ? submitRef.current
            : codeRef.current;
    target?.focus();
  }, [busy, errorMessage, focusStage, method, step]);

  function showLoginError(error: unknown, inChallenge = false): void {
    const limited =
      error instanceof ApiRequestError &&
      (error.code === "RATE_LIMITED" || error.code === "ADMIN_ACCOUNT_LOCKED");
    const now = Date.now();
    const seconds =
      error instanceof ApiRequestError ? error.details?.retry_after_seconds : undefined;
    const retryAt = error instanceof ApiRequestError ? error.details?.retry_at : undefined;
    const durationDeadline =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
        ? now + Math.ceil(seconds) * 1000
        : undefined;
    const parsedAt =
      typeof retryAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(retryAt)
        ? Date.parse(retryAt)
        : NaN;
    const absoluteDeadline =
      Number.isFinite(parsedAt) && parsedAt >= now - 86400000 && parsedAt <= now + 86400000
        ? parsedAt
        : undefined;
    const confirmedDeadline =
      limited && (durationDeadline !== undefined || absoluteDeadline !== undefined)
        ? Math.max(durationDeadline ?? 0, absoluteDeadline ?? 0)
        : undefined;
    if (confirmedDeadline !== undefined) {
      setAccountDeadline((previous) => Math.max(previous, confirmedDeadline));
      setClock(now);
    }
    setRateLimitContext(confirmedDeadline !== undefined ? { inChallenge } : undefined);
    setErrorMessage(loginErrorMessage(error));
  }

  async function submitCredentials(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || cooldownSeconds > 0 || email.trim().length === 0 || password.length === 0) return;
    setBusy(true);
    setErrorMessage(undefined);
    setRateLimitContext(undefined);
    try {
      const result = await beginAdminLogin(email.trim().toLowerCase(), password);
      setPassword("");
      setTotpCode("");
      setSetup(result.setup);
      setMethods(result.methods ?? ["totp"]);
      setMethod(result.methods?.includes("passkey") ? "passkey" : "totp");
      setStep(result.next_step);
    } catch (error) {
      showLoginError(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      busy ||
      cooldownSeconds > 0 ||
      (method === "totp" && !/^\d{6}$/u.test(totpCode)) ||
      (method === "recovery" && !/^[a-f0-9-]{32,39}$/iu.test(totpCode))
    )
      return;
    setBusy(true);
    setErrorMessage(undefined);
    setRateLimitContext(undefined);
    try {
      if (method === "passkey") await completeAdminPasskey();
      else if (method === "recovery") await completeAdminRecovery(totpCode);
      else await completeAdminTotp(totpCode);
      void navigate("/admin", { replace: true });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "ADMIN_CHALLENGE_INVALID") {
        setStep("credentials");
        setSetup(undefined);
        setTotpCode("");
      }
      showLoginError(error, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminShell showRequestCooldownNotice={!(accountDeadline > 0 && cooldownSeconds > 0)}>
      <PageHeader
        className="mb-6 border-b border-app-border pb-5"
        description={
          step === "credentials"
            ? "비밀번호 확인 후 2단계 인증을 진행합니다."
            : method === "passkey"
              ? "이 기기의 PIN·지문으로 확인하세요."
              : method === "recovery"
                ? "보관한 1회용 복구 코드 하나를 입력하세요."
                : "인증 앱에 표시된 현재 6자리 번호를 입력하세요."
        }
        eyebrow="관리자 보안"
        title={step === "credentials" ? "관리자 로그인" : "2단계 인증"}
      />

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {step === "credentials"
          ? "관리자 로그인 단계. 아이디 또는 이메일과 비밀번호를 입력하세요."
          : step === "enroll_totp"
            ? "인증 앱 등록 단계. QR 코드나 설정 키로 계정을 등록한 뒤 6자리 인증번호를 입력하세요."
            : method === "passkey"
              ? "2단계 인증. 패스키로 인증 버튼을 눌러 PIN 또는 지문으로 확인하세요."
              : method === "recovery"
                ? "2단계 인증. 1회용 복구 코드를 입력하세요."
                : "2단계 인증. 인증 앱의 6자리 인증번호를 입력하세요."}
      </p>

      {accountDeadline > 0 && cooldownSeconds > 0 ? (
        <p
          className="mb-4 rounded-control border border-warning-border bg-warning-surface p-3 text-sm font-semibold leading-6 text-warning-text"
          data-admin-login-wait
          aria-live="off"
        >
          로그인 시도가 잠시 제한됐어요. 약 {cooldownSeconds}초 뒤 직접 다시 시도해 주세요.
        </p>
      ) : null}
      {step === "credentials" ? (
        <form className="space-y-4" noValidate onSubmit={submitCredentials}>
          <div>
            <label className="auth-label" htmlFor="admin-email">
              관리자 아이디 또는 이메일
            </label>
            <input
              autoComplete="username"
              className="auth-input"
              id="admin-email"
              ref={identifierRef}
              autoCapitalize="none"
              onChange={(event) => setEmail(event.target.value)}
              required
              value={email}
            />
          </div>
          <div>
            <label className="auth-label" htmlFor="admin-password">
              비밀번호
            </label>
            <div className="relative">
              <input
                autoComplete="current-password"
                className="auth-input pr-12"
                id="admin-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type={showPassword ? "text" : "password"}
                value={password}
              />
              <button
                aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                className="ui-icon-button absolute right-1 top-1/2 -translate-y-1/2"
                onClick={() => setShowPassword((current) => !current)}
                type="button"
              >
                {showPassword ? (
                  <EyeOff aria-hidden="true" size={20} />
                ) : (
                  <Eye aria-hidden="true" size={20} />
                )}
              </button>
            </div>
          </div>
          <button
            aria-busy={busy}
            className="ui-button ui-button-primary h-12 w-full"
            disabled={
              busy || cooldownSeconds > 0 || email.trim().length === 0 || password.length === 0
            }
            ref={submitRef}
            type="submit"
          >
            {busy ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={19} />
            ) : (
              <LogIn aria-hidden="true" size={19} />
            )}
            비밀번호 확인
          </button>
        </form>
      ) : (
        <>
          {step === "enroll_totp" && setup !== undefined ? (
            <div className="mb-5 rounded-2xl border border-role-border bg-role-soft p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-role-primary"
                  size={20}
                />
                <div className="min-w-0">
                  <p className="font-extrabold">인증 앱에 관리자 계정을 등록하세요</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm font-semibold leading-6 text-app-muted">
                    <li>인증 앱에서 새 계정 추가를 선택합니다.</li>
                    <li>다른 기기로 보고 있다면 아래 QR 코드를 스캔합니다.</li>
                    <li>
                      같은 휴대폰이라면 설정 키를 복사해 앱에 직접 등록합니다. 종류는 시간
                      기반(TOTP)입니다.
                    </li>
                    <li>앱에 나타난 6자리 번호를 아래에 입력합니다.</li>
                  </ol>
                  <QRCodeSVG
                    aria-label="관리자 인증 앱 등록 QR 코드"
                    bgColor="#ffffff"
                    className="mt-3 block h-auto max-w-full rounded-xl"
                    fgColor="#000000"
                    level="M"
                    marginSize={4}
                    role="img"
                    size={208}
                    value={setup.otpauth_uri}
                  />
                  <code className="mt-3 block overflow-x-auto rounded-xl bg-app-surface px-3 py-3 text-sm font-bold tracking-wider text-app-text">
                    {setup.manual_key}
                  </code>
                  <button
                    className="ui-button ui-button-secondary mt-2 min-h-11"
                    ref={setupCopyRef}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(setup.manual_key);
                        setCopyMessage("설정 키를 복사했어요. 인증 앱에 붙여넣어 주세요.");
                      } catch {
                        setCopyMessage("위 설정 키를 길게 누르거나 선택해서 복사해 주세요.");
                      }
                    }}
                    type="button"
                  >
                    설정 키 복사
                  </button>
                  {copyMessage === undefined ? null : (
                    <p className="mt-2 text-sm text-app-muted" role="status">
                      {copyMessage}
                    </p>
                  )}
                  <a
                    className="mt-2 flex min-h-11 items-center font-bold text-role-primary underline"
                    href={setup.otpauth_uri}
                  >
                    인증 앱으로 열기
                  </a>
                  <p className="text-xs leading-5 text-app-muted">
                    앱 연결이 지원되는 기기에서만 열립니다. 열리지 않으면 QR 코드나 설정 키를 이용해
                    주세요.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <form className="space-y-4" noValidate onSubmit={submitTotp}>
            {step === "verify_totp" && methods.length > 1 && (
              <div>
                <label className="auth-label" htmlFor="admin-login-method">
                  2차 인증 방법
                </label>
                <select
                  id="admin-login-method"
                  className="auth-input"
                  value={method}
                  disabled={busy}
                  onChange={(event) => {
                    setMethod(event.target.value as typeof method);
                    setTotpCode("");
                  }}
                >
                  {methods.includes("passkey") && (
                    <option value="passkey">패스키 (PIN·지문)</option>
                  )}
                  {methods.includes("totp") && <option value="totp">인증 앱</option>}
                  {methods.includes("recovery") && (
                    <option value="recovery">1회용 복구 코드</option>
                  )}
                </select>
              </div>
            )}
            {method !== "passkey" && (
              <div>
                <label className="auth-label" htmlFor="admin-totp">
                  {method === "recovery" ? "1회용 복구 코드" : "6자리 인증번호"}
                </label>
                <input
                  autoComplete="one-time-code"
                  className="auth-input text-center text-xl tracking-[0.32em]"
                  id="admin-totp"
                  ref={codeRef}
                  inputMode={method === "totp" ? "numeric" : "text"}
                  maxLength={method === "totp" ? 6 : 39}
                  onChange={(event) =>
                    setTotpCode(
                      method === "totp"
                        ? event.target.value.replace(/\D/gu, "").slice(0, 6)
                        : event.target.value.toUpperCase(),
                    )
                  }
                  value={totpCode}
                />
              </div>
            )}
            <button
              aria-busy={busy}
              className="ui-button ui-button-primary h-12 w-full"
              disabled={
                busy ||
                cooldownSeconds > 0 ||
                (method === "totp" && totpCode.length !== 6) ||
                (method === "recovery" && totpCode.length < 32)
              }
              ref={submitRef}
              type="submit"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={19} />
              ) : (
                <KeyRound aria-hidden="true" size={19} />
              )}
              {method === "passkey" ? "패스키로 인증" : "인증 완료"}
            </button>
            <button
              className="ui-button ui-button-secondary h-11 w-full"
              onClick={() => {
                setStep("credentials");
                setSetup(undefined);
                setTotpCode("");
              }}
              type="button"
            >
              이메일 입력으로 돌아가기
            </button>
          </form>
        </>
      )}

      <AlertDialog
        description={
          rateLimitContext === undefined ? (
            errorMessage
          ) : (
            <>
              로그인 시도가 잠시 제한됐어요.{" "}
              {cooldownSeconds > 0 ? (
                <span aria-live="off">약 {cooldownSeconds}초 뒤 다시 시도할 수 있어요.</span>
              ) : (
                <span role="status" aria-live="polite">
                  대기가 끝났어요. 확인을 누른 뒤 다시 시도할 수 있어요.
                </span>
              )}{" "}
              입력한 내용은 그대로 있어요.
              {rateLimitContext.inChallenge
                ? " 인증 시간이 끝났다면 이메일 입력으로 돌아가 다시 시작해 주세요."
                : ""}
            </>
          )
        }
        onClose={() => {
          setErrorMessage(undefined);
          setRateLimitContext(undefined);
        }}
        open={errorMessage !== undefined}
        returnFocusTo={submitRef.current}
        title="관리자 인증을 완료할 수 없어요"
      />
    </AdminShell>
  );
}
