import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapPage } from "./bootstrap-page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const verifyEmailBootstrap = {
  account: { email_verified: false, is_active: true },
  allowed_actions: ["RESEND_EMAIL", "LOGOUT", "DELETE_ACCOUNT"],
  current_class: null,
  current_membership: null,
  destination: "VERIFY_EMAIL",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: null,
};

describe("BootstrapPage email verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("announces a delivery failure from a successful token request without retrying", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=bootstrap-resend-token",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/api/v1/public/system-state")
        return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
      if (input === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(verifyEmailBootstrap));
      if (input === "/api/v1/auth/email-verifications/resend")
        return Promise.resolve(jsonResponse({ verification_delivery_status: "failed" }));
      throw new Error("Unexpected synthetic endpoint");
    });
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole("button", { name: "이메일 확인 메일 다시 보내기" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("계정은 그대로 유지돼요.");
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/email-verifications/resend"),
    ).toHaveLength(1);
    expect(
      screen.queryByText("이메일 확인 메일을 다시 보냈어요", { exact: false }),
    ).not.toBeInTheDocument();
  });

  it("shows one resend action, blocks duplicate clicks, and announces success", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=bootstrap-resend-token",
    );
    let resolveResend!: (response: Response) => void;
    const resendResponse = new Promise<Response>((resolve) => {
      resolveResend = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/public/system-state")
        return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(verifyEmailBootstrap));
      }
      if (url === "/api/v1/auth/email-verifications/resend") {
        expect(init?.body).toBe("{}");
        expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("bootstrap-resend-token");
        return resendResponse;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    const resendButton = await screen.findByRole("button", {
      name: "이메일 확인 메일 다시 보내기",
    });
    fireEvent.click(resendButton);
    fireEvent.click(resendButton);

    expect(resendButton).toBeDisabled();
    expect(resendButton).toHaveAttribute("aria-busy", "true");
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/v1/auth/email-verifications/resend"),
    ).toHaveLength(1);

    resolveResend(jsonResponse({ verification_delivery_status: "sent" }));

    expect(
      await screen.findByRole("status", { name: "이메일 확인 메일 재발송 결과" }),
    ).toHaveTextContent("이메일 확인 메일을 다시 보냈어요");
    await waitFor(() => expect(resendButton).toBeEnabled());
    expect(resendButton).toHaveAttribute("aria-busy", "false");
  });

  it("keeps the action available and announces a resend API failure", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=bootstrap-resend-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/public/system-state")
        return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(verifyEmailBootstrap));
      }
      if (url === "/api/v1/auth/email-verifications/resend") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "RATE_LIMITED",
                message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
              },
            },
            429,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );

    const resendButton = await screen.findByRole("button", {
      name: "이메일 확인 메일 다시 보내기",
    });
    fireEvent.click(resendButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    );
    await waitFor(() => expect(resendButton).toBeEnabled());
  });
});
