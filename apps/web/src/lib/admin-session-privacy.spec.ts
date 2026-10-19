import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSessionResponse } from "../api/admin-auth";
import {
  ADMIN_SESSION_CLEAR_SIGNAL,
  ADMIN_SESSION_EXPIRED_EVENT,
  adminSessionDeadline,
  installAdminSessionPrivacy,
  rememberAdminSessionDeadline,
} from "./admin-session-privacy";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";
let now = 0,
  visibility: DocumentVisibilityState = "visible",
  cookie = "synthetic-admin";
let guard: ReturnType<typeof installAdminSessionPrivacy> | undefined;
const base = Date.parse("2026-09-18T00:00:00Z");
const session = (remaining = 1800_000): AdminSessionResponse => ({
  server_now: new Date(base + now).toISOString(),
  account: {
    id: "17",
    roles: ["super_admin", "support"],
    display_name: "Synthetic admin",
    email: "admin@example.invalid",
  },
  session: {
    issued_at: new Date(base).toISOString(),
    absolute_expires_at: new Date(base + now + remaining).toISOString(),
    last_seen_at: new Date(base).toISOString(),
    mfa_verified_at: new Date(base).toISOString(),
    reauthenticated_at: null,
  },
});
const check = vi.fn<(signal: AbortSignal) => Promise<AdminSessionResponse>>(),
  onVerified = vi.fn(),
  onEnded = vi.fn(),
  onState = vi.fn(),
  replace = vi.fn();
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const advance = async (ms: number) => {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
};
function start(initial = session()) {
  guard = installAdminSessionPrivacy({
    session: initial,
    check,
    onVerified,
    onEnded,
    onState,
    replace,
  });
}
function visible(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  visibility = "visible";
  cookie = "synthetic-admin";
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "cookie", "get").mockImplementation(
    () => "__Host-classhub_admin_csrf=" + cookie,
  );
  document.body.innerHTML =
    '<div id="root"><input value="synthetic draft" /></div><div role="dialog">Private security dialog</div>';
  sessionStorage.setItem("classhub:content-reuse:regular-user", "keep separate user draft");
  check.mockReset().mockImplementation(async () => session(1800_000 - now));
  onVerified.mockReset();
  onEnded.mockReset();
  onState.mockReset();
  replace.mockReset();
});
afterEach(() => {
  guard?.dispose();
  guard = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("inert");
  sessionStorage.clear();
});
describe("administrator open-page privacy", () => {
  it("covers at the known expiry even when an earlier periodic read is still pending", async () => {
    check.mockImplementation(() => new Promise(() => undefined));
    start(session(61_000));
    await advance(60_000);
    expect(check).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveAttribute("data-session-privacy");
    await advance(1000);
    expect(document.body).toHaveAttribute("data-session-privacy");
    expect(check).toHaveBeenCalledOnce();
  });
  it("covers an already elapsed initial response before scheduling another task", () => {
    check.mockImplementation(() => new Promise(() => undefined));
    start(session(0));
    expect(document.body).toHaveAttribute("data-session-privacy");
  });
  it("conceals before a delayed expiration check and only navigates after confirmation", async () => {
    let reject!: (error: unknown) => void;
    check.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    start(session(1000));
    await advance(1000);
    expect(document.body).toHaveAttribute("data-session-privacy");
    expect(check).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    reject({ code: "ADMIN_SESSION_REQUIRED", status: 401 });
    await flush();
    expect(document.body).not.toBeVisible();
    expect(document.body).toHaveAttribute("inert");
    expect(onEnded).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("classhub:content-reuse:regular-user")).toBe(
      "keep separate user draft",
    );
  });
  it("checks visible pages every minute without changing their original deadline", async () => {
    const initial = session();
    start(initial);
    await advance(60_000);
    expect(check).toHaveBeenCalledOnce();
    expect(adminSessionDeadline(initial)).toBe(1800_000);
    expect(onVerified).toHaveBeenCalledOnce();
    expect(adminSessionDeadline(onVerified.mock.calls[0]![0])).toBe(1800_000);
  });
  it("hides on tab departure and restores only a verified unchanged identity", async () => {
    let resolve!: (value: AdminSessionResponse) => void;
    check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    start();
    visible("hidden");
    await advance(60_000);
    expect(check).not.toHaveBeenCalled();
    expect(document.body).toHaveAttribute("data-session-privacy");
    visible("visible");
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledOnce();
    resolve(session());
    await flush();
    expect(document.body).not.toHaveAttribute("data-session-privacy");
    expect(document.querySelector("input")?.value).toBe("synthetic draft");
  });
  it.each(["id", "roles", "issued_at", "mfa_verified_at"])(
    "discards the old document when %s changes",
    async (field) => {
      start();
      const changed = session();
      if (field === "id") changed.account.id = "18";
      else if (field === "roles") changed.account.roles = ["support"];
      else
        changed.session[field as "issued_at" | "mfa_verified_at"] = new Date(
          base + 1000,
        ).toISOString();
      check.mockResolvedValue(changed);
      window.dispatchEvent(new Event("focus"));
      await flush();
      expect(replace).toHaveBeenCalledOnce();
      expect(onVerified).not.toHaveBeenCalled();
      expect(document.body).not.toBeVisible();
    },
  );
  it("accepts explicit renewal and changed last-seen/step-up times without confusing them with login", async () => {
    start(session(1000));
    const current = session();
    current.account.roles.reverse();
    current.session.last_seen_at = new Date(base + 1000).toISOString();
    current.session.reauthenticated_at = new Date(base + 1000).toISOString();
    check.mockResolvedValue(current);
    await advance(1000);
    expect(replace).not.toHaveBeenCalled();
    expect(onVerified).toHaveBeenCalledWith(current);
    expect(document.body).not.toHaveAttribute("data-session-privacy");
  });
  it.each([
    new TypeError("offline"),
    { code: "UNAVAILABLE", status: 503 },
    { code: "ADMIN_STEP_UP_REQUIRED", status: 401 },
    { code: "FORBIDDEN", status: 403 },
  ])(
    "keeps failures covered and preserves the session before the known expiry: %j",
    async (failure) => {
      start();
      check.mockRejectedValueOnce(failure);
      window.dispatchEvent(new Event("focus"));
      await flush();
      expect(onState).toHaveBeenLastCalledWith("error");
      expect(onEnded).not.toHaveBeenCalled();
      guard?.retry();
      await flush();
      expect(onState).toHaveBeenLastCalledWith("visible");
    },
  );
  it("returns to login if the known deadline has passed and confirmation is unavailable", async () => {
    start(session(1000));
    check.mockRejectedValue(new TypeError("offline"));
    await advance(1000);
    expect(replace).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
  });
  it("conceals before synchronous navigation and handles duplicate expiry signals once", () => {
    replace.mockImplementation(() => {
      expect(document.body).not.toBeVisible();
      expect(document.body).toHaveAttribute("inert");
    });
    start();
    window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
    window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
    expect(replace).toHaveBeenCalledOnce();
    expect(onEnded).toHaveBeenCalledOnce();
  });
  it("accepts only the dedicated non-null administrator logout storage signal", () => {
    start();
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "value" }));
    window.dispatchEvent(
      new StorageEvent("storage", { key: ADMIN_SESSION_CLEAR_SIGNAL, newValue: null }),
    );
    expect(replace).not.toHaveBeenCalled();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ADMIN_SESSION_CLEAR_SIGNAL,
        newValue: "synthetic-notification",
      }),
    );
    expect(replace).toHaveBeenCalledOnce();
  });
  it("detects cookie changes before and during verification", async () => {
    start();
    check.mockImplementation(async () => {
      cookie = "new-session";
      return session();
    });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(replace).toHaveBeenCalledOnce();
  });
  it("ignores canceled or late responses after a new tab state or route owns the view", async () => {
    let resolve!: (value: AdminSessionResponse) => void;
    check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    start();
    window.dispatchEvent(new Event("focus"));
    const signal = check.mock.calls[0]![0];
    visible("hidden");
    expect(signal.aborted).toBe(true);
    resolve(session());
    await flush();
    expect(onVerified).not.toHaveBeenCalled();
    expect(document.body).toHaveAttribute("data-session-privacy");
    guard?.dispose();
    guard = undefined;
    await advance(120_000);
    expect(check).toHaveBeenCalledOnce();
  });
  it("does not undo BFCache or irreversible document concealment after successful verification", async () => {
    start();
    concealAuthenticatedDocument();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(document.body).not.toBeVisible();
  });
  it("does not add response transit time to the server's session lifetime", () => {
    const current = session(30_000);
    now = 20_000;
    rememberAdminSessionDeadline(current, 0);
    expect(adminSessionDeadline(current)).toBe(30_000);
  });
  it("does not restore malformed, expired, or nonfinite session responses", async () => {
    start();
    check.mockResolvedValue({
      ...session(),
      session: { ...session().session, absolute_expires_at: "invalid" },
    });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(document.body).not.toBeVisible();
    expect(replace).toHaveBeenCalledOnce();
  });
});
