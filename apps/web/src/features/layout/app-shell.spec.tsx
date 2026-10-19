import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acknowledgeAttendanceNotification } from "../../api/attendance-notifications";
import { resolveHelpRequest } from "../../api/help-requests";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import {
  beginNavigationCapabilitiesRequest,
  clearNavigationCapabilities,
  rememberNavigationCapabilities,
} from "../../lib/navigation-capabilities";
import { AppShell, AppShellBar, ProductWordmark } from "./app-shell";

const requestPath = (input: RequestInfo | URL) =>
  new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname;
const publicStateOffResponse = () =>
  new Response(JSON.stringify({ maintenance: false, announcement: null }));

describe("shared product app shell", () => {
  it.each([
    ["teacher", ["반 소식", "학생 돌봄", "반 생활", "반 관리"]],
    ["student", ["소식과 소통", "활동과 기록", "생활 정보"]],
  ] as const)("groups only the %s desktop menu without changing mobile tabs", (role, groups) => {
    const { container } = render(
      <MemoryRouter>
        <AppShell navigationRole={role} attendanceNotificationsEnabled={false}>
          <p>본문</p>
        </AppShell>
      </MemoryRouter>,
    );
    const desktop = container.querySelector(`[data-primary-navigation-layout="${role}-desktop"]`)!;
    const mobile = container.querySelector(`[data-primary-navigation-layout="${role}-bottom"]`)!;
    expect(
      [...desktop.querySelectorAll("[data-navigation-group]")].map((item) => item.textContent),
    ).toEqual(groups);
    expect(mobile.querySelectorAll("[data-navigation-group]")).toHaveLength(0);
    expect(mobile.querySelectorAll("a")).toHaveLength(5);
    expect([...desktop.querySelectorAll("a")].slice(0, 2).map((item) => item.textContent)).toEqual([
      "홈",
      "소식",
    ]);
  });

  it.each([
    ["teacher", "/class-chat"],
    ["student", "/class-chat"],
    ["teacher", "/past-classes"],
    ["student", "/past-classes"],
    ["teacher", "/past-classes/7"],
    ["student", "/past-classes/7"],
  ] as const)(
    "keeps %s overflow ownership clear on %s without duplicate current tabs",
    async (role, path) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] })));
      rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), {
        allowed_actions: ["VIEW_CLASS", "USE_CLASS_CHAT"],
        current_membership: { class_id: "1", id: "1", role, status: "approved" },
      } as never);
      const { container } = render(
        <MemoryRouter initialEntries={[path]}>
          <AppShell navigationRole={role} attendanceNotificationsEnabled={false}>
            <p>내용</p>
          </AppShell>
        </MemoryRouter>,
      );
      const mobile = container.querySelector<HTMLElement>(
        `[data-primary-navigation-layout="${role}-bottom"]`,
      )!;
      await waitFor(() =>
        expect(within(mobile).getByRole("link", { name: "더보기" })).toHaveAttribute(
          "aria-current",
          "page",
        ),
      );
      expect(mobile.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(mobile.querySelectorAll("a")).toHaveLength(5);
      const desktop = container.querySelector<HTMLElement>(
        `[data-primary-navigation-layout="${role}-desktop"]`,
      )!;
      if (path === "/class-chat") {
        expect(within(desktop).getByRole("link", { name: "반 대화" })).toHaveAttribute(
          "aria-current",
          "page",
        );
        expect(desktop.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      }
    },
  );
  it.each(["teacher", "student"] as const)(
    "does not claim an unavailable class chat for %s",
    (role) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] })));
      rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), {
        allowed_actions: ["VIEW_CLASS"],
        current_membership: { class_id: "1", id: "1", role, status: "approved" },
      } as never);
      const { container } = render(
        <MemoryRouter initialEntries={["/class-chat"]}>
          <AppShell navigationRole={role} attendanceNotificationsEnabled={false}>
            <p>내용</p>
          </AppShell>
        </MemoryRouter>,
      );
      const mobile = container.querySelector<HTMLElement>(
        `[data-primary-navigation-layout="${role}-bottom"]`,
      )!;
      expect(within(mobile).getByRole("link", { name: "더보기" })).not.toHaveAttribute(
        "aria-current",
      );
      expect(
        container.querySelector(
          '[data-primary-navigation-layout="' + role + '-desktop"] a[href="/class-chat"]',
        ),
      ).toBeNull();
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
    clearNavigationCapabilities();
  });

  it("keeps desktop navigation when a detail action bar replaces the mobile menu", () => {
    const { container } = render(
      <MemoryRouter>
        <AppShell
          attendanceNotificationsEnabled={false}
          contentFrame
          hideMobileNavigation
          navigationRole="teacher"
        >
          <p>글 상세</p>
        </AppShell>
      </MemoryRouter>,
    );

    expect(container.querySelector('[data-primary-navigation-layout="teacher-bottom"]')).toBeNull();
    expect(
      container.querySelector('[data-primary-navigation-layout="teacher-desktop"]'),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-content-frame", "true");
  });

  it.each([0, 3, 103, "unavailable"] as const)(
    "keeps teacher attendance visible with pending=%s and shares one count between both menus",
    async (pending) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) =>
          requestPath(input) === "/api/v1/public/system-state"
            ? publicStateOffResponse()
            : new Response(
                JSON.stringify(
                  pending === "unavailable"
                    ? { error: { code: "UNAVAILABLE", message: "잠시 후 다시 시도" } }
                    : { role: "teacher", counts: { pending } },
                ),
                { status: pending === "unavailable" ? 503 : 200 },
              ),
        );
      render(
        <MemoryRouter initialEntries={["/attendance"]}>
          <AppShell navigationRole="teacher" attendanceNotificationsEnabled>
            <p>출결 화면</p>
          </AppShell>
        </MemoryRouter>,
      );
      const hasPending = typeof pending === "number" && pending > 0;
      const desktopLabel = hasPending ? `출결 연락, 미확인 ${pending}건` : "출결 연락";
      const entry = await screen.findByRole("link", { name: desktopLabel });
      expect(entry).toHaveAttribute("href", "/attendance");
      expect(entry).toHaveAttribute("aria-current", "page");
      const bottom = document.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="teacher-bottom"]',
      )!;
      expect(
        [...bottom.querySelectorAll("a")].map((link) => link.dataset.primaryNavigationItem),
      ).toEqual(["홈", "소식", "출결", "학생", "더보기"]);
      const mobile = within(bottom).getByRole("link", {
        name: hasPending ? `출결, 미확인 ${pending}건` : "출결",
      });
      expect(mobile).toHaveAttribute("aria-current", "page");
      expect(
        screen.getAllByRole("navigation", { name: "주요 메뉴" })[0]?.querySelectorAll("a"),
      ).toHaveLength(9);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => requestPath(input) === "/api/v1/attendance-notifications/today",
          ),
        ).toHaveLength(1),
      );
      const badges = document.querySelectorAll("[data-attendance-pending-badge]");
      expect(badges).toHaveLength(hasPending ? 2 : 0);
      if (hasPending) expect(badges[0]).toHaveTextContent(pending > 99 ? "99+" : String(pending));
    },
  );

  it("shows open help requests in the teacher rail and More, and refreshes after closing", async () => {
    let open = 2;
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (requestPath(input) === "/api/v1/public/system-state") return publicStateOffResponse();
      expect(String(input)).toContain("/api/v1/help-requests");
      if (init?.method === "POST") {
        open = 0;
        return new Response(JSON.stringify({ id: "17", status: "resolved" }));
      }
      return new Response(
        JSON.stringify({
          items: Array.from({ length: open }, (_, id) => ({ id: String(id + 1) })),
        }),
      );
    });
    // 서버가 담임으로 확인한 뒤에만 교사용 숫자를 묻는다.
    rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), {
      allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS"],
      current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
    } as never);
    const view = render(
      <MemoryRouter initialEntries={["/help-requests/17"]}>
        <AppShell navigationRole="teacher" attendanceNotificationsEnabled={false}>
          <p>도움 요청 대화</p>
        </AppShell>
      </MemoryRouter>,
    );
    const entry = await screen.findByRole("link", { name: "도움 요청, 열린 도움 요청 2건" });
    expect(entry).toHaveAttribute("href", "/help-requests");
    expect(entry).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "더보기, 열린 도움 요청 2건" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.querySelectorAll("[data-help-request-badge]")).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestPath(input) === "/api/v1/help-requests"),
    ).toHaveLength(1);
    await act(async () => {
      await resolveHelpRequest("17", null);
    });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-help-request-badge]")).toHaveLength(0),
    );
    open = 3;
    fireEvent.focus(window);
    await screen.findByRole("link", { name: "도움 요청, 열린 도움 요청 3건" });
    fireEvent(window, new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    expect(document.querySelectorAll("[data-help-request-badge]")).toHaveLength(0);
    view.unmount();
    const requests = fetchMock.mock.calls.length;
    fireEvent.focus(window);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it("refreshes the badge after acknowledgement and when returning to the window", async () => {
    let pending = 1;
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestPath(input) === "/api/v1/public/system-state")
        return Promise.resolve(publicStateOffResponse());
      if (init?.method === "POST") {
        pending = 0;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "17", row_version: "2", status: "acknowledged" })),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ role: "teacher", counts: { pending } })),
      );
    });
    const view = render(
      <MemoryRouter initialEntries={["/attendance"]}>
        <AppShell navigationRole="teacher" attendanceNotificationsEnabled>
          <p>출결 화면</p>
        </AppShell>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "출결, 미확인 1건" });
    await act(async () => {
      await acknowledgeAttendanceNotification("17", "2026-09-13", '"1"');
    });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-attendance-pending-badge]")).toHaveLength(0),
    );
    expect(screen.getByRole("link", { name: "출결" })).toBeInTheDocument();
    pending = 2;
    fireEvent.focus(window);
    await screen.findByRole("link", { name: "출결, 미확인 2건" });
    view.unmount();
    const requests = fetchMock.mock.calls.length;
    fireEvent.focus(window);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it.each(["/activities", "/polls/17", "/elections"])(
    "marks More on mobile and activities on desktop for %s when attendance is enabled",
    (path) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("count unavailable"));
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppShell navigationRole="teacher" attendanceNotificationsEnabled>
            <p>반 활동</p>
          </AppShell>
        </MemoryRouter>,
      );
      for (const [layout, label] of [
        ["desktop", "반 활동"],
        ["bottom", "더보기"],
      ] as const) {
        const menu = document.querySelector<HTMLElement>(
          `[data-primary-navigation-layout="teacher-${layout}"]`,
        )!;
        expect(within(menu).getAllByRole("link", { current: "page" })).toHaveLength(1);
        expect(within(menu).getByRole("link", { name: label })).toHaveAttribute(
          "aria-current",
          "page",
        );
      }
    },
  );
  // 2026-09-27 확정 시안: 학생 탭은 홈·소식·일정·(출결 | 출결이 꺼진 반은 반 활동)·더보기.
  it.each([
    [false, false, "반 활동", "/activities"],
    [false, true, "반 활동", "/activities"],
    [true, false, "출결", "/attendance"],
    [true, true, "출결", "/attendance"],
  ] as const)(
    "keeps the fourth student tab usable for attendance=%s, assessments=%s",
    (attendance, assessments, label, destination) => {
      render(
        <MemoryRouter initialEntries={["/schedules"]}>
          <AppShell
            navigationRole="student"
            attendanceNotificationsEnabled={attendance}
            studentAssessmentsEnabled={assessments}
          >
            <p>검수</p>
          </AppShell>
        </MemoryRouter>,
      );
      const bottom = document.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="student-bottom"]',
      )!;
      const desktop = document.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="student-desktop"]',
      )!;
      expect(within(bottom).getAllByRole("link")).toHaveLength(5);
      expect(within(bottom).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        destination,
      );
      expect(within(desktop).queryByRole("link", { name: "출결 연락" }) !== null).toBe(attendance);
      expect(within(desktop).queryByRole("link", { name: "평가 기록" }) !== null).toBe(assessments);
      // 일정은 이제 늘 탭에 있다.
      expect(within(bottom).getByRole("link", { name: "일정" })).toHaveAttribute(
        "href",
        "/schedules",
      );
      const currentLinks = within(bottom).getAllByRole("link", { current: "page" });
      expect(currentLinks).toHaveLength(1);
      expect(currentLinks[0]).toHaveTextContent("일정");
    },
  );

  it("keeps the shared page gutter and explicit content width", () => {
    render(
      <MemoryRouter>
        <AppShell width="wide">
          <p>공통 shell 내용</p>
        </AppShell>
      </MemoryRouter>,
    );

    const shell = screen.getByRole("main");
    expect(shell).toHaveAttribute("data-app-shell", "true");
    expect(shell).toHaveAttribute("data-app-role", "public");
    expect(shell).toHaveAttribute("data-app-shell-layout", "standalone");
    expect(shell).toHaveAttribute("id", "app-main-content");
    expect(shell).toHaveAttribute("tabindex", "-1");
    expect(shell).toHaveClass("app-main-content", "bg-app-canvas", "text-app-text");
    expect(shell.firstElementChild).toHaveAttribute("data-app-shell-width", "wide");
    expect(shell.firstElementChild).toHaveClass("w-full", "max-w-[70rem]");
    expect(screen.getByRole("link", { name: "본문으로 건너뛰기" })).toHaveAttribute(
      "href",
      "#app-main-content",
    );
  });

  it("provides one consistent wordmark and semantic back navigation", () => {
    render(
      <MemoryRouter>
        <AppShell width="medium">
          <AppShellBar backLabel="홈으로" backTo="/home" brandTo="/home" context="교사 관리" />
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "우리반 허브 · 교사 관리" })).toHaveAttribute(
      "href",
      "/home",
    );
    expect(screen.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("navigation", { name: "페이지 이동" })).toBeInTheDocument();
  });

  it("replaces the duplicate in-app wordmark with route breadcrumbs and a common footer", () => {
    render(
      <MemoryRouter initialEntries={["/notices/17"]}>
        <AppShell navigationRole="teacher" width="medium">
          <AppShellBar
            backLabel="공지 목록"
            backTo="/notices"
            brandTo="/home"
            context="공지 상세"
          />
          <p>공지 상세 내용</p>
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(breadcrumb).getByRole("link", { name: "홈" })).toHaveAttribute("href", "/home");
    expect(within(breadcrumb).getByRole("link", { name: "우리반 소식" })).toHaveAttribute(
      "href",
      "/updates",
    );
    expect(within(breadcrumb).getByText("공지")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "우리반 허브 · 공지 상세" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "공지 목록" })).toHaveAttribute("href", "/notices");

    const footer = screen.getByRole("contentinfo", { name: "서비스 정보" });
    expect(within(footer).getByText("© 2026 우리반 허브")).toBeInTheDocument();
    expect(within(footer).queryByText(/제작·운영/u)).not.toBeInTheDocument();
    expect(
      within(footer).getByRole("link", { name: "문의 uribanhub@naver.com" }),
    ).toHaveAttribute("href", "mailto:uribanhub@naver.com");
    expect(
      within(footer).getByRole("link", { name: "이용약관 전문 보기 (새 탭)" }),
    ).toHaveAttribute("href", "/legal/terms");
  });

  it("does not repeat a back destination already present in the breadcrumb", () => {
    render(
      <MemoryRouter initialEntries={["/notices"]}>
        <AppShell navigationRole="student" width="medium">
          <AppShellBar backLabel="홈으로" backTo="/home" brandTo="/home" context="공지" />
          <p>공지 목록</p>
        </AppShell>
      </MemoryRouter>,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "현재 위치" });
    expect(within(breadcrumb).getByRole("link", { name: "홈" })).toHaveAttribute("href", "/home");
    expect(screen.queryByRole("link", { name: "홈으로" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "페이지 이동" })).not.toBeInTheDocument();
  });

  it("shows the requested footer on home without adding a breadcrumb", () => {
    render(
      <MemoryRouter initialEntries={["/home"]}>
        <AppShell navigationRole="student" width="wide" attendanceNotificationsEnabled>
          <p>학생 오늘 내용</p>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("navigation", { name: "현재 위치" })).not.toBeInTheDocument();
    expect(screen.getByText("© 2026 우리반 허브")).toBeInTheDocument();
  });

  it("can render a non-navigation dark wordmark inside the home hero", () => {
    render(<ProductWordmark context="학생 홈" tone="dark" />);

    expect(screen.getByText("우리반 허브")).toBeInTheDocument();
    expect(screen.getByText("학생 홈")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("places CSS-exclusive student navigation variants around the main content", () => {
    render(
      <MemoryRouter initialEntries={["/supplies/1"]}>
        <AppShell navigationRole="student" width="wide" attendanceNotificationsEnabled>
          <p>준비물 상세</p>
        </AppShell>
      </MemoryRouter>,
    );

    const skipLink = screen.getByRole("link", { name: "본문으로 건너뛰기" });
    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    const main = screen.getByRole("main");
    const shell = main.parentElement;

    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("학생 반응형 내비게이션 변형을 찾지 못했습니다.");
    }
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(desktopNavigation).toHaveAttribute("data-app-role", "student");
    expect(bottomNavigation).toHaveAttribute("data-app-role", "student");
    expect(desktopNavigation).toHaveAttribute(
      "data-app-shell-layout",
      "student-desktop-navigation",
    );
    expect(bottomNavigation).toHaveAttribute("data-app-shell-layout", "student-bottom-navigation");
    expect(desktopNavigation.parentElement).toHaveClass(
      "app-desktop-rail",
      "hidden",
      "lg:sticky",
      "lg:top-0",
      "lg:col-start-1",
      "lg:row-start-1",
      "lg:flex",
      "lg:h-dvh",
      "lg:flex-col",
    );
    expect(desktopNavigation).toHaveClass("min-h-0", "overflow-y-auto", "overscroll-contain");
    /*
     * 좁은 화면 탭 띠는 화면 끝까지 붙지 않는다 — 본문과 같은 좌우 여백(모바일 20px,
     * sm 이상 32px) 위에 같은 폭 상한으로 선다(2026-08-25 Round 5 §3 좌우 rail).
     */
    expect(bottomNavigation).toHaveClass(
      "fixed",
      "inset-x-5",
      "sm:inset-x-8",
      "mx-auto",
      "max-w-[70rem]",
      "bottom-0",
      "app-bottom-navigation",
      "border-app-border",
      "bg-app-surface",
      "pb-[env(safe-area-inset-bottom)]",
      "lg:hidden",
    );
    expect(bottomNavigation).not.toHaveClass("inset-x-0");
    expect(within(desktopNavigation).getByText("학생")).toBeInTheDocument();
    // desktop은 준비물·숙제 진입을 더하고, 좁은 화면은 4개 핵심 + 더보기로 유지한다.
    expect(within(desktopNavigation).getAllByRole("link")).toHaveLength(8);
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(desktopNavigation.querySelectorAll("[data-primary-navigation-item]")).toHaveLength(8);
    expect(bottomNavigation.querySelectorAll("[data-primary-navigation-item]")).toHaveLength(5);
    expect(
      [...desktopNavigation.querySelectorAll("[data-primary-navigation-item]")].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      "홈",
      "소식",
      "선생님께 물어보기",
      "반 활동",
      "일정",
      "출결 연락",
      "준비물·숙제",
      "급식",
    ]);
    expect(
      [...bottomNavigation.querySelectorAll("[data-primary-navigation-item]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["홈", "소식", "일정", "출결", "더보기"]);
    expect(bottomNavigation.firstElementChild).toHaveClass("grid-cols-5");
    const homeLink = within(bottomNavigation).getByRole("link", { name: "홈" });
    expect(homeLink).toHaveAttribute("href", "/home");
    expect(homeLink).toHaveClass(
      "min-h-[4.25rem]",
      "gap-1",
      "rounded-xl",
      "py-1.5",
      "text-xs leading-[1.03125rem]",
    );
    const alertsLink = within(bottomNavigation).getByRole("link", { name: "소식" });
    expect(alertsLink).toHaveAttribute("href", "/updates");
    expect(alertsLink).toHaveAttribute("aria-current", "page");
    expect(alertsLink).toHaveClass("text-role-primary");
    expect(alertsLink).not.toHaveClass("bg-role-soft");
    expect(alertsLink.querySelector("[data-primary-navigation-indicator]")).not.toBeNull();
    expect(within(desktopNavigation).getByRole("link", { name: "준비물·숙제" })).toHaveClass(
      "border-role-border",
      "bg-role-soft",
      "text-role-primary",
    );
    expect(within(bottomNavigation).queryByRole("link", { name: "공지" })).not.toBeInTheDocument();
    expect(within(bottomNavigation).queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
    const accountNavigation = screen.getByRole("navigation", { name: "학생 계정" });
    expect(accountNavigation).toHaveClass("lg:mt-auto");
    expect(accountNavigation).toContainElement(screen.getByRole("link", { name: /내 계정/u }));
    expect(within(accountNavigation).getByRole("link", { name: /내 계정/u })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(within(bottomNavigation).getByRole("link", { name: "출결" })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "href",
      "/more",
    );
    expect(
      within(bottomNavigation).queryByRole("link", { name: "캘린더" }),
    ).not.toBeInTheDocument();
    // 2026-09-27 확정 시안: 일정은 학생 탭에 있다.
    expect(within(bottomNavigation).getByRole("link", { name: "일정" })).toHaveAttribute(
      "href",
      "/schedules",
    );
    expect(within(bottomNavigation).queryByRole("link", { name: "평가" })).not.toBeInTheDocument();
    expect(within(bottomNavigation).queryByRole("link", { name: "관리" })).not.toBeInTheDocument();
    expect(shell).toHaveAttribute("data-app-role", "student");
    expect(shell).toHaveAttribute("data-app-shell-layout", "student-responsive");
    expect(shell).toHaveClass(
      "bg-app-canvas",
      "lg:grid",
      "lg:grid-cols-[13.5rem_minmax(0,1fr)]",
      "xl:grid-cols-[14.5rem_minmax(0,1fr)]",
    );
    expect(main).toHaveAttribute("data-app-role", "student");
    expect(main).toHaveAttribute("data-app-shell-layout", "student-main");
    expect(main).toHaveClass(
      "app-main-content",
      "pb-[calc(6rem+env(safe-area-inset-bottom))]",
      "lg:col-start-2",
      "lg:row-start-1",
      "lg:pb-8",
    );
    expect(skipLink).toHaveAttribute("href", "#app-main-content");
    expect(desktopNavigation.parentElement?.nextElementSibling).toBe(main);
    expect(
      desktopNavigation.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      main.compareDocumentPosition(bottomNavigation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("places CSS-exclusive teacher navigation variants around the main content", () => {
    const longTask = "아주 긴 한국어 교사 업무 제목도 본문 폭 안에서 줄바꿈되어야 해요";
    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <AppShell navigationRole="teacher" width="wide">
          <a className="break-words" href="#teacher-content">
            {longTask}
          </a>
        </AppShell>
      </MemoryRouter>,
    );

    const skipLink = screen.getByRole("link", { name: "본문으로 건너뛰기" });
    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    const main = screen.getByRole("main");
    const shell = main.parentElement;
    const contentLink = screen.getByRole("link", { name: longTask });

    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("교사 반응형 내비게이션을 찾지 못했습니다.");
    }
    expect(desktopNavigation).toHaveAttribute("aria-label", "주요 메뉴");
    expect(bottomNavigation).toHaveAttribute("aria-label", "주요 메뉴");
    expect(desktopNavigation).toHaveAttribute("data-app-role", "teacher");
    expect(desktopNavigation).toHaveAttribute(
      "data-app-shell-layout",
      "teacher-desktop-navigation",
    );
    expect(desktopNavigation).toHaveAttribute("data-primary-navigation-layout", "teacher-desktop");
    expect(desktopNavigation.parentElement).toHaveClass(
      "app-desktop-rail",
      "hidden",
      "lg:sticky",
      "lg:top-0",
      "lg:col-start-1",
      "lg:row-start-1",
      "lg:flex",
      "lg:h-dvh",
      "lg:flex-col",
    );
    expect(bottomNavigation).toHaveAttribute("data-app-role", "teacher");
    expect(bottomNavigation).toHaveAttribute("data-app-shell-layout", "teacher-bottom-navigation");
    expect(bottomNavigation).toHaveAttribute("data-primary-navigation-layout", "teacher-bottom");
    expect(bottomNavigation).toHaveClass(
      "fixed",
      "bottom-0",
      "lg:hidden",
      "app-bottom-navigation",
      "border-app-border",
      "bg-app-surface",
      "pb-[env(safe-area-inset-bottom)]",
    );
    expect(within(desktopNavigation).getByText("선생님")).toBeInTheDocument();
    expect(within(desktopNavigation).getAllByRole("link")).toHaveLength(8);
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(desktopNavigation.querySelectorAll("[data-primary-navigation-item]")).toHaveLength(8);
    expect(bottomNavigation.querySelectorAll("[data-primary-navigation-item]")).toHaveLength(5);
    expect(
      [...desktopNavigation.querySelectorAll("[data-primary-navigation-item]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["홈", "소식", "학생", "도움 요청", "일정", "반 활동", "급식", "반 관리"]);
    expect(
      [...bottomNavigation.querySelectorAll("[data-primary-navigation-item]")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["홈", "소식", "반 활동", "학생", "더보기"]);
    expect(bottomNavigation.firstElementChild).toHaveClass("grid-cols-5");
    expect(within(desktopNavigation).getByRole("link", { name: "반 관리" })).toHaveClass(
      "min-h-11",
      "border-role-border",
      "bg-role-soft",
      "text-role-primary",
    );
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(shell).toHaveAttribute("data-app-shell-layout", "teacher-responsive");
    expect(shell).toHaveAttribute("data-app-role", "teacher");
    expect(shell).toHaveClass(
      "lg:grid",
      "lg:grid-cols-[13.5rem_minmax(0,1fr)]",
      "xl:grid-cols-[14.5rem_minmax(0,1fr)]",
    );
    expect(main).toHaveAttribute("data-app-role", "teacher");
    expect(main).toHaveAttribute("data-app-shell-layout", "teacher-main");
    expect(main).toHaveClass(
      "app-main-content",
      "pb-[calc(6rem+env(safe-area-inset-bottom))]",
      "lg:pb-8",
    );
    expect(main.firstElementChild).toHaveClass("min-w-0", "w-full", "max-w-[70rem]");
    expect(skipLink).toHaveAttribute("href", "#app-main-content");
    expect(main).toHaveAttribute("id", "app-main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(desktopNavigation.parentElement?.nextElementSibling).toBe(main);
    expect(screen.queryByRole("navigation", { name: "교사 빠른 작업" })).not.toBeInTheDocument();
    const teacherAccount = screen.getByRole("navigation", { name: "선생님 계정" });
    expect(within(teacherAccount).getByRole("link", { name: /내 계정/u })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(
      desktopNavigation.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      main.compareDocumentPosition(bottomNavigation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(contentLink).toHaveClass("break-words");

    for (const navigationLink of within(desktopNavigation).getAllByRole("link")) {
      expect(
        navigationLink.compareDocumentPosition(contentLink) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    for (const navigationLink of within(bottomNavigation).getAllByRole("link")) {
      expect(
        contentLink.compareDocumentPosition(navigationLink) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("marks the shared alerts area current on teacher notice routes", () => {
    render(
      <MemoryRouter initialEntries={["/notices/1"]}>
        <AppShell navigationRole="teacher">
          <p>공지 상세</p>
        </AppShell>
      </MemoryRouter>,
    );

    for (const navigation of screen.getAllByRole("navigation", { name: "주요 메뉴" })) {
      expect(within(navigation).getByRole("link", { name: "소식" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(within(navigation).queryByRole("link", { name: "공지" })).not.toBeInTheDocument();
    }
  });

  it("selects teacher attendance independently of alerts and More", () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("count unavailable"));
    render(
      <MemoryRouter initialEntries={["/attendance"]}>
        <AppShell navigationRole="teacher" attendanceNotificationsEnabled>
          <p>출결 연락</p>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("교사 내비게이션을 찾지 못했습니다.");
    }
    expect(within(desktopNavigation).getByRole("link", { name: "출결 연락" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(within(bottomNavigation).getByRole("link", { name: "출결" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(bottomNavigation).getByRole("link", { name: "소식" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("uses an independent teacher student destination on the member route", () => {
    render(
      <MemoryRouter initialEntries={["/members/manage"]}>
        <AppShell navigationRole="teacher">
          <p>학생 관리</p>
        </AppShell>
      </MemoryRouter>,
    );

    const navigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    expect(navigation).not.toBeNull();
    if (navigation === null) throw new Error("교사 하단 내비게이션을 찾지 못했습니다.");
    expect(within(navigation).getByRole("link", { name: "학생" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).getByRole("link", { name: "학생" })).toHaveAttribute(
      "href",
      "/members/manage?tab=approved",
    );
    expect(within(navigation).getByRole("link", { name: "더보기" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(navigation).queryByRole("link", { name: "관리" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
  });

  it("marks retained election tools as the activities tab", () => {
    render(
      <MemoryRouter initialEntries={["/elections"]}>
        <AppShell navigationRole="teacher">
          <p>대표 선거</p>
        </AppShell>
      </MemoryRouter>,
    );

    for (const navigation of screen.getAllByRole("navigation", { name: "주요 메뉴" })) {
      expect(within(navigation).getByRole("link", { name: "반 활동" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(within(navigation).getByRole("link", { name: "반 활동" })).toHaveAttribute(
        "href",
        "/activities",
      );
      expect(within(navigation).getByRole("link", { name: "홈" })).not.toHaveAttribute(
        "aria-current",
      );

      const managementLink = within(navigation).queryByRole("link", { name: "반 관리" });
      if (managementLink !== null) {
        expect(managementLink).not.toHaveAttribute("aria-current");
      }

      const moreLink = within(navigation).queryByRole("link", { name: "더보기" });
      if (moreLink !== null) {
        expect(moreLink).not.toHaveAttribute("aria-current");
      }
    }
  });

  it("keeps the account link in the desktop account area and outside the primary mobile tabs", () => {
    render(
      <MemoryRouter initialEntries={["/account/password"]}>
        <AppShell navigationRole="student">
          <p>학생 비밀번호 변경</p>
        </AppShell>
      </MemoryRouter>,
    );

    const navigations = screen.getAllByRole("navigation", { name: "주요 메뉴" });
    expect(navigations).toHaveLength(2);
    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("학생 내비게이션을 찾지 못했습니다.");
    }
    expect(within(desktopNavigation).getAllByRole("link")).toHaveLength(7);
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(bottomNavigation).queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
    const accountNavigation = screen.getByRole("navigation", { name: "학생 계정" });
    expect(within(accountNavigation).getByRole("link", { name: /내 계정/u })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(accountNavigation).getByRole("link", { name: /내 계정/u })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("adds a capability-gated assessment tab and keeps it independently active", () => {
    render(
      <MemoryRouter initialEntries={["/assessments"]}>
        <AppShell navigationRole="student" studentAssessmentsEnabled>
          <p>나의 평가</p>
        </AppShell>
      </MemoryRouter>,
    );

    const desktopNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-desktop"]',
    );
    const bottomNavigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    expect(desktopNavigation).not.toBeNull();
    expect(bottomNavigation).not.toBeNull();
    if (desktopNavigation === null || bottomNavigation === null) {
      throw new Error("학생 내비게이션을 찾지 못했습니다.");
    }
    expect(within(desktopNavigation).getAllByRole("link")).toHaveLength(8);
    expect(within(desktopNavigation).getByRole("link", { name: "평가 기록" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(desktopNavigation).getByRole("link", { name: "평가 기록" })).toHaveAttribute(
      "href",
      "/assessments",
    );
    expect(within(bottomNavigation).getAllByRole("link")).toHaveLength(5);
    // 평가 기록은 학생 탭에 없고(시안), 이 경로에서는 더보기가 선택된다.
    expect(within(bottomNavigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(bottomNavigation).queryByRole("link", { name: "평가" })).not.toBeInTheDocument();
    expect(bottomNavigation.firstElementChild).toHaveClass("grid-cols-5");
  });

  it("keeps the role-specific account destination active on the password route", () => {
    render(
      <MemoryRouter initialEntries={["/account/password"]}>
        <AppShell navigationRole="teacher">
          <p>교사 비밀번호 변경</p>
        </AppShell>
      </MemoryRouter>,
    );

    const navigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    expect(navigation).not.toBeNull();
    if (navigation === null) throw new Error("교사 하단 내비게이션을 찾지 못했습니다.");
    expect(within(navigation).getByRole("link", { name: "더보기" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(navigation).queryByRole("link", { name: "관리" })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "설정" })).not.toBeInTheDocument();
  });

  it("marks only the schedule tab current when it is the teacher's third tab", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=synthetic");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ items: [] })),
    );
    // 투표·선거 권한이 없어 반 활동이 숨고, 출결도 꺼져 셋째 칸이 일정이다(T-TEACHER-TAB-ACTIVE).
    rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), {
      allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS"],
      current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
    } as never);
    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <AppShell navigationRole="teacher" attendanceNotificationsEnabled={false}>
          <p>일정</p>
        </AppShell>
      </MemoryRouter>,
    );

    const navigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-bottom"]',
    );
    if (navigation === null) throw new Error("교사 하단 내비게이션을 찾지 못했습니다.");
    await waitFor(() =>
      expect(within(navigation).getByRole("link", { name: "일정" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("marks only the meals tab current when it is the student's fourth tab", async () => {
    // 출결·반 활동이 모두 꺼져 학생 넷째 칸이 급식이다(T-TEACHER-TAB-ACTIVE 학생 쪽).
    rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), {
      allowed_actions: ["VIEW_CLASS"],
      current_membership: { class_id: "1", id: "2", role: "student", status: "approved" },
    } as never);
    render(
      <MemoryRouter initialEntries={["/meals"]}>
        <AppShell navigationRole="student" attendanceNotificationsEnabled={false}>
          <p>급식</p>
        </AppShell>
      </MemoryRouter>,
    );

    const navigation = document.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="student-bottom"]',
    );
    if (navigation === null) throw new Error("학생 하단 내비게이션을 찾지 못했습니다.");
    await waitFor(() =>
      expect(within(navigation).getByRole("link", { name: "급식" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });
});

describe("학생 준비물·숙제의 독립된 PC 진입", () => {
  it.each(["/supplies", "/supplies/37"])(
    "%s에서 PC 생활정보만 선택하고 모바일5탭·소식 분류를 유지한다",
    (path) => {
      const { container } = render(
        <MemoryRouter initialEntries={[path]}>
          <AppShell navigationRole="student" attendanceNotificationsEnabled={false}>
            <p>본문</p>
          </AppShell>
        </MemoryRouter>,
      );
      const desktop = container.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="student-desktop"]',
      )!;
      const bottom = container.querySelector<HTMLElement>(
        '[data-primary-navigation-layout="student-bottom"]',
      )!;
      expect(within(desktop).getByRole("link", { name: "준비물·숙제" })).toHaveAttribute(
        "href",
        "/supplies",
      );
      expect(within(desktop).getByRole("link", { name: "준비물·숙제" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(desktop.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(within(desktop).getByRole("link", { name: "소식" })).not.toHaveAttribute(
        "aria-current",
      );
      expect(
        desktop.querySelector('[data-navigation-group="생활 정보"]')?.nextElementSibling
          ?.textContent,
      ).toContain("준비물·숙제");
      expect(within(bottom).getAllByRole("link")).toHaveLength(5);
      expect(within(bottom).getByRole("link", { name: "소식" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(within(bottom).queryByRole("link", { name: "준비물·숙제" })).not.toBeInTheDocument();
    },
  );
  it("교사 메뉴는 기존 소식 분류를 유지한다", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/supplies/37"]}>
        <AppShell navigationRole="teacher" attendanceNotificationsEnabled={false}>
          <p>본문</p>
        </AppShell>
      </MemoryRouter>,
    );
    const desktop = container.querySelector<HTMLElement>(
      '[data-primary-navigation-layout="teacher-desktop"]',
    )!;
    expect(within(desktop).queryByRole("link", { name: "준비물·숙제" })).not.toBeInTheDocument();
    expect(within(desktop).getByRole("link", { name: "소식" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
