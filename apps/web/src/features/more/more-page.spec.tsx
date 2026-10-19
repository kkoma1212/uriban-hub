import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MorePage } from "./more-page";

function bootstrapFixture(role: "student" | "teacher", allowedActions: string[]): object {
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
    server_today: "2026-08-29",
    teacher_profile:
      role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
  };
}

function mockBootstrap(body: object): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const path = new URL(String(input), "http://localhost").pathname;
    return Promise.resolve(
      new Response(
        JSON.stringify(
          path.endsWith("/bootstrap")
            ? body
            : path.includes("/system-state")
              ? { maintenance: false, announcement: null }
              : { items: [] },
        ),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      ),
    );
  });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/more"]}>
      <Routes>
        <Route element={<MorePage />} path="/more" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MorePage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains teacher help destination without inventing a count when its request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/bootstrap")
        ? Promise.resolve(
            new Response(
              JSON.stringify(bootstrapFixture("teacher", ["VIEW_CLASS", "USE_CLASS_CHAT"])),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          )
        : Promise.reject(Error("synthetic")),
    );
    renderPage();
    const menu = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    const help = within(menu).getByRole("link", { name: "도움 요청" });
    expect(help).toHaveAttribute("href", "/help-requests");
    expect(within(help).queryByLabelText(/건$/u)).not.toBeInTheDocument();
    expect([...menu.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/schedules",
      "/meals",
      "/class-chat",
      "/help-requests",
      "/past-classes",
      "/class/manage",
      "/settings",
    ]);
  });

  it("does not offer attendance when the running server has disabled it", async () => {
    mockBootstrap(bootstrapFixture("teacher", ["VIEW_CLASS"]));
    renderPage();
    const menu = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    expect(within(menu).queryByRole("link", { name: /출결 연락/u })).not.toBeInTheDocument();
  });

  it("exposes every teacher overflow destination and keeps the five-tab mobile shell", async () => {
    mockBootstrap(
      bootstrapFixture("teacher", [
        "VIEW_CLASS",
        "MANAGE_ATTENDANCE_NOTIFICATIONS",
        "MANAGE_POLLS",
      ]),
    );
    renderPage();

    const moreNavigation = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    expect(screen.getByRole("heading", { level: 1, name: "더보기" })).toBeVisible();
    expect(within(moreNavigation).getByRole("link", { name: /일정/u })).toHaveAttribute(
      "href",
      "/schedules",
    );
    expect(within(moreNavigation).getByRole("link", { name: /급식/u })).toHaveAttribute(
      "href",
      "/meals",
    );
    expect(within(moreNavigation).getByRole("link", { name: /반 활동/u })).toHaveAttribute(
      "href",
      "/activities",
    );
    expect(
      within(moreNavigation).queryByRole("link", { name: /출결 연락/u }),
    ).not.toBeInTheDocument();
    expect(within(moreNavigation).getByRole("link", { name: /반 관리/u })).toHaveAttribute(
      "href",
      "/class/manage",
    );
    // 휴대폰 교사도 더보기에서 설정 화면에 갈 수 있다(총검수 B1-01).
    expect(
      within(moreNavigation).getByRole("link", { name: /^내 계정·화면 설정/u }),
    ).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("region", { name: "우리 반 메뉴" })).toContainElement(
      within(moreNavigation).getByRole("link", { name: /급식/u }),
    );
    expect(screen.getByRole("region", { name: "기록·관리" })).toContainElement(
      within(moreNavigation).getByRole("link", { name: /반 관리/u }),
    );
    expect(screen.getByRole("heading", { level: 2, name: "우리 반 메뉴" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "기록·관리" })).toBeVisible();
    expect(screen.getByRole("link", { name: /반 프로필·관리/u })).toHaveAttribute(
      "href",
      "/class/manage",
    );

    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    expect(bottomNavigation).not.toBeNull();
    if (bottomNavigation === null) throw new Error("교사 하단 내비게이션을 찾지 못했습니다.");
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(within(bottomNavigation).getByRole("link", { name: "출결" })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(
      within(bottomNavigation).queryByRole("link", { name: "반 활동" }),
    ).not.toBeInTheDocument();
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("adds capability-gated student records to the remaining current functions", async () => {
    mockBootstrap(
      bootstrapFixture("student", ["VIEW_CLASS", "MANAGE_OWN_ASSESSMENTS", "VOTE_IN_POLLS"]),
    );
    renderPage();

    const moreNavigation = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    expect(within(moreNavigation).getByRole("link", { name: /^일정/u })).toHaveAttribute(
      "href",
      "/schedules",
    );
    expect(within(moreNavigation).getByRole("link", { name: /평가 기록/u })).toHaveAttribute(
      "href",
      "/assessments",
    );
    expect(within(moreNavigation).getByRole("link", { name: /급식/u })).toHaveAttribute(
      "href",
      "/meals",
    );
    expect(within(moreNavigation).getByRole("link", { name: /설정/u })).toHaveAttribute(
      "href",
      "/settings",
    );

    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    expect(bottomNavigation).not.toBeNull();
    if (bottomNavigation === null) throw new Error("학생 하단 내비게이션을 찾지 못했습니다.");
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(within(bottomNavigation).getByRole("link", { name: "홈" })).toHaveAttribute(
      "href",
      "/home",
    );
    // 2026-09-27 확정 시안: 출결이 꺼진 반의 넷째 탭은 반 활동, 반 활동은 더보기에도 있다.
    expect(within(bottomNavigation).getByRole("link", { name: "반 활동" })).toHaveAttribute(
      "href",
      "/activities",
    );
    expect(within(moreNavigation).getByRole("link", { name: /반 활동/u })).toHaveAttribute(
      "href",
      "/activities",
    );
    // P-016으로 뺀 자리표·모둠표를 학생 더보기 설명에 다시 적지 않는다(총검수 B2-03).
    expect(moreNavigation).not.toHaveTextContent(/자리표|모둠표/u);
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides 반 활동 when polls and elections are both off (A3-03)", async () => {
    mockBootstrap(bootstrapFixture("student", ["VIEW_CLASS"]));
    renderPage();
    const moreNavigation = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    await waitFor(() =>
      expect(
        within(moreNavigation).queryByRole("link", { name: /반 활동/u }),
      ).not.toBeInTheDocument(),
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    if (bottomNavigation === null) throw new Error("학생 하단 내비게이션을 찾지 못했습니다.");
    await waitFor(() =>
      expect(
        within(bottomNavigation).queryByRole("link", { name: "반 활동" }),
      ).not.toBeInTheDocument(),
    );
    // 빈 넷째 칸은 급식으로 채운다.
    expect(within(bottomNavigation).getByRole("link", { name: "급식" })).toHaveAttribute(
      "href",
      "/meals",
    );
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
  });

  it("does not advertise the assessment destination when its capability is off", async () => {
    mockBootstrap(bootstrapFixture("student", ["VIEW_CLASS", "VOTE_IN_POLLS"]));
    renderPage();

    const moreNavigation = await screen.findByRole("navigation", { name: "더보기 메뉴" });
    expect(
      within(moreNavigation).queryByRole("link", { name: /평가 기록/u }),
    ).not.toBeInTheDocument();
    expect(within(moreNavigation).getByRole("link", { name: /지난 반 기록/u })).toHaveAttribute(
      "href",
      "/past-classes",
    );
    expect(
      within(moreNavigation).getByRole("link", { name: /선생님께 물어보기/u }),
    ).toHaveAttribute("href", "/help-requests/ask");
    expect(within(moreNavigation).getAllByRole("link")).toHaveLength(7);
  });
});

describe("학생 더보기의 준비물·숙제 찾기", () => {
  it.each([
    { allowedActions: ["VIEW_CLASS"] },
    { allowedActions: ["VIEW_CLASS", "MANAGE_OWN_ASSESSMENTS", "VOTE_IN_POLLS", "USE_CLASS_CHAT"] },
  ])(
    "선택 기능 %j에서도 우리반 메뉴 진입을 제공하며 대표5탭을 늘리지 않는다",
    async ({ allowedActions }) => {
      mockBootstrap(bootstrapFixture("student", allowedActions));
      renderPage();
      const menu = await screen.findByRole("navigation", { name: "더보기 메뉴" });
      const link = within(menu).getByRole("link", { name: "준비물·숙제" });
      expect(link).toHaveAttribute("href", "/supplies");
      expect(link).toHaveAttribute("data-more-tile", "/supplies");
      expect(link.closest("section")?.querySelector("h2")?.textContent).toBe("우리 반 메뉴");
      const bottom = document.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="student-bottom"]',
      )!;
      expect(within(bottom).getAllByRole("link")).toHaveLength(5);
    },
  );
});
