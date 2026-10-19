import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { apiFetch, parseResponse, type BootstrapResponse } from "../../api/auth";
import {
  getSessionPrivacyState,
  installAuthenticatedSessionPrivacy,
  retrySessionPrivacy,
  subscribeSessionPrivacy,
  type SessionPrivacyState,
} from "../../lib/authenticated-session-privacy";
import { useModalIsolation } from "./use-modal-isolation";

const publicPaths = new Set([
  "/",
  "/login",
  "/demo",
  "/sign-up",
  "/forgot-account",
  "/forgot-password",
  "/reset-password",
  "/guardian-consent",
  "/verify-email",
]);
if (import.meta.env.DEV) publicPaths.add("/local-test-admin");

export function SessionPrivacyBoundary({
  pathname,
}: {
  pathname: string;
}): React.JSX.Element | null {
  const state = useSyncExternalStore(subscribeSessionPrivacy, getSessionPrivacyState);
  useLayoutEffect(() => {
    if (publicPaths.has(pathname) || /^\/(?:admin|legal)(?:\/|$)/u.test(pathname)) return;
    return installAuthenticatedSessionPrivacy(async (signal) => {
      const response = await apiFetch("/api/v1/bootstrap", {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      return parseResponse<BootstrapResponse>(response);
    });
  }, [pathname]);
  return <SessionPrivacyPanel state={state} onRetry={retrySessionPrivacy} />;
}

export function SessionPrivacyPanel({
  state,
  onRetry,
}: {
  state: SessionPrivacyState;
  onRetry: () => void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation({
    dialogRef,
    initialFocusRef: dialogRef,
    onDismiss: () => undefined,
    open: state !== "visible",
  });
  if (state === "visible") return null;
  return createPortal(
    <div
      data-session-privacy-panel=""
      className="fixed inset-0 grid min-h-dvh place-items-center bg-app-canvas px-5 text-app-text"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="로그인 상태 확인"
        tabIndex={-1}
        className="w-full max-w-sm rounded-shell border border-app-border bg-app-surface-raised p-6 text-center shadow-lg"
      >
        <h2 className="text-lg font-extrabold">로그인 상태 확인</h2>
        <p role="status" className="mt-3 text-sm leading-6">
          {state === "checking"
            ? "로그인 상태를 확인하고 있어요."
            : "로그인 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요."}
        </p>
        {state === "error" ? (
          <>
            <p className="mt-2 text-sm leading-6">
              작성 중인 내용은 확인이 끝날 때까지 가려 두고 있어요.
            </p>
            <button
              type="button"
              className="ui-button ui-button-primary mt-5 min-h-11 w-full"
              onClick={onRetry}
            >
              다시 확인
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
