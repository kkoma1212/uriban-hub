import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdminSession, logoutAdmin } from "./admin-auth";
import {
  ADMIN_SESSION_CLEAR_SIGNAL,
  ADMIN_SESSION_EXPIRED_EVENT,
} from "../lib/admin-session-privacy";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-classhub_admin_csrf=synthetic-credential",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
describe("administrator session API privacy", () => {
  it("uses a cancelable uncached read for session verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          server_now: "2026-09-18T00:00:00Z",
          session: { absolute_expires_at: "2026-09-18T00:30:00Z" },
        }),
      ),
    );
    const controller = new AbortController();
    await getAdminSession(controller.signal);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/admin/auth/session",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("notifies only after confirmed logout, including when cross-tab storage is blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => response({ logged_out: true })),
    );
    const listener = vi.fn();
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, listener);
    try {
      await logoutAdmin();
      expect(listener).toHaveBeenCalledOnce();
      expect(localStorage.getItem(ADMIN_SESSION_CLEAR_SIGNAL)).not.toBeNull();
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new Error("blocked");
      });
      await logoutAdmin();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, listener);
    }
  });
  it.each([response({ error: { code: "FAILED" } }, 503), new TypeError("unknown outcome")])(
    "keeps an uncertain logout from emitting a completion signal",
    async (outcome) => {
      vi.stubGlobal(
        "fetch",
        outcome instanceof Error
          ? vi.fn().mockRejectedValue(outcome)
          : vi.fn().mockResolvedValue(outcome),
      );
      const listener = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, listener);
      try {
        await expect(logoutAdmin()).rejects.toThrow();
        expect(listener).not.toHaveBeenCalled();
        expect(localStorage.getItem(ADMIN_SESSION_CLEAR_SIGNAL)).toBeNull();
      } finally {
        window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, listener);
      }
    },
  );
});
