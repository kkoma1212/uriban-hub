import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminLoginPage } from "./admin-login-page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/admin/login"]}>
      <Routes>
        <Route element={<AdminLoginPage />} path="/admin/login" />
        <Route element={<p>운영 콘솔 도착</p>} path="/admin" />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminLoginPage", () => {
  it("preserves initial focus and follows authentication method changes", () => {
    render(
      <MemoryRouter>
        <AdminLoginPage
          initialChallenge={{
            next_step: "verify_totp",
            challenge_expires_at: "2026-09-07T12:05:00.000Z",
            methods: ["passkey", "totp", "recovery"],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "패스키로 인증" })).not.toHaveFocus();
    const method = screen.getByLabelText("2차 인증 방법");
    method.focus();
    fireEvent.change(method, { target: { value: "totp" } });
    expect(screen.getByLabelText("6자리 인증번호")).toHaveFocus();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "인증 앱의 6자리 인증번호",
    );
    fireEvent.change(screen.getByLabelText("6자리 인증번호"), { target: { value: "123456" } });
    fireEvent.change(method, { target: { value: "recovery" } });
    expect(screen.getByLabelText("1회용 복구 코드")).toHaveFocus();
    expect(screen.getByLabelText("1회용 복구 코드")).toHaveValue("");
    fireEvent.change(method, { target: { value: "passkey" } });
    expect(screen.getByRole("button", { name: "패스키로 인증" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "이메일 입력으로 돌아가기" }));
    expect(screen.getByLabelText("관리자 아이디 또는 이메일")).toHaveFocus();
  });

  it("keeps expired challenge focus inside the dialog and returns to the replacement form on Escape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { code: "ADMIN_CHALLENGE_INVALID", message: "Expired" } }, 401),
    );
    render(
      <MemoryRouter>
        <AdminLoginPage
          initialIdentifier="admin"
          initialChallenge={{
            next_step: "verify_totp",
            challenge_expires_at: "2026-09-07T12:05:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    const code = screen.getByLabelText("6자리 인증번호");
    code.focus();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(code.closest("form")!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("인증 시간이 끝났어요");
    expect(screen.getByRole("button", { name: "확인" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "확인" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.getByLabelText("관리자 아이디 또는 이메일")).toHaveFocus());
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("accepts the admin short ID while still requiring TOTP", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        challenge_expires_at: "2026-09-07T12:05:00.000Z",
        next_step: "verify_totp",
      }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: " ADMIN " },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "test-admin-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));
    expect(await screen.findByLabelText("6자리 인증번호")).toBeVisible();
    // 초점은 그린 뒤 도는 효과에서 옮겨져, 바쁠 때는 입력칸이 보인 다음 차례에 따라온다.
    await waitFor(() => expect(screen.getByLabelText("6자리 인증번호")).toHaveFocus());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "admin@classhub.local",
      password: "test-admin-password",
    });
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
    expect(screen.queryByText("운영 콘솔 도착")).not.toBeInTheDocument();
  });

  it("moves from credentials through TOTP enrollment without retaining the password", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          challenge_expires_at: "2026-09-03T00:05:00.000Z",
          next_step: "enroll_totp",
          setup: {
            manual_key: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
            otpauth_uri: "otpauth://totp/test?secret=GEZDGNBVGY3TQOJQ",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account: {
            display_name: "보안 관리자",
            email: "admin@example.com",
            id: "17",
            roles: ["security_auditor"],
          },
          session: {
            absolute_expires_at: "2026-09-03T08:00:00.000Z",
            issued_at: "2026-09-03T00:00:00.000Z",
            last_seen_at: "2026-09-03T00:00:00.000Z",
            mfa_verified_at: "2026-09-03T00:00:00.000Z",
            reauthenticated_at: null,
          },
        }),
      );
    renderPage();

    expect(screen.getByLabelText("비밀번호")).not.toHaveAttribute("maxlength");

    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: " ADMIN@Example.com " },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "one-time-initial-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));

    expect(await screen.findByText("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")).toBeVisible();
    expect(screen.getByRole("img", { name: "관리자 인증 앱 등록 QR 코드" })).toBeVisible();
    expect(screen.getByRole("button", { name: "설정 키 복사" })).toBeVisible();
    // 위와 같은 이유로 초점 이동은 기다려서 확인한다.
    await waitFor(() => expect(screen.getByRole("button", { name: "설정 키 복사" })).toHaveFocus());
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/auth/login");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: "admin@example.com",
      password: "one-time-initial-password",
    });

    fireEvent.change(screen.getByLabelText("6자리 인증번호"), {
      target: { value: "12a3456" },
    });
    expect(screen.getByLabelText("6자리 인증번호")).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: "인증 완료" }));

    expect(await screen.findByText("운영 콘솔 도착")).toBeVisible();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/admin/auth/totp");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      totp_code: "123456",
    });
  });

  it("explains the dormant feature safely when the API route is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { code: "NOT_FOUND", message: "Not found" } }, 404),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "관리자 로그인이 아직 활성화되지 않았어요. 다른 관리자에게 문의해 주세요.",
        ),
      ).toBeVisible(),
    );
  });
});

describe("administrator cooldown guidance", () => {
  it("preserves credential draft and blocks duplicate submissions for the server cooldown", async () => {
    window.history.replaceState({}, "", "/admin/login");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RATE_LIMITED",
            message: "제한",
            details: { retry_after_seconds: 1 },
          },
        },
        429,
      ),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: "owned@example.invalid" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("약 1초 뒤");
    expect(screen.getByLabelText("관리자 아이디 또는 이메일")).toHaveValue("owned@example.invalid");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("synthetic-password");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    const button = screen.getByRole("button", { name: "비밀번호 확인" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    expect(fetchMock).toHaveBeenCalledOnce();
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2000 });
    window.history.replaceState({}, "", "/");
  });
  it("keeps the authentication code after 429 and permits an explicit keyboard return to credentials", async () => {
    window.history.replaceState({}, "", "/admin/login");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RATE_LIMITED",
            message: "제한",
            details: { retry_after_seconds: 1 },
          },
        },
        429,
      ),
    );
    render(
      <MemoryRouter initialEntries={["/admin/login"]}>
        <AdminLoginPage
          initialIdentifier="owned@example.invalid"
          initialChallenge={{
            next_step: "verify_totp",
            challenge_expires_at: new Date(Date.now() + 60000).toISOString(),
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("6자리 인증번호"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "인증 완료" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "인증 시간이 끝났다면 이메일 입력으로 돌아가",
    );
    expect(screen.getByLabelText("6자리 인증번호")).toHaveValue("123456");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "이메일 입력으로 돌아가기" }));
    await waitFor(() => expect(screen.getByLabelText("관리자 아이디 또는 이메일")).toHaveFocus());
    expect(screen.getByLabelText("관리자 아이디 또는 이메일")).toHaveValue("owned@example.invalid");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    window.history.replaceState({}, "", "/");
  });
});

it("updates the open cooldown dialog until retry is available without submitting or per-second live announcements", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 600000);
  window.history.replaceState({}, "", "/admin/login");
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RATE_LIMITED",
            message: "제한",
            details: { retry_after_seconds: 3 },
          },
        },
        429,
      ),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: "owned@example.invalid" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "synthetic-password" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));
    });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("약 3초 뒤");
    expect(dialog.querySelector('[aria-live="off"]')).toHaveTextContent("약 3초 뒤");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(dialog).toHaveTextContent("약 2초 뒤");
    expect(dialog.querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(dialog).toHaveTextContent("대기가 끝났어요. 확인을 누른 뒤 다시 시도할 수 있어요.");
    expect(dialog).not.toHaveTextContent("약 3초");
    expect(dialog.querySelector('[role="status"]')).toHaveTextContent("대기가 끝났어요");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("비밀번호")).toHaveValue("synthetic-password");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("button", { name: "비밀번호 확인" })).toBeEnabled();
  } finally {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  }
});

it.each(["duration", "absolute", "shared-longer"])(
  "blocks closed-modal submission for account lock despite remaining headers (%s)",
  async (deadlineKind) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1200000);
    window.history.replaceState({}, "", "/admin/login");
    const expectedSeconds = deadlineKind === "shared-longer" ? 5 : 3;
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "ADMIN_ACCOUNT_LOCKED",
              message: "제한",
              details:
                deadlineKind !== "absolute"
                  ? { retry_after_seconds: 3 }
                  : { retry_at: new Date(Date.now() + 3000).toISOString() },
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": "10",
              "X-RateLimit-Cooldown": "60",
              "X-RateLimit-Remaining": deadlineKind === "shared-longer" ? "0" : "9",
              "X-RateLimit-Reset-After": deadlineKind === "shared-longer" ? "5" : "60",
            },
          },
        ),
      );
      renderPage();
      fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
        target: { value: "owned@example.invalid" },
      });
      fireEvent.change(screen.getByLabelText("비밀번호"), {
        target: { value: "synthetic-password" },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));
      });
      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveTextContent(`약 ${expectedSeconds}초 뒤`);
      expect(dialog.querySelector('[aria-live="off"]')).toHaveTextContent(
        `약 ${expectedSeconds}초 뒤`,
      );
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(dialog).toHaveTextContent(`약 ${expectedSeconds - 1}초 뒤`);
      expect(dialog.querySelector('[role="status"]')).toBeNull();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(screen.getByRole("button", { name: "비밀번호 확인" })).toBeDisabled();
      expect(document.querySelector("[data-admin-login-wait]")).toHaveTextContent(
        `약 ${expectedSeconds - 1}초 뒤`,
      );
      expect(document.querySelector("[data-admin-login-wait]")).toHaveAttribute("aria-live", "off");
      expect(document.body).not.toHaveTextContent("짧은 시간에");
      fireEvent.submit(screen.getByLabelText("비밀번호").closest("form")!);
      expect(fetchMock).toHaveBeenCalledOnce();
      await act(async () => {
        vi.advanceTimersByTime((expectedSeconds - 1) * 1000);
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("비밀번호")).toHaveValue("synthetic-password");
      expect(screen.getByRole("button", { name: "비밀번호 확인" })).toBeEnabled();
      expect(document.querySelector("[data-admin-login-wait]")).toBeNull();
    } finally {
      vi.useRealTimers();
      window.history.replaceState({}, "", "/");
    }
  },
);

it("does not claim cooldown completion without a validated server deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 1800000);
  window.history.replaceState({}, "", "/admin/login");
  try {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "ADMIN_ACCOUNT_LOCKED",
            message: "제한",
            details: { retry_after_seconds: "3", retry_at: "invalid" },
          },
        },
        429,
      ),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("관리자 아이디 또는 이메일"), {
      target: { value: "owned@example.invalid" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "synthetic-password" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "비밀번호 확인" }));
    });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("잠시 후 다시 시도해 주세요");
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(dialog).not.toHaveTextContent("대기가 끝났어요");
    expect(dialog).not.toHaveTextContent("약 3초");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("비밀번호")).toHaveValue("synthetic-password");
  } finally {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  }
});
