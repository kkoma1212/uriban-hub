import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import { AccountProfilePage } from "./account-profile-page";

vi.mock("../layout/system-state-banner", () => ({ SystemStateBanner: () => null }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const studentBootstrap: BootstrapResponse = {
  account: { display_name: "계정 이름", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS", "VIEW_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    display_name_in_class: "반에서 쓰는 이름",
    id: "2",
    role: "student",
    student_number: 17,
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: null,
};

const teacherBootstrap: BootstrapResponse = {
  ...studentBootstrap,
  account: { display_name: "담임 선생님", email_verified: true, is_active: true },
  current_membership: {
    class_id: "1",
    display_name_in_class: null,
    id: "1",
    role: "teacher",
    student_number: null,
    status: "approved",
  },
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/account/profile"]}>
      <Routes>
        <Route element={<AccountProfilePage />} path="/account/profile" />
        <Route element={<p>계정 안내 도착</p>} path="/bootstrap" />
        <Route element={<p>로그인 도착</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AccountProfilePage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows both student name scopes, validates inline, and prevents duplicate profile writes", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=profile-token",
    );
    let resolveUpdate!: (response: Response) => void;
    const updateResponse = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/account/profile") {
        expect(init?.method).toBe("PATCH");
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("profile-token");
        expect(JSON.parse(String(init?.body))).toEqual({ display_name: "새 계정 이름" });
        return updateResponse;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    expect(await screen.findByText("계정 이름")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "내 이름" })).toBeVisible();
    expect(screen.getByText("반에서 쓰는 이름")).toBeVisible();
    expect(screen.getByText("17")).toBeVisible();
    expect(screen.getByText(/기본 이름을 바꿔도 반 화면의 이름은 바뀌지 않아요/u)).toBeVisible();

    const input = screen.getByLabelText("새 기본 이름");
    expect(input).not.toHaveAttribute("maxlength");
    fireEvent.change(input, { target: { value: "<b>학생</b>" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/HTML 요소를 사용할 수 없어요/u)).toHaveAttribute(
      "role",
      "alert",
    );
    fireEvent.click(screen.getByRole("button", { name: "기본 이름 변경" }));
    expect(input).toHaveFocus();
    expect(
      fetchMock.mock.calls.filter(([request]) => requestUrl(request) === "/api/v1/account/profile"),
    ).toHaveLength(0);

    fireEvent.change(input, { target: { value: "  새 계정 이름  " } });
    const form = screen.getByRole("button", { name: "기본 이름 변경" }).closest("form");
    if (form === null) throw new Error("Profile form is missing.");
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole("button", { name: "변경하는 중" })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([request]) => requestUrl(request) === "/api/v1/account/profile"),
    ).toHaveLength(1);

    await act(async () => {
      resolveUpdate(
        jsonResponse({
          display_name: "새 계정 이름",
          profile_updated: true,
          updated_at: "2026-07-18T10:00:00.000Z",
        }),
      );
    });
    expect(await screen.findByRole("status")).toHaveTextContent("기본 이름을 변경했어요.");
    expect(input).toBeEnabled();
    expect(screen.getAllByText("새 계정 이름").length).toBeGreaterThan(0);
    expect(screen.getByText("반에서 쓰는 이름")).toBeVisible();
  });

  it("announces an idempotent no-op and keeps teacher navigation context", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=profile-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/account/profile") {
        return Promise.resolve(
          jsonResponse({
            display_name: "담임 선생님",
            profile_updated: false,
            updated_at: "2026-07-18T10:00:00.000Z",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    await screen.findByLabelText("새 기본 이름");
    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("교사 내비게이션을 찾지 못했습니다.");
    }
    expect(within(desktopNavigation).getByRole("link", { name: "반 관리" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      within(screen.getByRole("navigation", { name: "선생님 계정" })).getByRole("link", {
        name: /내 계정/u,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(bottomNavigation).queryByRole("link", { name: "반 관리" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("학생 번호")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기본 이름 변경" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "이미 같은 기본 이름을 사용하고 있어요.",
    );
  });

  it.each([
    {
      account: { display_name: "미인증", email_verified: false, is_active: true },
      destination: "VERIFY_EMAIL",
      teacher_profile: null,
    },
    {
      account: { display_name: "임시 교사", email_verified: true, is_active: true },
      destination: "CHANGE_TEMPORARY_PASSWORD",
      teacher_profile: { status: "active" as const, temporary_password_must_change: true },
    },
    {
      account: { display_name: "권한 회수", email_verified: true, is_active: true },
      destination: "TEACHER_REVOKED",
      teacher_profile: { status: "revoked" as const, temporary_password_must_change: false },
    },
  ])("blocks profile entry for $destination policy", async (policy) => {
    const blocked: BootstrapResponse = {
      ...teacherBootstrap,
      account: policy.account,
      current_class: null,
      current_membership: null,
      destination: policy.destination as BootstrapResponse["destination"],
      teacher_profile: policy.teacher_profile,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(blocked));

    renderPage();

    expect(await screen.findByText("계정 안내 도착")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.some(([request]) => requestUrl(request) === "/api/v1/account/profile"),
    ).toBe(false);
  });

  it("shows loading, exposes a retry after a bootstrap failure, and recovers", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? jsonResponse(
              { error: { code: "INTERNAL_ERROR", message: "잠시 불러오지 못했어요." } },
              500,
            )
          : jsonResponse(studentBootstrap),
      );
    });

    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("이름을 확인하고 있어요.");
    expect(await screen.findByRole("alert")).toHaveTextContent("잠시 불러오지 못했어요.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("계정 이름")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "내 이름" })).toBeVisible();
  });
});
