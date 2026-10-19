import type { AdminSessionResponse } from "../api/admin-auth";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";
import type { SessionPrivacyState } from "./authenticated-session-privacy";

export const ADMIN_SESSION_EXPIRED_EVENT = "classhub:admin-session-expired";
export const ADMIN_SESSION_CLEAR_SIGNAL = "classhub:admin-session-clear-signal";
const deadlines = new WeakMap<AdminSessionResponse, number>();

export function rememberAdminSessionDeadline(
  session: AdminSessionResponse,
  startedAt: number,
): void {
  const expires = Date.parse(session.session.absolute_expires_at);
  const serverNow = session.server_now === undefined ? Date.now() : Date.parse(session.server_now);
  deadlines.set(session, startedAt + Math.max(0, expires - serverNow));
}

export function adminSessionDeadline(session: AdminSessionResponse): number {
  if (!deadlines.has(session)) rememberAdminSessionDeadline(session, performance.now());
  return deadlines.get(session)!;
}

export function notifyAdminSessionEnded(): void {
  try {
    window.localStorage.setItem(ADMIN_SESSION_CLEAR_SIGNAL, crypto.randomUUID());
  } catch {
    // Other tabs still recheck on return and while visible.
  }
  window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
}

function identity(session: AdminSessionResponse): string {
  if (
    typeof session.account?.id !== "string" ||
    !Array.isArray(session.account.roles) ||
    !Number.isFinite(Date.parse(session.session?.issued_at)) ||
    !Number.isFinite(Date.parse(session.session?.mfa_verified_at))
  )
    throw new Error("Invalid administrator session");
  return JSON.stringify([
    session.account.id,
    session.session.issued_at,
    session.session.mfa_verified_at,
    [...session.account.roles].sort(),
  ]);
}

function credential(): string | undefined {
  try {
    const prefix = "__Host-classhub_admin_csrf=";
    return document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
  } catch {
    return undefined;
  }
}

export function installAdminSessionPrivacy({
  session,
  check,
  onVerified,
  onEnded,
  onState,
  replace = () => window.location.replace("/admin/login"),
}: {
  session: AdminSessionResponse;
  check: (signal: AbortSignal) => Promise<AdminSessionResponse>;
  onVerified: (session: AdminSessionResponse) => void;
  onEnded: () => void;
  onState: (state: SessionPrivacyState) => void;
  replace?: () => void;
}): { dispose: () => void; retry: () => void } {
  const expected = identity(session),
    expectedCredential = credential();
  let deadline = adminSessionDeadline(session);
  let disposed = false,
    ended = false;
  let timer: number | undefined,
    expiryTimer: number | undefined,
    flight: AbortController | undefined;
  const mask = (state: SessionPrivacyState): void => {
    document.body.toggleAttribute("data-session-privacy", state !== "visible");
    onState(state);
  };
  const cancel = (): void => {
    window.clearTimeout(timer);
    window.clearTimeout(expiryTimer);
    flight?.abort();
    flight = undefined;
  };
  const end = (): void => {
    if (disposed || ended) return;
    ended = true;
    cancel();
    concealAuthenticatedDocument();
    try {
      onEnded();
    } finally {
      replace();
    }
  };
  const scheduleExpiry = (): void => {
    window.clearTimeout(expiryTimer);
    if (deadline > performance.now()) {
      expiryTimer = window.setTimeout(() => void verify(true), deadline - performance.now());
    }
  };
  const schedule = (): void => {
    window.clearTimeout(timer);
    if (disposed || ended || document.visibilityState !== "visible") return;
    if (!Number.isFinite(deadline)) {
      end();
      return;
    }
    if (deadline <= performance.now()) {
      void verify(true);
      return;
    }
    scheduleExpiry();
    timer = window.setTimeout(() => void verify(false), 60_000);
  };
  const verify = async (conceal: boolean): Promise<void> => {
    if (disposed || ended || document.visibilityState !== "visible") return;
    if (conceal) mask("checking");
    if (expectedCredential !== credential()) {
      end();
      return;
    }
    if (flight !== undefined) return;
    window.clearTimeout(timer);
    scheduleExpiry();
    const controller = new AbortController();
    flight = controller;
    try {
      const current = await check(controller.signal);
      if (disposed || ended || flight !== controller || controller.signal.aborted) return;
      const nextDeadline = adminSessionDeadline(current);
      if (
        expectedCredential !== credential() ||
        identity(current) !== expected ||
        !Number.isFinite(nextDeadline) ||
        nextDeadline <= performance.now()
      ) {
        end();
        return;
      }
      deadline = nextDeadline;
      onVerified(current);
      if (!disposed && !ended) mask("visible");
    } catch (failure) {
      if (disposed || ended || flight !== controller || controller.signal.aborted) return;
      if (
        performance.now() >= deadline ||
        (typeof failure === "object" &&
          failure !== null &&
          "code" in failure &&
          failure.code === "ADMIN_SESSION_REQUIRED" &&
          "status" in failure &&
          failure.status === 401)
      )
        end();
      else mask("error");
    } finally {
      if (flight === controller) {
        flight = undefined;
        schedule();
      }
    }
  };
  const foreground = (): void => {
    void verify(true);
  };
  const visibility = (): void => {
    if (disposed || ended) return;
    if (document.visibilityState === "hidden") {
      cancel();
      mask("checking");
    } else foreground();
  };
  const offline = (): void => {
    if (ended || disposed) return;
    cancel();
    if (performance.now() >= deadline) end();
    else mask("error");
  };
  const storage = (event: StorageEvent): void => {
    if (event.key === ADMIN_SESSION_CLEAR_SIGNAL && event.newValue !== null) end();
  };
  window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, end);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", foreground);
  window.addEventListener("online", foreground);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visibility);
  if (document.visibilityState === "hidden") mask("checking");
  else schedule();
  return {
    retry: foreground,
    dispose: () => {
      disposed = true;
      cancel();
      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, end);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visibility);
      document.body.removeAttribute("data-session-privacy");
    },
  };
}
