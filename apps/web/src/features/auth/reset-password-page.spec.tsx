import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResetPasswordPage } from "./reset-password-page";

function LoginStateProbe(): React.JSX.Element {
  const location = useLocation();
  const state = location.state as { passwordChanged?: boolean } | null;
  return <p>{state?.passwordChanged === true ? "새 비밀번호 로그인" : "로그인"}</p>;
}

function renderPage(strict = false): void {
  const page = (
    <MemoryRouter initialEntries={["/reset-password"]}>
      <Routes>
        <Route element={<ResetPasswordPage />} path="/reset-password" />
        <Route element={<LoginStateProbe />} path="/login" />
      </Routes>
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{page}</StrictMode> : page);
}

describe("ResetPasswordPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["a missing fragment", "/reset-password?source=mail", 0],
    ["an empty token fragment", "/reset-password?source=mail#token=", 1],
  ] as const)("treats %s as missing without sending a request", (_, url, clearCount) => {
    const preservedState = { idx: 5, key: "reset", usr: { source: "mail" } };
    window.history.replaceState(preservedState, "", url);
    const replaceStateMock = vi.spyOn(window.history, "replaceState");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(
      <StrictMode>
        <MemoryRouter>
          <ResetPasswordPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(screen.getByRole("heading", { name: "재설정 정보가 없어요" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/reset-password");
    expect(window.location.search).toBe("?source=mail");
    expect(window.history.state).toEqual(preservedState);
    expect(replaceStateMock).toHaveBeenCalledTimes(clearCount);
    if (clearCount === 1) {
      expect(replaceStateMock).toHaveBeenCalledWith(
        preservedState,
        "",
        "/reset-password?source=mail",
      );
    }
  });

  it("clears the fragment before confirming and replace-navigates to a fresh login", async () => {
    const token = "A".repeat(43);
    const preservedState = { idx: 8, key: "reset-mail", usr: null };
    window.history.replaceState(preservedState, "", `/reset-password?source=mail#token=${token}`);
    const replaceStateMock = vi.spyOn(window.history, "replaceState");
    let hashAtRequest: string | undefined;
    let resolveReset!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      hashAtRequest = window.location.hash;
      return new Promise<Response>((resolve) => {
        resolveReset = resolve;
      });
    });

    renderPage(true);

    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?source=mail");
    expect(window.history.state).toEqual(preservedState);
    expect(replaceStateMock).toHaveBeenCalledWith(
      preservedState,
      "",
      "/reset-password?source=mail",
    );

    const newPassword = screen.getByLabelText(/^새 비밀번호 \(필수\)$/u);
    expect(newPassword).toBeRequired();
    expect(newPassword).toHaveAttribute("aria-required", "true");
    expect(newPassword).toHaveAttribute("aria-describedby", "reset-password-rules");
    fireEvent.change(newPassword, { target: { value: "Cedar#72" } });
    fireEvent.change(screen.getByLabelText(/^새 비밀번호 확인/u), {
      target: { value: "Cedar#72" },
    });
    fireEvent.click(screen.getByRole("button", { name: "새 비밀번호로 변경" }));

    const busyButton = await screen.findByRole("button", { name: "변경하는 중" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(hashAtRequest).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/password-resets/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: "Cedar#72", token }),
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      resolveReset(
        new Response(JSON.stringify({ next_action: "LOGIN", password_reset: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    expect(await screen.findByText("새 비밀번호 로그인")).toBeVisible();
  });

  it("allows Korean mixed input and still requires matching confirmation", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${"B".repeat(43)}`);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderPage();

    fireEvent.change(screen.getByLabelText(/^새 비밀번호 \(필수\)$/u), {
      target: { value: "한글비밀번호1" },
    });
    fireEvent.change(screen.getByLabelText(/^새 비밀번호 확인/u), {
      target: { value: "다른비밀번호1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "새 비밀번호로 변경" }));
    expect(await screen.findByText("새 비밀번호가 서로 일치하지 않아요.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches the API password limits by Unicode code point", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${"C".repeat(43)}`);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ next_action: "LOGIN", password_reset: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderPage();

    const newPassword = screen.getByLabelText(/^새 비밀번호 \(필수\)$/u);
    const confirmation = screen.getByLabelText(/^새 비밀번호 확인/u);
    const fiveCodePoints = `A1${"😀".repeat(3)}`;
    fireEvent.change(newPassword, { target: { value: fiveCodePoints } });
    fireEvent.change(confirmation, { target: { value: fiveCodePoints } });
    fireEvent.click(screen.getByRole("button", { name: "새 비밀번호로 변경" }));
    expect(await screen.findByText("비밀번호는 6자 이상이어야 해요.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();

    const longPassword = `A1${"😀".repeat(129)}`;
    fireEvent.change(newPassword, { target: { value: longPassword } });
    fireEvent.change(confirmation, { target: { value: longPassword } });
    fireEvent.click(screen.getByRole("button", { name: "새 비밀번호로 변경" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      new_password: longPassword,
    });
  });

  it("does not describe a validation response as an expired link", async () => {
    window.history.replaceState(null, "", `/reset-password#token=${"D".repeat(43)}`);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_FAILED",
            message: "너무 흔하거나 유출된 비밀번호예요. 다른 비밀번호를 선택해 주세요.",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderPage();

    fireEvent.change(screen.getByLabelText(/^새 비밀번호 \(필수\)$/u), {
      target: { value: "Cedar#72" },
    });
    fireEvent.change(screen.getByLabelText(/^새 비밀번호 확인/u), {
      target: { value: "Cedar#72" },
    });
    fireEvent.click(screen.getByRole("button", { name: "새 비밀번호로 변경" }));

    expect(
      await screen.findByText("너무 흔하거나 유출된 비밀번호예요. 다른 비밀번호를 선택해 주세요."),
    ).toBeVisible();
    expect(screen.queryByText(/링크가 만료됐거나 이미 사용됐어요/u)).not.toBeInTheDocument();
  });
});
