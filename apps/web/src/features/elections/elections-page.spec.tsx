import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ElectionsPage } from "./elections-page";

/*
 * 2026-08-17에 투표를 만드는 입구가 여기로 모였다(Hex 결정). 그전에는 알림 화면·띠·
 * 투표 화면 셋에 흩어져 있었다. 이 스펙이 지키는 것은 **그 입구가 여기 있다는 것**과
 * **종료된 배치 기능의 진입점이 없다는 것** 둘이다.
 */

function bootstrapFixture(
  role: "student" | "teacher",
  allowedActions: string[],
): Record<string, unknown> {
  return {
    account: { display_name: "사용자", email_verified: true, is_active: true },
    allowed_actions: allowedActions,
    current_class: { id: "class-1", name: "테스트 1반", status: "active" },
    current_membership: {
      class_id: "class-1",
      display_name_in_class: "사용자",
      id: "member-1",
      role,
      status: "approved",
      student_number: role === "student" ? 7 : null,
    },
    destination: "HOME",
    last_membership_status: null,
    last_status_reason: null,
    server_today: "2026-08-17",
    teacher_profile:
      role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function mockRoutes(bootstrap: Record<string, unknown>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrap));
    if (url.startsWith("/api/v1/elections")) {
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/elections"]}>
      <Routes>
        <Route element={<ElectionsPage />} path="/elections" />
        <Route element={<p>홈 화면</p>} path="/home" />
        <Route element={<p>반 활동 화면</p>} path="/activities" />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ElectionsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the poll creation entry beside the election one", async () => {
    mockRoutes(
      bootstrapFixture("teacher", [
        "VIEW_CLASS",
        "MANAGE_CLASS",
        "MANAGE_ELECTIONS",
        "MANAGE_POLLS",
        "MANAGE_SEAT_DRAWS",
      ]),
    );
    renderPage();

    expect(await screen.findByRole("button", { name: "대표 선거 만들기" })).toBeVisible();
    expect(screen.getByRole("link", { name: "투표 만들기" })).toHaveAttribute(
      "href",
      "/polls?create=1",
    );
  });

  it("omits retired layout tabs while preserving poll and election creation", async () => {
    mockRoutes(
      bootstrapFixture("teacher", [
        "VIEW_CLASS",
        "MANAGE_CLASS",
        "MANAGE_ELECTIONS",
        "MANAGE_POLLS",
        "MANAGE_SEAT_DRAWS",
      ]),
    );
    renderPage();

    expect(await screen.findByRole("link", { name: "투표 만들기" })).toBeVisible();
    expect(screen.getByRole("button", { name: "대표 선거 만들기" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "정하기 종류" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /자리|모둠|당번/u })).not.toBeInTheDocument();
  });

  /* 학생에게는 만들 권한이 없다 — 갈 곳 없는 단추를 보여주지 않는다. */
  it("sends users back to class activities when elections are off (B4-03)", async () => {
    mockRoutes(bootstrapFixture("student", ["VIEW_CLASS", "VOTE_IN_POLLS"]));
    renderPage();
    expect(await screen.findByText("반 활동 화면")).toBeVisible();
  });

  it("keeps the creation entries away from students", async () => {
    mockRoutes(bootstrapFixture("student", ["VIEW_CLASS", "VOTE_IN_ELECTIONS", "VOTE_IN_POLLS"]));
    renderPage();

    expect(await screen.findByRole("heading", { name: "대표 선거" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "투표 만들기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "대표 선거 만들기" })).not.toBeInTheDocument();
  });
});
