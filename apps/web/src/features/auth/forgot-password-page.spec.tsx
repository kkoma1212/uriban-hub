import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForgotPasswordPage } from "./forgot-password-page";

function acceptedResponse(): Response {
  return new Response(JSON.stringify({ request_accepted: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ForgotPasswordPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["PASSWORD_RESET_UNAVAILABLE", "현재 비밀번호 찾기를 이용할 수 없어요.", true],
    ["NOT_FOUND", "재설정 메일을 요청하지 못했어요. 잠시 후 다시 시도해 주세요.", false],
  ])(
    "distinguishes unavailable recovery from an unrelated 404: %s",
    async (code, message, unavailable) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { code, message: "failure" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
      render(
        <MemoryRouter>
          <ForgotPasswordPage />
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText(/^이메일/u), {
        target: { value: "student@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "재설정 메일 받기" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      const support = screen.queryByRole("link", { name: "운영자에게 문의하기" });
      if (unavailable) expect(support).toHaveAttribute("href", expect.stringMatching(/^mailto:/u));
      else expect(support).not.toBeInTheDocument();
    },
  );
  it("associates invalid email feedback and does not send a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "재설정 메일 받기" }));

    const email = screen.getByLabelText(/^이메일/u);
    await waitFor(() => expect(email).toHaveAttribute("aria-invalid", "true"));
    expect(email).toBeRequired();
    expect(email).toHaveAttribute("aria-required", "true");
    expect(email).toHaveAttribute("aria-describedby", "password-reset-email-error");
    expect(screen.getByText("이메일 형식을 확인해 주세요.")).toHaveAttribute("role", "alert");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the same generic completion message after an accepted request", async () => {
    let resolveRequest!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(response);
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/^이메일/u), {
      target: { value: "  Student@Example.COM " },
    });
    fireEvent.click(screen.getByRole("button", { name: "재설정 메일 받기" }));

    const busyButton = await screen.findByRole("button", { name: "요청하는 중" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      resolveRequest(acceptedResponse());
    });

    expect(await screen.findByRole("heading", { name: "메일을 확인해 주세요" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "입력한 이메일로 가입된 활성 계정이 있다면 재설정 메일을 보냈어요.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/password-reset-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student@example.com" }),
      signal: expect.any(AbortSignal),
    });
  });
});
