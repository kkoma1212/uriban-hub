import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// Provider discovery/buttons have their own integration spec; these cases isolate password/MFA requests.
vi.mock("./social-login-buttons", () => ({ SocialLoginButtons: () => null }));

import { LoginPage } from "./login-page";

describe("LoginPage interaction states", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["preview", "production"])(
    "never sends administrator credentials from the user login in %s",
    async (mode) => {
      // 관리자 로그인은 관리자 화면 묶음(/admin/login)에만 있다(T-ADMIN-SPLIT, 2026-10-07).
      vi.stubEnv("MODE", mode);
      const fetch = vi.spyOn(globalThis, "fetch");
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText("이메일"), { target: { value: " ADMIN " } });
      fireEvent.change(screen.getByLabelText("비밀번호"), {
        target: { value: "synthetic-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "로그인" }));
      expect(await screen.findByText("이메일 형식을 확인해 주세요.")).toBeVisible();
      expect(screen.queryByLabelText("6자리 인증번호")).not.toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("shows a neutral receipt and ignores legacy delivery hints", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/login",
            state: {
              signupRequested: true,
              signupEmail: "student@example.invalid",
              signupDeliveryStatus: "failed",
            },
          },
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "가입 요청을 접수했어요. 로그인해 다음 단계를 확인해 주세요.",
    );
    expect(screen.getByLabelText("이메일")).toHaveValue("student@example.invalid");
    expect(screen.getByRole("link", { name: "아이디 찾기" })).toHaveAttribute(
      "href",
      "/forgot-account",
    );
  });

  it("prefills the account just registered and leaves its password empty", () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/login",
            state: {
              signupRequested: true,
              signupEmail: "new-student@example.com",
            },
          },
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("이메일")).toHaveValue("new-student@example.com");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("비밀번호")).toHaveFocus();
  });

  it("accepts a signup-valid Unicode password without changing its original text", async () => {
    const password = "🌿".repeat(40) + "-synthetic";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ next_action: "BOOTSTRAP" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "student@example.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/login"),
      expect.objectContaining({
        body: JSON.stringify({ email: "student@example.com", password }),
      }),
    );
  });

  it("connects invalid fields to accessible error messages", async () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("학생과 선생님이 함께 쓰는 우리 반 공간이에요.")).toBeVisible();
    expect(screen.queryByText("학생은 내 할 일, 교사는 반 관리부터.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    const email = screen.getByLabelText("이메일");
    const password = screen.getByLabelText("비밀번호");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(email).toHaveAttribute("autocomplete", "username");
    await waitFor(() => {
      expect(email).toHaveAttribute("aria-invalid", "true");
      expect(password).toHaveAttribute("aria-invalid", "true");
    });

    expect(email).toHaveAttribute("aria-describedby", "login-email-error");
    expect(password).toHaveAttribute("aria-describedby", "login-password-error");
    expect(screen.getByText("이메일 형식을 확인해 주세요.")).toHaveAttribute("role", "alert");
    expect(screen.getByText("비밀번호를 입력해 주세요.")).toHaveAttribute("role", "alert");
  });

  it("exposes a busy submit state and a full-size password visibility control", async () => {
    let resolveLogin: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveLogin = resolve;
        }),
    );

    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("이메일"), {
      target: { value: "student@example.com" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "password1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    const busyButton = await screen.findByRole("button", { name: "로그인 중" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "비밀번호 보기" })).toHaveClass("ui-icon-button");

    await act(async () => {
      resolveLogin?.(
        new Response(JSON.stringify({ next_action: "BOOTSTRAP" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "로그인" })).toHaveAttribute("aria-busy", "false");
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("shows a unified, focus-contained login failure dialog without revealing the account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "INVALID_CREDENTIALS", message: "server detail is not shown" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("이메일"), {
      target: { value: "student@example.com" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    const dialog = await screen.findByRole("alertdialog", { name: "로그인할 수 없어요" });
    expect(dialog).toHaveTextContent("이메일 또는 비밀번호를 확인해 주세요.");
    expect(dialog).not.toHaveTextContent("server detail is not shown");
    const close = within(dialog).getByRole("button", { name: "확인" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "로그인" })).toHaveFocus();
  });

  it("announces that a changed password requires a fresh login", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { passwordChanged: true } }]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "비밀번호가 변경됐어요. 새 비밀번호로 다시 로그인해 주세요.",
    );
  });

  it("describes only acceptance and gives an existing-account recovery path", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { signupRequested: true } }]}>
        <LoginPage />
      </MemoryRouter>,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("가입 요청을 접수했어요. 로그인해 다음 단계를 확인해 주세요.");
    expect(status).not.toHaveTextContent("계정이 만들어졌어요");
    expect(status).toHaveTextContent("기존 비밀번호로 로그인");
    expect(status).not.toHaveTextContent("인증 메일");
    expect(status).not.toHaveTextContent("인증 링크");
  });

  it("announces completed account deletion without retaining an authenticated screen", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { accountDeleted: true } }]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "계정 삭제가 완료됐어요. 다시 이용하려면 새 계정을 만들어 주세요.",
    );
  });

  it("offers password recovery now that the reset flow is exposed", () => {
    // 2026-08-04 owner 결정: 라우트·진입점만 공개하고 서버 활성화는 별도 결정.
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const recovery = screen.getByRole("link", { name: "비밀번호를 잊으셨나요?" });
    expect(recovery).toHaveAttribute("href", "/forgot-password");
    expect(recovery).toHaveClass("min-h-11");
  });

  it("offers a full-height teacher and student signup link", () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const signUp = screen.getByRole("link", { name: "선생님·학생 가입" });
    expect(signUp).toHaveAttribute("href", "/sign-up");
    expect(signUp).toHaveClass("min-h-11");
    expect(signUp.closest("p")).toHaveClass("mt-5", "sm:mt-7");
    const form = screen.getByRole("button", { name: "로그인" }).closest("form");
    expect(form).toHaveClass("space-y-4");
    // 2026-09-27 확정 시안: 입력칸 · 로그인 버튼은 54px.
    expect(screen.getByRole("button", { name: "로그인" })).toHaveClass("h-[3.375rem]");
  });

  it("uses the compact mobile login header and top-aligned shell without changing shared auth pages", () => {
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const compactHeader = document.querySelector<HTMLElement>(
      '[data-login-mobile-header="compact"]',
    );
    expect(compactHeader).not.toBeNull();
    expect(document.querySelector('[data-auth-mobile-alignment="top"]')).not.toBeNull();
    if (compactHeader === null) throw new Error("모바일 로그인 헤더를 찾지 못했습니다.");
    expect(within(compactHeader).getByRole("link", { name: "우리반 허브" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.queryByText("학생 · 확인과 준비")).not.toBeInTheDocument();
    expect(screen.queryByText("교사 · 집계와 관리")).not.toBeInTheDocument();
  });
});
