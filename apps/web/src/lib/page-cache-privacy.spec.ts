import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL } from "./authenticated-client-state";
import { installPageCachePrivacy } from "./page-cache-privacy";

const draftKey = "classhub:content-reuse:v1:1:notice:17";
const attemptKey = "classhub:idempotent-create:notice:1";
const reviewKey = "classhub:change-review:v1:1:17";
let dispose: (() => void) | undefined;

function transition(type: "pagehide" | "pageshow", persisted = true): void {
  window.dispatchEvent(new PageTransitionEvent(type, { persisted }));
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="root">Private profile</div><div role="dialog">Private attendance</div>';
  window.sessionStorage.setItem(draftKey, "private draft");
  window.sessionStorage.setItem(attemptKey, "pending write");
  window.sessionStorage.setItem(reviewKey, "private review");
  window.sessionStorage.setItem("unrelated-preference", "keep");
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("inert");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("page cache privacy", () => {
  it("leaves initial loads and ordinary unloads unchanged", () => {
    const reload = vi.fn();
    dispose = installPageCachePrivacy(reload);
    transition("pageshow", false);
    transition("pagehide", false);
    expect(document.getElementById("root")).toBeVisible();
    expect(document.body).not.toHaveAttribute("inert");
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(attemptKey)).toBe("pending write");
  });

  it("conceals the cached snapshot including portals before restoring it", () => {
    const reload = vi.fn(() => {
      expect(document.getElementById("root")).not.toBeVisible();
      expect(document.querySelector('[role="dialog"]')).not.toBeVisible();
      expect(document.body).toHaveAttribute("inert");
    });
    dispose = installPageCachePrivacy(reload);
    transition("pagehide");
    expect(document.body.style.getPropertyPriority("display")).toBe("important");
    expect(document.querySelector('[role="dialog"]')).not.toBeVisible();
    transition("pageshow");
    expect(reload).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
  });

  it("keeps the old page concealed while a reload is delayed or offline", () => {
    const reload = vi.fn();
    dispose = installPageCachePrivacy(reload);
    transition("pageshow");
    expect(reload).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
    expect(document.body).toHaveAttribute("inert");
  });

  it("preserves normal drafts and pending idempotent writes without an invalidation", () => {
    window.localStorage.setItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, "earlier-transition");
    dispose = installPageCachePrivacy(vi.fn());
    transition("pagehide");
    transition("pageshow");
    expect(window.sessionStorage.getItem(draftKey)).toBe("private draft");
    expect(window.sessionStorage.getItem(attemptKey)).toBe("pending write");
    expect(window.sessionStorage.getItem(reviewKey)).toBe("private review");
  });

  it("clears private storage when a frozen tab missed another tab's invalidation", () => {
    dispose = installPageCachePrivacy(vi.fn());
    transition("pagehide");
    window.localStorage.setItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, "missed-logout");
    // Deliberately no storage event: restoring the page must detect the change.
    transition("pageshow");
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
    expect(window.sessionStorage.getItem(attemptKey)).toBeNull();
    expect(window.sessionStorage.getItem(reviewKey)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated-preference")).toBe("keep");
    expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).toBe(
      "missed-logout",
    );
  });

  it("reloads with the document concealed when storage access is blocked", () => {
    const reload = vi.fn();
    dispose = installPageCachePrivacy(reload);
    transition("pagehide");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    transition("pageshow");
    expect(reload).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
  });

  it("removes lifecycle handlers when disposed", () => {
    const reload = vi.fn();
    dispose = installPageCachePrivacy(reload);
    dispose();
    transition("pagehide");
    transition("pageshow");
    expect(reload).not.toHaveBeenCalled();
    expect(document.getElementById("root")).toBeVisible();
  });
});
