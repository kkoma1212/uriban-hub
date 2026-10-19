import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { stepUpAdmin } from "../../api/admin-auth";
import { registerAdminStepUpHandler } from "../../api/admin-request";
import {
  getAdminFactors,
  stepUpAdminPasskey,
  stepUpAdminRecovery,
  type AdminFactors,
} from "../../api/admin-passkeys";
import { ApiRequestError } from "../../api/auth";
import { useModalIsolation } from "../layout/use-modal-isolation";

export function AdminStepUpDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factors, setFactors] = useState<AdminFactors>();
  const [allowRecovery, setAllowRecovery] = useState(true);
  const [method, setMethod] = useState<"totp" | "passkey" | "recovery">("totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const resolveRef = useRef<((accepted: boolean) => void) | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const titleId = useId(),
    descriptionId = useId(),
    passwordId = useId(),
    codeId = useId();

  function finish(accepted: boolean): void {
    controllerRef.current?.abort();
    resolveRef.current?.(accepted);
    resolveRef.current = undefined;
    setOpen(false);
    setPassword("");
    setCode("");
    setMethod("totp");
    setFactors(undefined);
    setError(undefined);
    setBusy(false);
  }

  useEffect(() => {
    const unregister = registerAdminStepUpHandler(
      (options) =>
        new Promise<boolean>((resolve) => {
          resolveRef.current = resolve;
          setAllowRecovery(options.allowRecovery);
          setOpen(true);
          void getAdminFactors()
            .then((result) => {
              if (resolveRef.current !== resolve) return;
              setFactors(result);
              if (result.enabled && result.passkeys.length > 0) setMethod("passkey");
            })
            .catch(() => undefined);
        }),
    );
    return () => {
      unregister();
      controllerRef.current?.abort();
      resolveRef.current?.(false);
      resolveRef.current = undefined;
    };
  }, []);

  useModalIsolation({
    dialogRef,
    initialFocusRef: passwordRef,
    onDismiss: () => finish(false),
    open,
  });

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      busy ||
      password.length === 0 ||
      (method === "totp" && !/^\d{6}$/u.test(code)) ||
      (method === "recovery" && (!allowRecovery || !/^[a-f0-9-]{32,39}$/iu.test(code)))
    )
      return;
    const current = resolveRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      if (method === "passkey") await stepUpAdminPasskey(password, controller.signal);
      else if (method === "recovery") await stepUpAdminRecovery(password, code, controller.signal);
      else await stepUpAdmin(password, code, controller.signal);
      if (resolveRef.current === current) finish(true);
    } catch (failure) {
      if (resolveRef.current !== current) return;
      setCode("");
      setError(
        failure instanceof ApiRequestError && failure.code === "ADMIN_MFA_INVALID"
          ? "비밀번호와 새 인증번호를 확인해 주세요. 이미 쓴 번호는 다시 사용할 수 없습니다."
          : failure instanceof Error
            ? failure.message
            : "보안 확인을 완료하지 못했습니다.",
      );
    } finally {
      if (resolveRef.current === current) setBusy(false);
    }
  }

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4"
      data-app-role="admin"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        ref={dialogRef}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-app-border bg-app-surface-raised p-5 text-app-text shadow-xl sm:p-6"
      >
        <h2 id={titleId} className="text-xl font-extrabold">
          중요 작업 보안 확인
        </h2>
        <p id={descriptionId} className="mt-3 text-sm leading-6 text-app-muted">
          계정과 보안 설정을 보호하기 위해 다시 확인합니다. 확인 후 5분 동안 중요 작업을 진행할 수
          있습니다. 로그인 시간 연장과는 별도입니다.
        </p>
        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
          {factors?.enabled && (
            <div>
              <label className="auth-label" htmlFor={`${codeId}-method`}>
                2차 인증 방법
              </label>
              <select
                id={`${codeId}-method`}
                className="auth-input"
                value={method}
                disabled={busy}
                onChange={(event) => {
                  setMethod(event.target.value as typeof method);
                  setCode("");
                }}
              >
                {factors.totp_enabled && <option value="totp">인증 앱</option>}
                {factors.passkeys.length > 0 && <option value="passkey">패스키 (PIN·지문)</option>}
                {allowRecovery && factors.recovery_codes_remaining > 0 && (
                  <option value="recovery">1회용 복구 코드</option>
                )}
              </select>
            </div>
          )}
          {!allowRecovery && (
            <p className="text-sm text-app-muted">
              인증 수단 변경은 인증 앱 또는 기존 패스키로 확인해야 합니다.
            </p>
          )}
          <div>
            <label className="auth-label" htmlFor={passwordId}>
              현재 관리자 비밀번호
            </label>
            <input
              id={passwordId}
              className="auth-input"
              type="password"
              autoComplete="current-password"
              ref={passwordRef}
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {method !== "passkey" && (
            <div>
              <label className="auth-label" htmlFor={codeId}>
                {method === "recovery" ? "1회용 복구 코드" : "새 6자리 인증번호"}
              </label>
              <input
                id={codeId}
                className="auth-input"
                inputMode={method === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                maxLength={method === "totp" ? 6 : 39}
                disabled={busy}
                value={code}
                onChange={(event) =>
                  setCode(
                    method === "totp"
                      ? event.target.value.replace(/\D/gu, "")
                      : event.target.value.toUpperCase(),
                  )
                }
                required
              />
              <p className="mt-2 text-xs leading-5 text-app-muted">
                {method === "recovery"
                  ? "사용한 복구 코드는 즉시 폐기됩니다."
                  : "인증 앱의 번호가 바뀐 뒤 입력해 주세요."}
              </p>
            </div>
          )}
          {error === undefined ? null : (
            <p
              role="alert"
              className="rounded-control bg-danger-surface p-3 text-sm text-danger-text"
            >
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="ui-button ui-button-secondary"
              onClick={() => finish(false)}
            >
              취소
            </button>
            <button
              type="submit"
              className="ui-button ui-button-primary"
              disabled={
                busy ||
                password.length === 0 ||
                (method === "totp" && !/^\d{6}$/u.test(code)) ||
                (method === "recovery" && code.length < 32)
              }
              aria-busy={busy}
            >
              {busy ? "확인 중" : "확인 후 계속"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
