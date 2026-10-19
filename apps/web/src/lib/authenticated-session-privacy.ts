import type { BootstrapResponse } from "../api/auth";
import {
  AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT,
  clearCurrentTabAuthenticatedClientState,
} from "./authenticated-client-state";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";

export const SESSION_RECHECK_INTERVAL_MS = 60_000;
export type SessionPrivacyState = "visible" | "checking" | "error";
let state: SessionPrivacyState = "visible";
const listeners = new Set<() => void>();
let generation = 0;
let observe: ((bootstrap: BootstrapResponse, credential: string | undefined) => void) | undefined;
let retry: (() => void) | undefined;

function credentialSnapshot(): string | undefined {
  try {
    return (
      document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("__Host-classhub_csrf="))
        ?.slice(21) || undefined
    );
  } catch {
    return undefined;
  }
}

export function beginSessionPrivacyObservation() {
  return { generation, credential: credentialSnapshot() };
}

export function rememberSessionPrivacyObservation(
  request: ReturnType<typeof beginSessionPrivacyObservation>,
  bootstrap: BootstrapResponse,
): void {
  if (request.generation === generation) observe?.(bootstrap, request.credential);
}

export function subscribeSessionPrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionPrivacyState(): SessionPrivacyState {
  return state;
}

export function retrySessionPrivacy(): void {
  retry?.();
}

function setState(next: SessionPrivacyState): void {
  // Synchronous CSS also conceals existing and newly inserted dialog portals,
  // before React has rendered the non-private checking/retry panel.
  document.body.toggleAttribute("data-session-privacy", next !== "visible");
  state = next;
  for (const listener of listeners) listener();
}

function authorizationSnapshot(bootstrap: BootstrapResponse): string {
  if (
    typeof bootstrap.account?.is_active !== "boolean" ||
    typeof bootstrap.account.email_verified !== "boolean" ||
    typeof bootstrap.destination !== "string" ||
    !Array.isArray(bootstrap.allowed_actions) ||
    bootstrap.allowed_actions.some((action) => typeof action !== "string") ||
    bootstrap.current_class === undefined ||
    bootstrap.current_membership === undefined
  )
    throw new Error("Invalid session verification response");
  return JSON.stringify({
    active: bootstrap.account.is_active,
    verified: bootstrap.account.email_verified,
    destination: bootstrap.destination,
    actions: [...bootstrap.allowed_actions].sort(),
    classId: bootstrap.current_class?.id,
    classStatus: bootstrap.current_class?.status,
    memberId: bootstrap.current_membership?.id,
    memberStatus: bootstrap.current_membership?.status,
    role: bootstrap.current_membership?.role,
    teacher: bootstrap.teacher_profile,
  });
}

function sessionSnapshot(bootstrap: BootstrapResponse) {
  const context = bootstrap.session_context;
  if (
    context !== undefined &&
    (typeof context !== "string" || !/^v1\.[A-Za-z0-9_-]{43}$/u.test(context))
  )
    throw new Error("Invalid session verification identity");
  return { authorization: authorizationSnapshot(bootstrap), context };
}

type SessionSnapshot = ReturnType<typeof sessionSnapshot> & { credential: string | undefined };

function sameSession(previous: SessionSnapshot, current: SessionSnapshot): boolean {
  if (previous.context !== undefined && current.context === undefined)
    throw new Error("Session verification identity missing");
  return (
    previous.authorization === current.authorization &&
    (previous.context === undefined
      ? previous.credential === current.credential
      : previous.context === current.context)
  );
}

export function installAuthenticatedSessionPrivacy(
  check: (signal: AbortSignal) => Promise<BootstrapResponse>,
  replace: (path: string) => void = (path) => window.location.replace(path),
): () => void {
  generation += 1;
  let baseline: SessionSnapshot | undefined;
  let timer: number | undefined;
  let flight: AbortController | undefined;
  let ended = false;
  let disposed = false;

  const cancel = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
    flight?.abort();
    flight = undefined;
  };
  const invalidate = (): void => {
    if (ended || disposed) return;
    ended = true;
    cancel();
    concealAuthenticatedDocument();
    try {
      clearCurrentTabAuthenticatedClientState();
    } finally {
      replace("/bootstrap");
    }
  };
  const schedule = (): void => {
    window.clearTimeout(timer);
    if (!ended && !disposed && baseline !== undefined && document.visibilityState === "visible") {
      timer = window.setTimeout(() => void recheck(false), SESSION_RECHECK_INTERVAL_MS);
    }
  };
  const recheck = async (conceal: boolean): Promise<void> => {
    if (disposed || ended || baseline === undefined || document.visibilityState !== "visible")
      return;
    if (conceal || baseline.credential !== credentialSnapshot()) setState("checking");
    if (flight !== undefined) return;
    if (baseline.context === undefined && baseline.credential !== credentialSnapshot()) {
      invalidate();
      return;
    }
    // Without a readable credential we cannot safely restore a prior user's
    // document. Keep it covered; do not enter a reload loop or erase drafts.
    if (baseline.credential === undefined) {
      setState("error");
      schedule();
      return;
    }
    window.clearTimeout(timer);
    const current = new AbortController();
    flight = current;
    try {
      // A response sent under the previous cookie cannot confirm the current
      // browser session. One fresh read handles an ordinary CSRF rotation;
      // repeated drift stays covered instead of spinning or deleting drafts.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const credential = credentialSnapshot();
        if (credential === undefined) throw new Error("Session credential unavailable");
        const result = await check(current.signal);
        if (disposed || ended || flight !== current || current.signal.aborted) return;
        if (credential !== credentialSnapshot()) {
          if (baseline.context === undefined) {
            invalidate();
            return;
          }
          setState("checking");
          if (attempt === 0) continue;
          throw new Error("Session changed during verification");
        }
        const next = { ...sessionSnapshot(result), credential };
        if (!sameSession(baseline, next)) invalidate();
        else {
          baseline = next;
          setState("visible");
        }
        return;
      }
    } catch (error) {
      if (disposed || ended || flight !== current || current.signal.aborted) return;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "UNAUTHENTICATED" &&
        "status" in error &&
        error.status === 401
      ) {
        invalidate();
      } else {
        setState("error");
      }
    } finally {
      if (flight === current) {
        flight = undefined;
        schedule();
      }
    }
  };
  const foreground = (): void => {
    void recheck(true);
  };
  const visibility = (): void => {
    if (baseline === undefined || ended) return;
    if (document.visibilityState === "hidden") {
      cancel();
      setState("checking");
    } else foreground();
  };
  const offline = (): void => {
    if (baseline === undefined || ended) return;
    cancel();
    setState("error");
  };
  const cleared = (): void => {
    generation += 1;
    cancel();
    baseline = undefined;
    if (!ended) setState("visible");
  };
  observe = (bootstrap, credential) => {
    if (ended || disposed) return;
    let next: SessionSnapshot;
    try {
      next = { ...sessionSnapshot(bootstrap), credential };
    } catch (error) {
      setState("error");
      throw error;
    }
    if (credential !== credentialSnapshot()) {
      baseline ??= next;
      if (baseline.context === undefined) invalidate();
      else {
        setState("checking");
        foreground();
      }
      return;
    }
    if (baseline !== undefined) {
      try {
        if (!sameSession(baseline, next)) {
          invalidate();
          return;
        }
      } catch (error) {
        setState("error");
        throw error;
      }
    }
    baseline = next;
    if (document.visibilityState === "hidden") visibility();
    else schedule();
  };
  retry = foreground;
  window.addEventListener("focus", foreground);
  window.addEventListener("online", foreground);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, cleared);
  return () => {
    disposed = true;
    generation += 1;
    cancel();
    observe = undefined;
    retry = undefined;
    window.removeEventListener("focus", foreground);
    window.removeEventListener("online", foreground);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, cleared);
    setState("visible");
  };
}
