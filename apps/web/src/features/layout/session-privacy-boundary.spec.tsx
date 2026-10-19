import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBootstrap } from "../../api/auth";
import { SessionPrivacyBoundary } from "./session-privacy-boundary";
import { ConfirmDialog } from "./confirm-dialog";

const bootstrap = {
  account: { display_name: "Synthetic user", email_verified: true, is_active: true },
  allowed_actions: ["LOGOUT"],
  current_class: null,
  current_membership: null,
  destination: "JOIN_CLASS",
  teacher_profile: null,
  server_today: "2026-09-17",
};
const response = () =>
  new Response(JSON.stringify(bootstrap), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic-credential");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => response()),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("session checking panel", () => {
  it("integrates bootstrap observation, a failed focus check, retry, and a pre-existing modal", async () => {
    render(
      <>
        <SessionPrivacyBoundary pathname="/bootstrap" />
        <ConfirmDialog
          open
          onCancel={() => undefined}
          onConfirm={() => undefined}
          title="Private prior dialog"
          description="Private text"
          confirmLabel="Private action"
        />
      </>,
    );
    await act(async () => {
      await getBootstrap();
    });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.focus(window);
    const button = await screen.findByRole("button", { name: "다시 확인" });
    expect(screen.getByRole("dialog", { name: "로그인 상태 확인" })).toBeInTheDocument();
    expect(
      screen.queryByRole("alertdialog", { name: "Private prior dialog" }),
    ).not.toBeInTheDocument();
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "로그인 상태 확인" })).not.toBeInTheDocument(),
    );
    expect(document.body).not.toHaveAttribute("data-session-privacy");
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/bootstrap",
      expect.objectContaining({
        cache: "no-store",
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([
    "/login",
    "/demo",
    "/reset-password",
    "/sign-up",
    "/legal/privacy-policy",
    "/admin",
    "/admin/account",
    "/admin/login",
  ])("does not monitor public or separately authenticated routes: %s", async (pathname) => {
    render(<SessionPrivacyBoundary pathname={pathname} />);
    await act(async () => {
      await getBootstrap();
    });
    fireEvent.focus(window);
    expect(fetch).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveAttribute("data-session-privacy");
  });
});
