import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "./login-page";
import { SignUpPage } from "./sign-up-page";
vi.mock("../legal/use-consent-documents", () => ({
  useConsentDocuments: () => ({
    ready: true,
    documents: undefined,
    error: undefined,
    reload: vi.fn(),
  }),
}));
import { VerifyEmailPage } from "./verify-email-page";

function renderInRouter(element: React.ReactNode): void {
  render(<MemoryRouter>{element}</MemoryRouter>);
}

describe("authentication page heading hierarchy", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("uses the visible login title as the single level-one heading", () => {
    renderInRouter(<LoginPage />);

    expect(screen.getByRole("heading", { level: 1, name: "로그인" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector('[data-auth-context-panel="compact"]')).not.toHaveClass(
      "bg-brand-navy",
    );
    // 2026-09-27 확정 시안: PC 왼쪽은 칠판 한 장, 휴대폰은 작은 칠판 머리.
    expect(document.querySelector('[data-auth-chalkboard="desktop"]')).toBeInTheDocument();
    expect(document.querySelector('[data-auth-chalkboard="mobile"]')).toBeInTheDocument();
    expect(document.querySelector('[data-login-desktop-visual="classroom-hub"]')).toBeNull();
    expect(document.querySelector("[data-auth-card]")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "로그인" }),
    );
  });

  it("uses the visible sign-up title as the single level-one heading", () => {
    renderInRouter(<SignUpPage />);

    expect(screen.getByRole("heading", { level: 1, name: "가입" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // 가입 화면도 같은 칠판 틀(로그인만의 휴대폰 칠판 머리는 없음).
    expect(document.querySelector('[data-auth-chalkboard="desktop"]')).toBeInTheDocument();
    expect(document.querySelector('[data-auth-chalkboard="mobile"]')).toBeNull();
  });

  it("keeps the verification destination as the level-one heading", async () => {
    window.history.replaceState({ idx: 0 }, "", "/verify-email");
    renderInRouter(<VerifyEmailPage />);

    expect(await screen.findByRole("heading", { name: "인증 정보가 없어요" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "이메일 확인" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});
