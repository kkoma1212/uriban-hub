import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeAdminPassword, getAdminSession, renewAdminSession } from "../../api/admin-auth";
import { ApiRequestError } from "../../api/auth";
import { AdminAccountPage } from "./admin-account-page";

const hardReplace = vi.hoisted(() => vi.fn());
vi.mock("../../lib/admin-session-privacy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/admin-session-privacy")>();
  return {
    ...actual,
    installAdminSessionPrivacy: (
      options: Parameters<typeof actual.installAdminSessionPrivacy>[0],
    ) => actual.installAdminSessionPrivacy({ ...options, replace: hardReplace }),
  };
});

vi.mock("../../api/admin-auth", () => ({
  ADMIN_SESSION_EXPIRED_EVENT: "classhub:admin-session-expired",
  changeAdminPassword: vi.fn(),
  getAdminSession: vi.fn(),
  logoutAdmin: vi.fn(),
  renewAdminSession: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:05:00Z"));
  vi.mocked(getAdminSession).mockResolvedValue({
    server_now: "2026-09-07T12:05:00Z",
    account: {
      id: "1",
      email: "admin@example.invalid",
      display_name: "관리자",
      roles: ["super_admin"],
    },
    session: {
      issued_at: "2026-09-07T12:00:00Z",
      last_seen_at: "2026-09-07T12:00:00Z",
      mfa_verified_at: "2026-09-07T12:00:00Z",
      reauthenticated_at: "2026-09-07T12:00:00Z",
      absolute_expires_at: "2026-09-07T12:30:00Z",
    },
  });
  vi.mocked(changeAdminPassword).mockResolvedValue(undefined);
});
afterEach(() => {
  document.body.removeAttribute("style");
  document.body.removeAttribute("inert");
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fill(password: string, confirmation = password) {
  render(
    <MemoryRouter>
      <AdminAccountPage />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText("새 비밀번호"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: confirmation } });
  const submit = screen.getByRole("button", { name: "비밀번호 변경" });
  expect(submit).toBeEnabled();
  await act(async () => {
    fireEvent.click(submit);
  });
}
describe("Admin password change feedback", () => {
  it("explains the minimum length instead of silently disabling submission", async () => {
    await fill("short");
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "12자 이상 입력해 주세요. 현재 5자입니다.",
    );
    expect(changeAdminPassword).not.toHaveBeenCalled();
  });
  it("explains mismatched confirmation before calling the API", async () => {
    await fill("Cedar#72Maple", "Maple#72Cedar");
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "확인 입력이 일치하지 않습니다.",
    );
    expect(changeAdminPassword).not.toHaveBeenCalled();
  });
  it("submits matching valid input and clears both password fields", async () => {
    await fill("Cedar#72Maple");
    expect(
      await screen.findByText("비밀번호를 변경하고 다른 관리자 세션을 종료했습니다."),
    ).toBeVisible();
    expect(changeAdminPassword).toHaveBeenCalledExactlyOnceWith("Cedar#72Maple");
    expect(screen.getByLabelText("새 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 비밀번호 확인")).toHaveValue("");
  });
});

describe("Thirty-minute administrator session", () => {
  it("offers session renewal without prompting for credentials until a sensitive change", async () => {
    render(
      <MemoryRouter>
        <AdminAccountPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("관리자 로그인 완료")).toBeVisible();
    expect(screen.getByText("로그인·2단계 인증 완료")).toBeVisible();
    expect(screen.getByRole("button", { name: "30분 연장" })).toBeEnabled();
    expect(screen.queryByLabelText("새 6자리 인증번호")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
  });
  it("renews from server time and keeps the already verified session", async () => {
    const current = await getAdminSession();
    vi.mocked(renewAdminSession).mockResolvedValue({
      ...current,
      server_now: "2026-09-07T12:05:00Z",
      session: { ...current.session, absolute_expires_at: "2026-09-07T12:35:00Z" },
    });
    render(
      <MemoryRouter>
        <AdminAccountPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: "30분 연장" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(renewAdminSession).toHaveBeenCalledExactlyOnceWith();
    expect(await screen.findByText("남은 시간 30분 0초")).toBeVisible();
    expect(screen.queryByLabelText("새 6자리 인증번호")).not.toBeInTheDocument();
  });
  it("moves every protected admin shell to admin login when server confirms expiration", async () => {
    vi.useFakeTimers();
    const current = await getAdminSession();
    vi.mocked(getAdminSession)
      .mockResolvedValueOnce({ ...current, server_now: "2026-09-07T12:29:59Z" })
      .mockRejectedValue(new ApiRequestError("ADMIN_SESSION_REQUIRED", "Expired", 401));
    await act(async () => {
      render(
        <MemoryRouter initialEntries={["/admin/account"]}>
          <Routes>
            <Route path="/admin/account" element={<AdminAccountPage />} />
            <Route path="/admin/login" element={<p>관리자 로그인 화면</p>} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hardReplace).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
    expect(renewAdminSession).not.toHaveBeenCalled();
  });
  it("clears a positive countdown immediately when another admin request confirms session loss", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/account"]}>
        <Routes>
          <Route path="/admin/account" element={<AdminAccountPage />} />
          <Route path="/admin/login" element={<p>관리자 로그인 화면</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("로그인·2단계 인증 완료")).toBeVisible();
    act(() => {
      window.dispatchEvent(new Event("classhub:admin-session-expired"));
    });
    expect(hardReplace).toHaveBeenCalledOnce();
    expect(document.body).not.toBeVisible();
    expect(screen.queryByLabelText("관리자 로그인 유효 시간")).not.toBeInTheDocument();
  });
});

describe("모바일 세션 상태의 안정·주의 안내", () => {
  it("만료 5분 이내에는 원래 설명과 명시적 주의 안내를 제공한다", async () => {
    const current = await getAdminSession();
    vi.mocked(getAdminSession).mockResolvedValueOnce({
      ...current,
      server_now: "2026-09-07T12:26:00Z",
    });
    render(
      <MemoryRouter>
        <AdminAccountPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("만료가 가까워요. 작업을 계속하려면 시간을 연장해 주세요."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "30분 연장" })).toBeEnabled();
    expect(screen.getByText(/만료 전에 누르면 추가 인증 없이/)).toBeInTheDocument();
  });
  it("안정 상태의 연장 실패는 설명과 오류를 유지하고 초안·초점·명시적 재시도를 보존한다", async () => {
    vi.mocked(renewAdminSession).mockRejectedValueOnce(new Error("합성 연결 오류"));
    render(
      <MemoryRouter>
        <AdminAccountPage />
      </MemoryRouter>,
    );
    const password = await screen.findByLabelText("새 비밀번호");
    fireEvent.change(password, { target: { value: "Synthetic-Draft-Only" } });
    const button = screen.getByRole("button", { name: "30분 연장" });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(
      await screen.findByText(
        "로그인 시간을 연장하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.",
      ),
    ).toBeVisible();
    expect(password).toHaveValue("Synthetic-Draft-Only");
    expect(button).toHaveFocus();
    expect(button).toBeEnabled();
    expect(renewAdminSession).toHaveBeenCalledOnce();
    expect(screen.getByText(/만료 전에 누르면 추가 인증 없이/)).toBeInTheDocument();
  });
});
