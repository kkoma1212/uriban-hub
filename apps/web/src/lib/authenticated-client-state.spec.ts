import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL,
  clearAuthenticatedClientState,
  handleAuthenticatedClientStateStorage,
} from "./authenticated-client-state";

describe("authenticated content storage cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    document.body.removeAttribute("inert");
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  it.each(["this tab", "another tab"])(
    "clears reuse drafts and pending writes after logout in %s",
    (tab) => {
      window.sessionStorage.setItem(
        "classhub:content-reuse:v1:1:notice:17",
        "private notice draft",
      );
      window.sessionStorage.setItem(
        "classhub:content-reuse:v1:2:homework:21",
        "private homework draft",
      );
      window.sessionStorage.setItem(
        "classhub:idempotent-create:reuse-notice-17:1",
        "pending request",
      );
      window.sessionStorage.setItem("classhub:change-review:v1:1:17", "private change plan");
      window.sessionStorage.setItem("unrelated-preference", "keep");
      const replace = vi.fn();
      if (tab === "this tab") {
        clearAuthenticatedClientState();
        expect(window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL)).not.toBeNull();
        expect(document.body).toBeVisible();
      } else {
        handleAuthenticatedClientStateStorage(
          { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: "logout-signal" },
          replace,
        );
        expect(replace).toHaveBeenCalledWith("/bootstrap");
      }
      expect(window.sessionStorage.length).toBe(1);
      expect(window.sessionStorage.getItem("unrelated-preference")).toBe("keep");
    },
  );

  it("conceals the old page and dialog before another tab's replacement navigation starts", () => {
    document.body.innerHTML =
      '<div id="root">Private class list</div><div role="dialog">Private attendance</div>';
    const replace = vi.fn(() => {
      expect(document.getElementById("root")).not.toBeVisible();
      expect(document.querySelector('[role="dialog"]')).not.toBeVisible();
      expect(document.body).toHaveAttribute("inert");
    });
    handleAuthenticatedClientStateStorage(
      { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: "new-identity" },
      replace,
    );
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/bootstrap");
    // A slow or offline navigation must not reveal the old document again.
    expect(document.body.style.getPropertyPriority("display")).toBe("important");
    expect(document.body).not.toBeVisible();
  });

  it.each([
    { key: "appearance", newValue: "dark" },
    { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: null },
  ])("ignores storage changes outside an identity invalidation: %j", (event) => {
    document.body.textContent = "Current authorized view";
    window.sessionStorage.setItem("classhub:content-reuse:v1:1:notice:17", "current draft");
    const replace = vi.fn();
    handleAuthenticatedClientStateStorage(event, replace);
    expect(replace).not.toHaveBeenCalled();
    expect(document.body).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:v1:1:notice:17")).toBe(
      "current draft",
    );
  });

  it("still conceals and replaces the old document when private storage is unavailable", () => {
    document.body.textContent = "Private class list";
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const replace = vi.fn();
    handleAuthenticatedClientStateStorage(
      { key: AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, newValue: "logout" },
      replace,
    );
    expect(document.body).not.toBeVisible();
    expect(replace).toHaveBeenCalledWith("/bootstrap");
  });
});
