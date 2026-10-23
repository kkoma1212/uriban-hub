import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../../api/auth";
import { ApiRequestError, type BootstrapResponse } from "../../api/auth";
import * as socialAuth from "../../api/social-auth";
import { SocialConnectionsPage } from "./social-connections-page";

vi.mock("../layout/system-state-banner", () => ({ SystemStateBanner: () => null }));
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  getBootstrap: vi.fn(),
}));
vi.mock("../../api/social-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/social-auth")>()),
  getSocialConnections: vi.fn(),
  linkSocialAccount: vi.fn(),
  unlinkSocialAccount: vi.fn(),
}));

const studentBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["LOGOUT", "VIEW_CLASS"],
  current_class: { id: "1", name: "1반", status: "active" },
  current_membership: { class_id: "1", id: "2", role: "student", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-10-21",
  teacher_profile: null,
} as unknown as BootstrapResponse;

function renderPage(): void {
  vi.mocked(socialAuth.getSocialConnections).mockResolvedValue({
    enabled: true,
    providers: ["google"],
    connections: ["google"],
    password_required: false,
  });
  render(
    <MemoryRouter initialEntries={["/account/social"]}>
      <Routes>
        <Route element={<SocialConnectionsPage />} path="/account/social" />
        <Route element={<p>로그인 도착</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

// T-SHELL-REMOUNT(2026-10-21): 역할이 정해질 때 AppShell이 본문을 다시 만들어, 그 전에 누른 해제 거절 안내가
// 지워졌다(화면 로그인 통합 시험 4벌 동시 16회 중 2회). 패널은 역할 확인이 끝난 뒤에만 나타나야 한다.
describe("social connections page", () => {
  it("shows the panel only after the role is known, so an early unlink message is not erased", async () => {
    let finishBootstrap: (value: BootstrapResponse) => void = () => undefined;
    vi.mocked(auth.getBootstrap).mockReturnValue(
      new Promise((resolve) => {
        finishBootstrap = resolve;
      }),
    );
    vi.mocked(socialAuth.unlinkSocialAccount).mockRejectedValue(
      new ApiRequestError("SOCIAL_LAST_LOGIN_METHOD", "last login method", 403),
    );
    renderPage();
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "구글 연결 해제" })).not.toBeInTheDocument();
    expect(socialAuth.getSocialConnections).not.toHaveBeenCalled();

    await act(async () => finishBootstrap(studentBootstrap));
    fireEvent.click(await screen.findByRole("button", { name: "구글 연결 해제" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("마지막 로그인 방법");
    expect(socialAuth.getSocialConnections).toHaveBeenCalledOnce();
  });

  it("still shows the panel when the role lookup fails for a reason other than sign-out", async () => {
    vi.mocked(auth.getBootstrap).mockRejectedValue(new ApiRequestError("UNAVAILABLE", "x", 503));
    renderPage();
    expect(await screen.findByRole("button", { name: "구글 연결 해제" })).toBeVisible();
  });

  it("sends a signed-out visitor to the login page without loading the panel", async () => {
    vi.mocked(auth.getBootstrap).mockRejectedValue(
      new ApiRequestError("UNAUTHENTICATED", "x", 401),
    );
    renderPage();
    expect(await screen.findByText("로그인 도착")).toBeVisible();
    expect(socialAuth.getSocialConnections).not.toHaveBeenCalled();
  });
});
