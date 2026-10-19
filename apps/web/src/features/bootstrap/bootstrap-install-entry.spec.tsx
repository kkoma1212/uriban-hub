import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapPage } from "./bootstrap-page";

describe("installed app bootstrap entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a failed account-state lookup without reloading the page", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      // 반 없음 화면의 '지난 반 기록' 입구 조회는 계정 상태 조회 횟수에서 뺀다(S1).
      if (String(input instanceof Request ? input.url : input).includes("/past-classes")) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "BOOTSTRAP_FAILED", message: "synthetic" },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            account: { display_name: "테스트 학생", email_verified: true, is_active: true },
            allowed_actions: ["CHANGE_PASSWORD", "DELETE_ACCOUNT", "LOGOUT"],
            current_class: null,
            current_membership: null,
            destination: "ENTER_INVITE_CODE",
            last_membership_status: null,
            last_status_reason: null,
            server_today: "2026-07-28",
            teacher_profile: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
        </Routes>
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = screen.getByRole("button", { name: "다시 시도" });
    expect(alert).toContainElement(retryButton);
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(
      await screen.findByRole("heading", { level: 1, name: "반에 참여해 주세요" }),
    ).toBeVisible();
    expect(requestCount).toBe(2);
  });

  it("redirects an unauthenticated installed-app launch to login", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
          <Route element={<p>로그인 화면 도착</p>} path="/login" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("로그인 화면 도착")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/bootstrap", {
      cache: "no-store",
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });
});
