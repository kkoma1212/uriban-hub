import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../../api/auth";
import * as socialAuth from "../../api/social-auth";
import { SocialConnectionsPanel } from "./social-connections-panel";

vi.mock("../../api/social-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/social-auth")>()),
  getSocialConnections: vi.fn(),
  linkSocialAccount: vi.fn(),
  unlinkSocialAccount: vi.fn(),
}));

const assign = vi.fn();

function renderPanel(passwordRequired: boolean) {
  vi.mocked(socialAuth.getSocialConnections).mockResolvedValue({
    enabled: true,
    providers: ["kakao"],
    connections: [],
    password_required: passwordRequired,
  });
  return render(
    <MemoryRouter>
      <SocialConnectionsPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, assign });
  vi.mocked(socialAuth.linkSocialAccount).mockResolvedValue("https://kauth.kakao.com/authorize");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// 2026-10-02 사용자 결정(총검수 I1-03): 비밀번호가 있는 계정은 연결 전에 현재 비밀번호를 다시 묻는다.
describe("SocialConnectionsPanel link confirmation", () => {
  it("asks for the current password before starting the provider link", async () => {
    renderPanel(true);
    fireEvent.click(await screen.findByRole("button", { name: "카카오 연결" }));
    expect(socialAuth.linkSocialAccount).not.toHaveBeenCalled();
    const field = screen.getByLabelText("본인 확인을 위해 현재 비밀번호를 입력해 주세요");
    const submit = screen.getByRole("button", { name: "확인하고 카카오 연결" });
    expect(submit).toBeDisabled();
    fireEvent.change(field, { target: { value: "Maple#72" } });
    fireEvent.click(submit);
    await vi.waitFor(() =>
      expect(socialAuth.linkSocialAccount).toHaveBeenCalledWith("kakao", "Maple#72"),
    );
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://kauth.kakao.com/authorize"),
    );
  });

  it("explains a wrong current password without leaving the page", async () => {
    vi.mocked(socialAuth.linkSocialAccount).mockRejectedValue(
      new ApiRequestError("INVALID_CREDENTIALS", "현재 비밀번호가 올바르지 않습니다.", 401),
    );
    renderPanel(true);
    fireEvent.click(await screen.findByRole("button", { name: "카카오 연결" }));
    fireEvent.change(screen.getByLabelText("본인 확인을 위해 현재 비밀번호를 입력해 주세요"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "확인하고 카카오 연결" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("현재 비밀번호가 맞지 않아요.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("links a social-only account without a password prompt", async () => {
    renderPanel(false);
    fireEvent.click(await screen.findByRole("button", { name: "카카오 연결" }));
    await vi.waitFor(() =>
      expect(socialAuth.linkSocialAccount).toHaveBeenCalledWith("kakao", undefined),
    );
    expect(
      screen.queryByLabelText("본인 확인을 위해 현재 비밀번호를 입력해 주세요"),
    ).not.toBeInTheDocument();
  });
});
