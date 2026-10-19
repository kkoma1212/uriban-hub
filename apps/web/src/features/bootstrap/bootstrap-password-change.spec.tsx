import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapPage } from "./bootstrap-page";

describe("BootstrapPage password change action", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links a temporary-password teacher directly to the required change screen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          account: { email_verified: true, is_active: true },
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"],
          current_class: null,
          current_membership: null,
          destination: "CHANGE_TEMPORARY_PASSWORD",
          last_membership_status: null,
          last_status_reason: null,
          server_today: "2026-07-15",
          teacher_profile: { status: "active", temporary_password_must_change: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "비밀번호 변경" })).toHaveAttribute(
      "href",
      "/account/password",
    );
    expect(screen.getByRole("link", { name: "비밀번호 변경" })).toHaveClass("ui-button-primary");
  });

  it.each(["CREATE_CLASS", "ENTER_INVITE_CODE"])(
    "puts the %s onboarding action before optional account settings",
    async (destination) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            account: { email_verified: true, is_active: true },
            allowed_actions: ["CHANGE_PASSWORD", "CREATE_CLASS", "LOGOUT"],
            current_class: null,
            current_membership: null,
            destination,
            last_membership_status: null,
            last_status_reason: null,
            server_today: "2026-10-10",
            teacher_profile: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      render(
        <MemoryRouter initialEntries={["/bootstrap"]}>
          <BootstrapPage />
        </MemoryRouter>,
      );
      const password = await screen.findByRole("link", { name: "비밀번호 변경" });
      const primary = screen.getByRole("button", {
        name: destination === "CREATE_CLASS" ? "반 만들기" : "반 참여 요청 보내기",
      });
      expect(primary).toHaveClass("ui-button-primary");
      expect(password).toHaveClass("ui-button-secondary");
      expect(
        primary.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByRole("heading", { name: "계정 설정" })).toBeInTheDocument();
    },
  );
});
