import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapResponse } from "../api/auth";
import { clearCurrentTabAuthenticatedClientState } from "./authenticated-client-state";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";
import {
  beginSessionPrivacyObservation,
  getSessionPrivacyState,
  installAuthenticatedSessionPrivacy,
  rememberSessionPrivacyObservation,
  retrySessionPrivacy,
  SESSION_RECHECK_INTERVAL_MS,
} from "./authenticated-session-privacy";

const bootstrap: BootstrapResponse = {
  account: { display_name: "Synthetic user", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "Synthetic class", status: "active" },
  current_membership: {
    class_id: "1",
    id: "2",
    role: "student",
    status: "approved",
    display_name_in_class: null,
    student_number: 1,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-17",
  teacher_profile: null,
};
const privateKeys = [
  "classhub:content-reuse:fixture",
  "classhub:idempotent-create:fixture",
  "classhub:change-review:fixture",
];
let dispose: (() => void) | undefined;
let visibility: DocumentVisibilityState;
let credential: string;
const check = vi.fn<(signal: AbortSignal) => Promise<BootstrapResponse>>();
const replace = vi.fn();
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function arm(initial: BootstrapResponse = bootstrap) {
  dispose = installAuthenticatedSessionPrivacy(check, replace);
  rememberSessionPrivacyObservation(beginSessionPrivacyObservation(), initial);
}
function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  credential = "synthetic-credential";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "cookie", "get").mockImplementation(
    () => "__Host-classhub_csrf=" + credential,
  );
  document.body.innerHTML =
    '<div id="root"><input value="unsaved private text" /></div><div role="dialog">Private portal</div>';
  privateKeys.forEach((key) => sessionStorage.setItem(key, "private draft"));
  sessionStorage.setItem("unrelated-preference", "keep");
  check.mockReset().mockResolvedValue(bootstrap);
  replace.mockReset();
});

describe("server-confirmed session identity", () => {
  const verified: BootstrapResponse = { ...bootstrap, session_context: "v1." + "A".repeat(43) };
  beforeEach(() => check.mockResolvedValue(verified));

  it.each([undefined, "invalid"])(
    "covers an observed identity downgrade and preserves drafts: %s",
    async (context) => {
      arm(verified);
      expect(() =>
        rememberSessionPrivacyObservation(beginSessionPrivacyObservation(), {
          ...verified,
          session_context: context,
        } as BootstrapResponse),
      ).toThrow();
      expect(getSessionPrivacyState()).toBe("error");
      expect(replace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
      retrySessionPrivacy();
      await flush();
      expect(getSessionPrivacyState()).toBe("visible");
    },
  );

  it("preserves drafts after a normal CSRF refresh of the same session", async () => {
    arm(verified);
    credential = "normally-refreshed-csrf";
    window.dispatchEvent(new Event("focus"));
    expect(getSessionPrivacyState()).toBe("checking");
    await flush();
    expect(check).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    expect(getSessionPrivacyState()).toBe("visible");
    privateKeys.forEach((key) => expect(sessionStorage.getItem(key)).toBe("private draft"));
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).not.toHaveBeenCalled();
  });

  it("requires another server read when credentials rotate during a request", async () => {
    let resolve!: (value: BootstrapResponse) => void;
    check
      .mockImplementationOnce(async () => {
        credential = "rotated-during-request";
        return verified;
      })
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    arm(verified);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    expect(getSessionPrivacyState()).toBe("checking");
    expect(replace).not.toHaveBeenCalled();
    resolve(verified);
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
    expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
  });

  it("never restores an old matching response across a concurrent new login", async () => {
    check
      .mockImplementationOnce(async () => {
        credential = "new-login-during-request";
        return verified;
      })
      .mockResolvedValueOnce({ ...verified, session_context: "v1." + "B".repeat(43) });
    arm(verified);
    window.dispatchEvent(new Event("focus"));
    await flush();
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledExactlyOnceWith("/bootstrap");
    expect(document.body).not.toBeVisible();
    expect(sessionStorage.getItem(privateKeys[0]!)).toBeNull();
  });

  it("detects a new session even with an unchanged readable cookie and account display", async () => {
    arm(verified);
    check.mockResolvedValue({ ...verified, session_context: "v1." + "B".repeat(43) });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(privateKeys[0]!)).toBeNull();
  });

  it.each([undefined, "", "malformed", 42])(
    "fails closed on a missing or invalid identity without erasing drafts: %s",
    async (context) => {
      arm(verified);
      check.mockResolvedValue({ ...verified, session_context: context } as BootstrapResponse);
      window.dispatchEvent(new Event("focus"));
      await flush();
      expect(getSessionPrivacyState()).toBe("error");
      expect(replace).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
    },
  );

  it("bounds automatic reads when credentials keep changing and leaves a retry", async () => {
    check.mockImplementation(async () => {
      credential += "-rotated";
      return verified;
    });
    arm(verified);
    window.dispatchEvent(new Event("focus"));
    await flush();
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    expect(getSessionPrivacyState()).toBe("error");
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
    check.mockResolvedValue(verified);
    retrySessionPrivacy();
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
  });

  it("covers a first bootstrap response crossed by CSRF rotation until a fresh check", async () => {
    let resolve!: (value: BootstrapResponse) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    dispose = installAuthenticatedSessionPrivacy(check, replace);
    const request = beginSessionPrivacyObservation();
    credential = "rotated-before-first-response";
    rememberSessionPrivacyObservation(request, verified);
    expect(getSessionPrivacyState()).toBe("checking");
    expect(replace).not.toHaveBeenCalled();
    resolve(verified);
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
    expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
  });

  it("keeps authorization changes destructive even within the same session", async () => {
    arm(verified);
    credential = "normal-csrf-refresh";
    check.mockResolvedValue({ ...verified, allowed_actions: ["LOGOUT"] });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(privateKeys[0]!)).toBeNull();
  });

  it("checks a rotated cookie on the periodic path before returning to visible", async () => {
    let resolve!: (value: BootstrapResponse) => void;
    check.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    arm(verified);
    credential = "normal-periodic-refresh";
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_INTERVAL_MS);
    expect(getSessionPrivacyState()).toBe("checking");
    expect(replace).not.toHaveBeenCalled();
    resolve(verified);
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("inert");
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
});
describe("open-page session privacy", () => {
  it("does not poll before a route has authenticated", async () => {
    dispose = installAuthenticatedSessionPrivacy(check, replace);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_INTERVAL_MS * 2);
    expect(check).not.toHaveBeenCalled();
    expect(getSessionPrivacyState()).toBe("visible");
  });
  it("hides on leaving the tab and waits for server verification before restoring drafts", async () => {
    let resolve!: (value: BootstrapResponse) => void;
    check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    arm();
    setVisibility("hidden");
    expect(document.body).toHaveAttribute("data-session-privacy");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).not.toHaveBeenCalled();
    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledOnce();
    expect(getSessionPrivacyState()).toBe("checking");
    resolve(bootstrap);
    await flush();
    expect(document.body).not.toHaveAttribute("data-session-privacy");
    expect(document.querySelector("input")?.value).toBe("unsaved private text");
    privateKeys.forEach((key) => expect(sessionStorage.getItem(key)).toBe("private draft"));
  });
  it("detects remote expiry without any focus, activity, or storage signal", async () => {
    check.mockRejectedValue({ code: "UNAUTHENTICATED", status: 401 });
    arm();
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_INTERVAL_MS);
    expect(replace).toHaveBeenCalledExactlyOnceWith("/bootstrap");
    expect(document.body).not.toBeVisible();
    expect(document.body).toHaveAttribute("inert");
    privateKeys.forEach((key) => expect(sessionStorage.getItem(key)).toBeNull());
    expect(sessionStorage.getItem("unrelated-preference")).toBe("keep");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(check).toHaveBeenCalledOnce();
  });
  it.each([
    new TypeError("offline"),
    { code: "REQUEST_TIMEOUT", status: 0 },
    { code: "UNAVAILABLE", status: 503 },
    { code: "TOO_MANY_REQUESTS", status: 429 },
    { code: "FORBIDDEN", status: 403 },
    { code: "INVALID_CREDENTIALS", status: 401 },
  ])("covers uncertain failures without clearing drafts: %j", async (failure) => {
    check.mockRejectedValueOnce(failure);
    arm();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getSessionPrivacyState()).toBe("error");
    expect(replace).not.toHaveBeenCalled();
    privateKeys.forEach((key) => expect(sessionStorage.getItem(key)).toBe("private draft"));
    retrySessionPrivacy();
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
  });
  it("never resumes a prior account after a credential change, even with the same name and role", async () => {
    arm();
    credential = "other-synthetic-credential";
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(check).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    privateKeys.forEach((key) => expect(sessionStorage.getItem(key)).toBeNull());
  });
  it("detects a credential change during the request", async () => {
    check.mockImplementation(async () => {
      credential = "changed-during-request";
      return bootstrap;
    });
    arm();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
  });
  it.each([
    { destination: "JOIN_CLASS" },
    { current_membership: null },
    { allowed_actions: ["LOGOUT"] },
    { current_class: { id: "1", name: "Synthetic class", status: "suspended" } },
  ])("rechecks navigation after authorization changes: %j", async (change) => {
    check.mockResolvedValue({ ...bootstrap, ...change } as BootstrapResponse);
    arm();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
  });
  it("does not treat a new day, action order, or display-name edit as another account", async () => {
    check.mockResolvedValue({
      ...bootstrap,
      allowed_actions: [...bootstrap.allowed_actions].reverse(),
      server_today: "2026-09-18",
      account: { ...bootstrap.account, display_name: "Updated name" },
    });
    arm();
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_INTERVAL_MS);
    expect(replace).not.toHaveBeenCalled();
    expect(getSessionPrivacyState()).toBe("visible");
  });
  it("keeps malformed success responses covered", async () => {
    check.mockResolvedValue({} as BootstrapResponse);
    arm();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getSessionPrivacyState()).toBe("error");
    expect(replace).not.toHaveBeenCalled();
  });
  it("does not restore a response from before a tab was hidden or its route disposed", async () => {
    let resolve!: (value: BootstrapResponse) => void;
    check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    arm();
    window.dispatchEvent(new Event("focus"));
    const signal = check.mock.calls[0]![0];
    setVisibility("hidden");
    expect(signal.aborted).toBe(true);
    resolve(bootstrap);
    await flush();
    expect(getSessionPrivacyState()).toBe("checking");
    dispose?.();
    dispose = undefined;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledOnce();
  });
  it("ignores bootstrap responses started before logout or route disposal", async () => {
    arm();
    const old = beginSessionPrivacyObservation();
    clearCurrentTabAuthenticatedClientState();
    rememberSessionPrivacyObservation(old, bootstrap);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).not.toHaveBeenCalled();
    dispose?.();
    dispose = installAuthenticatedSessionPrivacy(check, replace);
    rememberSessionPrivacyObservation(old, bootstrap);
    window.dispatchEvent(new Event("focus"));
    expect(check).not.toHaveBeenCalled();
  });
  it("never undoes irreversible BFCache or cross-tab concealment", async () => {
    arm();
    concealAuthenticatedDocument();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(document.body).not.toBeVisible();
    expect(document.body).toHaveAttribute("inert");
  });
  it("can check remotely when localStorage signaling is unavailable", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    arm();
    check.mockRejectedValue({ code: "UNAUTHENTICATED", status: 401 });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
  });
  it("covers unreadable credentials without deleting drafts or reloading repeatedly", async () => {
    credential = "";
    arm();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getSessionPrivacyState()).toBe("error");
    expect(replace).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(privateKeys[0]!)).toBe("private draft");
  });
  it("covers offline transitions and resumes only after a successful online check", async () => {
    arm();
    window.dispatchEvent(new Event("offline"));
    expect(getSessionPrivacyState()).toBe("error");
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(getSessionPrivacyState()).toBe("visible");
  });
});
