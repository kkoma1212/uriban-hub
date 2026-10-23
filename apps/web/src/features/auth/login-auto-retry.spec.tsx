import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./social-login-buttons", () => ({ SocialLoginButtons: () => null }));

import { ApiRequestError } from "../../api/auth";
import { loginAutoRetryDelayMs, MAX_LOGIN_AUTO_RETRIES } from "./login-auto-retry";
import { LoginPage } from "./login-page";

function errorResponse(status: number, code: string, retryAfterSeconds?: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: "서버 문구",
        ...(retryAfterSeconds === undefined
          ? {}
          : { details: { retry_after_seconds: retryAfterSeconds } }),
      },
    }),
    { headers: { "Content-Type": "application/json" }, status },
  );
}
const ok = () =>
  new Response(JSON.stringify({ next_action: "BOOTSTRAP" }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

describe("loginAutoRetryDelayMs", () => {
  const overloaded = new ApiRequestError("SERVICE_UNAVAILABLE", "x", 503, {
    retry_after_seconds: 2,
  });
  const limited = new ApiRequestError("RATE_LIMITED", "x", 429, { retry_after_seconds: 60 });

  it("서버 대기 시간에 무작위 시간을 더한다 — 503은 최대 2초, 1분 한도는 최대 10초", () => {
    expect(loginAutoRetryDelayMs(overloaded, () => 0)).toBe(2_000);
    expect(loginAutoRetryDelayMs(overloaded, () => 0.999)).toBe(3_998);
    expect(loginAutoRetryDelayMs(limited, () => 0)).toBe(60_000);
    expect(loginAutoRetryDelayMs(limited, () => 0.5)).toBe(65_000);
  });

  it("계정 잠금·비밀번호 틀림·대기 시간 없는 오류·네트워크 오류는 자동으로 다시 보내지 않는다", () => {
    for (const error of [
      new ApiRequestError("ACCOUNT_LOCKED", "x", 429, { retry_after_seconds: 30 }),
      new ApiRequestError("INVALID_CREDENTIALS", "x", 401),
      new ApiRequestError("SERVICE_UNAVAILABLE", "x", 503),
      new ApiRequestError("RATE_LIMITED", "x", 429, { retry_after_seconds: 0 }),
      new Error("network"),
    ]) {
      expect(loginAutoRetryDelayMs(error, () => 0)).toBeUndefined();
    }
  });
});

describe("LoginPage automatic retry when logins pile up", () => {
  beforeEach(() => {
    // 서버 대기 시간 그대로(무작위 0) — 시계를 정확히 돌릴 수 있게.
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function renderAndSubmit(): Promise<void> {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route element={<LoginPage />} path="/login" />
          <Route element={<p>첫 화면으로 이동</p>} path="/bootstrap" />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "student@example.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password1" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    await advance(10);
  }

  it("과부하(503)면 오류 창 대신 남은 시간을 보이고, 그 시간이 지나면 같은 입력으로 다시 시도한다", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(errorResponse(503, "SERVICE_UNAVAILABLE", 2))
      .mockResolvedValueOnce(ok());
    await renderAndSubmit();

    expect(screen.getByRole("status")).toHaveTextContent("지금 로그인하는 사람이 많아요");
    expect(screen.getByRole("button", { name: "2초 뒤 자동으로 다시 시도" })).toBeDisabled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(screen.getByRole("button", { name: "1초 뒤 자동으로 다시 시도" })).toBeDisabled();
    await advance(1_010);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({
      email: "student@example.com",
      password: "password1",
    });
    expect(screen.getByText("첫 화면으로 이동")).toBeInTheDocument();
  });

  it(`자동 재시도는 ${String(MAX_LOGIN_AUTO_RETRIES)}번까지 — 그 뒤엔 무엇을 하면 되는지 알린다`, async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => errorResponse(503, "SERVICE_UNAVAILABLE", 2));
    await renderAndSubmit();
    for (let retry = 1; retry <= MAX_LOGIN_AUTO_RETRIES; retry += 1) {
      await advance(2_010);
      expect(fetch).toHaveBeenCalledTimes(retry + 1);
    }
    expect(screen.getByRole("alertdialog", { name: "로그인할 수 없어요" })).toHaveTextContent(
      "지금 로그인하는 사람이 많아 들어가지 못했어요. 잠시 뒤 다시 눌러 주세요.",
    );
    await advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(MAX_LOGIN_AUTO_RETRIES + 1);
  });

  it("멈추기를 누르거나 입력을 고치면 예약한 재시도를 지우고, 멈춘 뒤 초점은 로그인 단추로 간다", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => errorResponse(503, "SERVICE_UNAVAILABLE", 2));
    await renderAndSubmit();
    fireEvent.click(screen.getByRole("button", { name: "자동 재시도 멈추기" }));
    await advance(10);
    expect(screen.queryByRole("button", { name: "자동 재시도 멈추기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toHaveFocus();
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    await advance(10);
    expect(screen.getByRole("button", { name: "자동 재시도 멈추기" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password2" } });
    await advance(5_000);
    expect(screen.queryByRole("button", { name: "자동 재시도 멈추기" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("같은 주소 1분 한도(429 RATE_LIMITED)도 기다렸다가 다시 시도하지만, 계정 잠금은 다시 보내지 않는다", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(errorResponse(429, "RATE_LIMITED", 30))
      .mockResolvedValueOnce(errorResponse(429, "ACCOUNT_LOCKED", 30));
    await renderAndSubmit();
    expect(screen.getByRole("button", { name: "30초 뒤 자동으로 다시 시도" })).toBeDisabled();
    await advance(30_010);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog", { name: "로그인할 수 없어요" })).toHaveTextContent(
      "로그인 시도가 잠시 제한됐어요.",
    );
    expect(screen.queryByRole("button", { name: "자동 재시도 멈추기" })).not.toBeInTheDocument();
    await advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
