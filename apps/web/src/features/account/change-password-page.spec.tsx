import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChangePasswordPage } from "./change-password-page";

vi.mock("../layout/system-state-banner", () => ({ SystemStateBanner: () => null }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const temporaryTeacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"],
  current_class: null,
  current_membership: null,
  destination: "CHANGE_TEMPORARY_PASSWORD",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-15",
  teacher_profile: { status: "active", temporary_password_must_change: true },
};

const homeStudentBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS", "VIEW_CLASS"],
  current_class: { id: "1", name: "1반", status: "active" },
  current_membership: { class_id: "1", id: "2", role: "student", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-15",
  teacher_profile: null,
};

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/account/password"]}>
      <Routes>
        <Route element={<ChangePasswordPage />} path="/account/password" />
        <Route element={<p>로그인 도착</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChangePasswordPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes the forced teacher flow once and routes to a fresh login", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=change-password-token",
    );
    let resolveChange!: (response: Response) => void;
    const changeResponse = new Promise<Response>((resolve) => {
      resolveChange = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(temporaryTeacherBootstrap));
      }
      if (url === "/api/v1/account/password") {
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("change-password-token");
        expect(JSON.parse(String(init?.body))).toEqual({
          current_password: "temporary123",
          new_password: "Cedar#72",
        });
        return changeResponse;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "임시 비밀번호를 바꿔 주세요" }),
    ).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "주요 메뉴" })).not.toBeInTheDocument();
    expect(screen.getByText(/모든 기기에서 로그아웃됩니다/u)).toBeVisible();

    fireEvent.change(screen.getByLabelText("현재 비밀번호"), {
      target: { value: "temporary123" },
    });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), {
      target: { value: "Cedar#72" },
    });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), {
      target: { value: "Maple#72" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));
    expect(await screen.findByText("새 비밀번호가 서로 일치하지 않아요.")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), {
      target: { value: "Cedar#72" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    const busyButton = await screen.findByRole("button", { name: "변경하는 중" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    for (const label of ["현재 비밀번호", "새 비밀번호", "새 비밀번호 확인"]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("readonly");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveChange(jsonResponse({ next_action: "LOGIN", password_changed: true }));
    });
    expect(await screen.findByText("로그인 도착")).toBeVisible();
  });

  it("keeps normal student navigation and associates a bad current password with its field", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=student-password-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(homeStudentBootstrap));
      }
      if (url === "/api/v1/account/password") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "INVALID_CREDENTIALS",
                message: "현재 비밀번호가 올바르지 않습니다.",
              },
            },
            401,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    expect(screen.getByRole("heading", { level: 1, name: "비밀번호 변경" })).toBeVisible();
    const accountLink = screen.getByRole("link", { name: /내 계정학생/u });
    expect(accountLink).toHaveAttribute("aria-current", "page");
    expect(accountLink).toHaveAttribute("href", "/settings");
    fireEvent.change(screen.getByLabelText("현재 비밀번호"), {
      target: { value: "wrongPassword123" },
    });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), {
      target: { value: "Cedar#72" },
    });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), {
      target: { value: "Cedar#72" },
    });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    const currentPassword = screen.getByLabelText("현재 비밀번호");
    await waitFor(() => expect(currentPassword).toHaveAttribute("aria-invalid", "true"));
    expect(currentPassword).toHaveAttribute("aria-describedby", "current-password-error");
    expect(currentPassword).toHaveFocus();
    for (const label of ["현재 비밀번호", "새 비밀번호", "새 비밀번호 확인"]) {
      expect(screen.getByLabelText(label)).not.toHaveAttribute("readonly");
    }
    expect(screen.getByText("현재 비밀번호가 올바르지 않아요.")).toHaveAttribute("role", "alert");
  });
});
