import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForgotAccountPage } from "./forgot-account-page";

describe("ForgotAccountPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("validates the email and connects the inline error without a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <MemoryRouter>
        <ForgotAccountPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "아이디 안내 메일 받기" }));
    const input = screen.getByLabelText(/^이메일/u);
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAttribute("aria-describedby", "account-recovery-error");
    expect(input).toBeRequired();
    expect(screen.getByRole("alert")).toHaveTextContent("이메일 형식을 확인해 주세요.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one normalized request and shows only the generic mailbox guidance", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <MemoryRouter>
        <ForgotAccountPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText(/^이메일/u), {
      target: { value: "Student@Example.Invalid" },
    });
    const button = screen.getByRole("button", { name: "아이디 안내 메일 받기" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/account-recovery-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student@example.invalid" }),
      signal: expect.any(AbortSignal),
    });
    await act(async () =>
      finish(
        new Response(JSON.stringify({ request_accepted: true }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "입력한 이메일로 아이디 안내를 요청했어요.",
    );
    expect(screen.queryByText("가입된 계정이 있습니다")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "비밀번호 찾기" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});
