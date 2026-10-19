import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { HomePage } from "./home-page";

const bootstrapPayload = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-13",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const homePayload = {
  attendance: {
    data: {
      absent: 0,
      acknowledged: 0,
      early: 0,
      late: 0,
      pending: 0,
      total: 0,
    },
    status: "empty",
  },
  meal: { data: null, status: "empty" },
  notices: { data: [], status: "empty" },
  pending_member_count: 0,
  reminders: { data: [], status: "empty" },
  schedules: { data: [], status: "empty" },
  server_today: "2026-07-13",
  supplies: { data: [], status: "empty" },
  teacher_followups: { data: [], status: "empty" },
} as unknown as HomeResponse;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HomePage refresh state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the existing cards visible while exposing the refresh as busy", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-13T03:00:00.000Z"));

    let homeRequestCount = 0;
    let resolveRefresh: ((response: Response) => void) | undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapPayload));
      if (url === "/api/v1/home") {
        homeRequestCount += 1;
        return homeRequestCount === 1 ? Promise.resolve(jsonResponse(homePayload)) : pendingRefresh;
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("오늘 등록된 급식이 없어요.")).toBeInTheDocument();
    expect(screen.getAllByText("우리반 허브")).toHaveLength(2);
    expect(document.querySelectorAll("[data-teacher-home-section]")).toHaveLength(1);
    const tasksCard = screen.getByRole("region", { name: "처리할 일" });
    expect(tasksCard).toBeVisible();
    expect(screen.queryByRole("region", { name: "오늘 출결 연락" })).not.toBeInTheDocument();
    expect(screen.queryByText("가입 요청")).not.toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: "홈 새로고침" });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
      expect(refreshButton).toHaveAttribute("aria-busy", "true");
    });
    expect(screen.getByText("오늘 등록된 급식이 없어요.")).toBeInTheDocument();
    expect(screen.getAllByText("우리반 허브")).toHaveLength(2);
    expect(document.querySelectorAll("[data-teacher-home-section]")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "처리할 일" })).toBe(tasksCard);
    expect(screen.queryByRole("region", { name: "오늘 출결 연락" })).not.toBeInTheDocument();
    expect(screen.queryByText("가입 요청")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("홈을 새로고침하는 중입니다.");

    await act(async () => {
      resolveRefresh?.(jsonResponse(homePayload));
    });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
      expect(refreshButton).toHaveAttribute("aria-busy", "false");
    });
  });

  it("keeps cached cards with a stale warning and recovers through retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-13T03:00:00.000Z"));
    let homeRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapPayload));
      if (url === "/api/v1/home") {
        homeRequestCount += 1;
        if (homeRequestCount === 1) return Promise.resolve(jsonResponse(homePayload));
        if (homeRequestCount === 2) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: "HOME_LOOKUP_FAILED", message: "private_home_view failed" } },
              503,
            ),
          );
        }
        return Promise.resolve(jsonResponse({ ...homePayload, pending_member_count: 2 }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("오늘 등록된 급식이 없어요.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("최신 홈 정보를 확인하지 못했어요.");
    expect(alert).toHaveTextContent("이전에 불러온 홈 카드를 계속 표시하고 있어");
    expect(screen.queryByText(/private_home_view/u)).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-teacher-home-section]")).toHaveLength(1);

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    const tasks = await screen.findByRole("region", { name: "처리할 일" });
    expect(tasks).toHaveTextContent("가입 요청2");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(homeRequestCount).toBe(3);
  });

  it("keeps the teacher shell and page heading when the initial Home request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapPayload));
      if (url === "/api/v1/home") {
        return Promise.resolve(
          jsonResponse({ error: { code: "HOME_LOOKUP_FAILED", message: "synthetic" } }, 503),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "홈을 열지 못했어요." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-app-role", "teacher");
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("홈을 불러오지 못했어요.");
    expect(screen.queryByText(/synthetic/u)).not.toBeInTheDocument();
  });
});
