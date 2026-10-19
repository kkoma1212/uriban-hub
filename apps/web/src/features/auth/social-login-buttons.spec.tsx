import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SocialLoginButtons } from "./social-login-buttons";
const api = vi.hoisted(() => ({ providers: vi.fn(), begin: vi.fn() }));
vi.mock("../../api/social-auth", () => ({
  getSocialProviders: api.providers,
  beginSocialLogin: api.begin,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("social provider identity and activation", () => {
  it("shows complete short names, preserves full accessible labels and native focus order", async () => {
    api.providers.mockResolvedValue(["google", "naver", "kakao"]);
    api.begin.mockRejectedValue(new Error("no remote navigation"));
    render(<SocialLoginButtons />);
    const google = await screen.findByRole("button", {
      name: "Google 계정으로 로그인",
    });
    const naver = screen.getByRole("button", { name: "네이버 로그인" });
    const kakao = screen.getByRole("button", { name: "카카오 로그인" });
    expect([google.textContent, naver.textContent, kakao.textContent]).toEqual([
      "Google",
      "네이버",
      "카카오",
    ]);
    for (const button of [google, naver, kakao]) {
      expect(button).toHaveAttribute("type", "button");
      expect(button).not.toHaveAttribute("tabindex", "-1");
      button.focus();
      expect(button).toHaveFocus();
    }
    fireEvent.click(google);
    expect(await screen.findByRole("alert")).toHaveTextContent("빠른 로그인을 시작하지 못했어요");
    expect(api.begin).toHaveBeenCalledExactlyOnceWith("google", "login");
    expect(google).toBeEnabled();
  });
  it("keeps the complete single-provider wording and prevents duplicate activation while pending", async () => {
    api.providers.mockResolvedValue(["google"]);
    let reject!: (error: Error) => void;
    api.begin.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(<SocialLoginButtons />);
    const button = await screen.findByRole("button", {
      name: "Google 계정으로 로그인",
    });
    expect(button.textContent).toBe("Google 계정으로 로그인");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.begin).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    await act(async () => {
      reject(new Error("failed"));
    });
    expect(button).toBeEnabled();
  });
});
