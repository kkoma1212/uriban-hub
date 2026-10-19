import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import { StudentSettingsPage } from "./student-settings-page";

const bootstrapFixture = {
  account: { display_name: "김학생", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
  current_class: {
    id: "1",
    name: "테스트 1반",
    school_address: null,
    school_homepage_url: null,
    school_name: "테스트 고등학교",
    school_phone_number: null,
    status: "active",
  },
  current_membership: {
    class_id: "1",
    display_name_in_class: "김학생",
    id: "2",
    role: "student",
    status: "approved",
    student_number: 7,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-08-01",
  teacher_profile: null,
} satisfies BootstrapResponse;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function LoginRouteProbe(): React.JSX.Element {
  const navigationType = useNavigationType();
  return (
    <>
      <p>로그인 화면</p>
      <output aria-label="로그인 이동 방식">{navigationType}</output>
    </>
  );
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <Routes>
        <Route element={<StudentSettingsPage />} path="/settings" />
        <Route element={<LoginRouteProbe />} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("StudentSettingsPage mobile logout", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows a student the homeroom teacher and year/grade, without the student count (A1-05)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
      if (url === "/api/v1/classes/current")
        return jsonResponse({
          academic_year: 2026,
          active_student_count: 27,
          grade: 3,
          id: "1",
          name: "3반",
          role: "student",
          row_version: "1",
          school_address: null,
          school_homepage_url: null,
          school_name: "시험중학교",
          school_phone_number: null,
          status: "active",
          teacher_display_name: "김담임",
        });
      return jsonResponse({}, 404);
    });
    renderPage();
    expect(await screen.findByText("김담임")).toBeVisible();
    expect(screen.getByText("2026학년도 · 3학년")).toBeVisible();
    expect(screen.queryByText(/27명/u)).not.toBeInTheDocument();
  });

  it("opens the same settings for teachers without student-only class actions", async () => {
    const teacher = {
      ...bootstrapFixture,
      account: { ...bootstrapFixture.account, display_name: "김선생" },
      allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"],
      current_membership: {
        ...bootstrapFixture.current_membership,
        role: "teacher",
        student_number: null,
      },
    } satisfies BootstrapResponse;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (requestUrl(input) === "/api/v1/bootstrap") return jsonResponse(teacher);
      throw new Error(`Unexpected URL: ${requestUrl(input)}`);
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "설정" })).toBeVisible();
    expect(screen.getByRole("link", { name: "내 이름 변경" })).toHaveAttribute(
      "href",
      "/account/profile",
    );
    expect(screen.getByRole("heading", { name: "화면" })).toBeVisible();
    expect(screen.getByRole("link", { name: /비밀번호 변경/u })).toHaveAttribute(
      "href",
      "/account/password",
    );
    expect(screen.queryByRole("button", { name: "현재 반 나가기" })).not.toBeInTheDocument();
    expect(screen.queryByText("학생 번호")).not.toBeInTheDocument();
    expect(document.querySelector('main[data-app-role="teacher"]')).not.toBeNull();
    // 교사가 받을 알림이 없으니 '알림 받기' 칸을 보이지 않는다(총검수 B1-02).
    expect(document.querySelector('[data-settings-section="push-notifications"]')).toBeNull();
    // 교사는 시안 순서 그대로: 화면 다음에 계정(학생만 계정이 맨 위, 2026-10-03).
    const appearance = document.querySelector('[data-settings-section="appearance"]');
    const account = document.querySelector('[data-settings-section="security"]');
    expect(appearance?.compareDocumentPosition(account!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows the profile photo control only with USE_PROFILE_PHOTOS and never asks otherwise", async () => {
    const requested: string[] = [];
    const withPhotos = {
      ...bootstrapFixture,
      allowed_actions: [...bootstrapFixture.allowed_actions, "USE_PROFILE_PHOTOS"],
    } satisfies BootstrapResponse;
    let current: BootstrapResponse = bootstrapFixture;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url === "/api/v1/bootstrap") return jsonResponse(current);
      if (url === "/api/v1/account/profile-photo")
        return jsonResponse({
          enabled: true,
          photo: null,
          limits: {
            upload_bytes: 524288,
            stored_bytes: 64000,
            source_pixels: 16000000,
            formats: ["image/jpeg", "image/png", "image/webp"],
          },
        });
      throw new Error(`Unexpected URL: ${url}`);
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "설정" })).toBeVisible();
    expect(screen.queryByText("프로필 사진")).not.toBeInTheDocument();
    expect(requested).not.toContain("/api/v1/account/profile-photo");

    cleanup();
    window.sessionStorage.clear();
    current = withPhotos;
    renderPage();
    expect(await screen.findByRole("button", { name: "사진 고르기" })).toBeVisible();
    expect(
      screen.getByText("저장한 사진은 같은 반의 승인된 구성원과 선생님에게 보여요."),
    ).toBeVisible();
    expect(requested).toContain("/api/v1/account/profile-photo");
  });

  it("ends the current session from the explicit account action and replaces the route", async () => {
    let finishLogout: ((response: Response) => void) | undefined;
    const logoutResponse = new Promise<Response>((resolve) => {
      finishLogout = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/auth/logout") {
        expect(init).toEqual({
          body: "{}",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: expect.any(AbortSignal),
        });
        return logoutResponse;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    window.sessionStorage.setItem(
      "classhub:idempotent-create:notices:student-membership",
      "private draft",
    );

    renderPage();

    // 2026-09-27 확정 시안: 로그아웃은 '계정' 줄 목록(비밀번호 변경 아래), 공용 기기 안내는 줄 설명.
    const account = (await screen.findByRole("heading", { name: "계정" })).closest<HTMLElement>(
      '[data-settings-section="security"]',
    );
    if (account === null || account === undefined) {
      throw new Error("학생 계정 묶음을 찾지 못했습니다.");
    }
    const logoutButton = within(account).getByRole("button", { name: "로그아웃" });
    expect(logoutButton).toHaveClass("min-h-14");
    expect(within(account).getByText(/공용 기기에서는/u)).toBeVisible();
    const profile = document.querySelector<HTMLElement>('[data-settings-section="profile"]');
    const appearance = document.querySelector<HTMLElement>('[data-settings-section="appearance"]');
    if (profile === null || appearance === null) {
      throw new Error("학생 설정 순서를 확인하지 못했습니다.");
    }
    // 2026-10-03 사용자 결정: 학생은 계정 묶음(비밀번호·로그아웃)이 맨 위 — 휴대폰 첫 화면에서 바로 로그아웃.
    expect(account.compareDocumentPosition(profile)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(profile.compareDocumentPosition(appearance)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(logoutButton);
    expect(logoutButton).toBeDisabled();
    expect(logoutButton).toHaveAttribute("aria-busy", "true");
    expect(within(account).getByRole("button", { name: "로그아웃 중..." })).toBe(logoutButton);

    await act(async () => {
      finishLogout?.(jsonResponse({ logged_out: true }));
      await logoutResponse;
    });

    expect(await screen.findByText("로그인 화면")).toBeInTheDocument();
    expect(screen.getByLabelText("로그인 이동 방식")).toHaveTextContent("REPLACE");
    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:notices:student-membership"),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the settings session and private state when logout fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/auth/logout") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "SERVICE_UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." } },
            503,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    window.sessionStorage.setItem(
      "classhub:idempotent-create:supplies:student-membership",
      "private draft",
    );

    renderPage();
    const account = (await screen.findByRole("heading", { name: "계정" })).closest<HTMLElement>(
      '[data-settings-section="security"]',
    );
    if (account === null || account === undefined) {
      throw new Error("학생 계정 묶음을 찾지 못했습니다.");
    }
    const logoutButton = within(account).getByRole("button", { name: "로그아웃" });
    logoutButton.focus();
    expect(logoutButton).toHaveFocus();
    fireEvent.click(logoutButton);

    const alert = await screen.findByText("잠시 후 다시 시도해 주세요.");
    expect(alert).toHaveTextContent("잠시 후 다시 시도해 주세요.");
    expect(logoutButton).toBeEnabled();
    expect(logoutButton).toHaveFocus();
    expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:supplies:student-membership"),
    ).toBe("private draft");
  });

  it("keeps logout available when the settings bootstrap request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "BOOTSTRAP_UNAVAILABLE", message: "설정을 불러오지 못했습니다." } },
            503,
          ),
        );
      }
      if (url === "/api/v1/auth/logout") {
        expect(init).toEqual({
          body: "{}",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: expect.any(AbortSignal),
        });
        return Promise.resolve(jsonResponse({ logged_out: true }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "다시 시도" })).toBeVisible();
    const logoutButton = within(alert).getByRole("button", { name: "로그아웃" });
    expect(logoutButton).toHaveClass("min-h-11");
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(screen.getByText("로그인 화면")).toBeInTheDocument();
    });
  });

  it("keeps logout independent when the settings bootstrap request never settles", async () => {
    const pendingBootstrap = new Promise<Response>(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return pendingBootstrap;
      if (url === "/api/v1/auth/logout") {
        expect(init).toEqual({
          body: "{}",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: expect.any(AbortSignal),
        });
        return Promise.resolve(jsonResponse({ logged_out: true }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    window.sessionStorage.setItem(
      "classhub:idempotent-create:notices:pending-bootstrap",
      "private draft",
    );

    renderPage();

    expect(screen.getByRole("status")).toHaveAccessibleName("설정을 불러오고 있어요.");
    expect(screen.getByText(/설정을 기다리는 중에도/u)).toBeVisible();
    const logoutButton = screen.getByRole("button", { name: "로그아웃" });
    expect(logoutButton).toHaveClass("min-h-11");
    fireEvent.click(logoutButton);

    expect(await screen.findByText("로그인 화면")).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:notices:pending-bootstrap"),
    ).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });
  it("keeps a loading logout pending when teacher settings finish loading", async () => {
    let resolveBootstrap!: (response: Response) => void;
    let resolveLogout!: (response: Response) => void;
    const pendingBootstrap = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const pendingLogout = new Promise<Response>((resolve) => {
      resolveLogout = resolve;
    });
    let logoutRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return pendingBootstrap;
      if (url === "/api/v1/auth/logout") {
        logoutRequests += 1;
        return pendingLogout;
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(logoutRequests).toBe(1));
    await act(async () => {
      resolveBootstrap(
        jsonResponse({
          ...bootstrapFixture,
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT"],
          current_membership: {
            ...bootstrapFixture.current_membership,
            role: "teacher",
            student_number: null,
          },
        }),
      );
      await pendingBootstrap;
    });
    expect(await screen.findByRole("heading", { name: "설정" })).toBeVisible();
    const pendingButton = screen.getByRole("button", { name: "로그아웃 중..." });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    expect(logoutRequests).toBe(1);
    await act(async () => {
      resolveLogout(jsonResponse({ logged_out: true }));
      await pendingLogout;
    });
    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(screen.getByLabelText("로그인 이동 방식")).toHaveTextContent("REPLACE");
  });
});
