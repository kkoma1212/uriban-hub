import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VerifyEmailPage } from "./verify-email-page";

const successfulConfirmation = (): Response =>
  new Response(JSON.stringify({ email_verified: true, next_action: "LOGIN" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("VerifyEmailPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["a missing fragment", "/verify-email", 0, "/verify-email"],
    ["an empty token fragment", "/verify-email?source=mail#token=", 1, "/verify-email?source=mail"],
  ] as const)(
    "treats %s as missing without sending a confirmation request",
    async (_, url, clears, expectedLocation) => {
      const preservedState = { idx: 7, key: "mail", usr: { source: "mail" } };
      window.history.replaceState(preservedState, "", url);
      const replaceStateMock = vi.spyOn(window.history, "replaceState");
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(() => Promise.resolve(successfulConfirmation()));

      render(
        <StrictMode>
          <MemoryRouter>
            <VerifyEmailPage />
          </MemoryRouter>
        </StrictMode>,
      );

      const heading = await screen.findByRole("heading", { name: "인증 정보가 없어요" });
      expect(heading).toBeInTheDocument();
      expect(heading.closest('[role="alert"]')).toHaveAttribute("aria-live", "assertive");
      const recoveryCopy = screen.getByText(
        "로그인하면 이메일로 받은 6자리 인증번호를 입력하는 화면이 나와요.",
      );
      expect(recoveryCopy).toHaveClass("break-keep");
      expect(recoveryCopy.textContent).toContain("입력하는\u00a0화면이 나와요.");
      expect(screen.getByRole("link", { name: "로그인 화면에서 다시 시작" })).toHaveAttribute(
        "href",
        "/login",
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(`${window.location.pathname}${window.location.search}`).toBe(expectedLocation);
      expect(window.location.hash).toBe("");
      expect(window.history.state).toEqual(preservedState);
      expect(replaceStateMock).toHaveBeenCalledTimes(clears);
      if (clears === 1) {
        expect(replaceStateMock).toHaveBeenCalledWith(preservedState, "", expectedLocation);
      }
    },
  );

  it("confirms a nonempty token once and immediately clears the fragment", async () => {
    const token = "A".repeat(43);
    const preservedState = { idx: 4, key: "verify", usr: null };
    window.history.replaceState(preservedState, "", `/verify-email?source=mail#token=${token}`);
    const replaceStateMock = vi.spyOn(window.history, "replaceState");
    let hashAtRequest: string | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      hashAtRequest = window.location.hash;
      return Promise.resolve(successfulConfirmation());
    });

    render(
      <StrictMode>
        <MemoryRouter>
          <VerifyEmailPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", { name: "이메일 확인이 완료됐어요!" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/email-verifications/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: expect.any(AbortSignal),
    });
    expect(hashAtRequest).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/verify-email");
    expect(window.location.search).toBe("?source=mail");
    expect(window.history.state).toEqual(preservedState);
    expect(replaceStateMock).toHaveBeenCalledTimes(1);
    expect(replaceStateMock).toHaveBeenCalledWith(preservedState, "", "/verify-email?source=mail");
  });
});
