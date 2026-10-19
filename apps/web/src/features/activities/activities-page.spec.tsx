import { ContentFrameHeader } from "../layout/content-frame";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivitiesPage } from "./activities-page";

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
    server_today: "2026-08-26",
    teacher_profile:
      role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
  };
}

function mockBootstrap(body: object): void {
  mockFeatureFetch().mockResolvedValue(jsonResponse(body));
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestPath(input: RequestInfo | URL): string {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(value, "http://localhost");
  return `${url.pathname}${url.search}`;
}

// 실제 SystemStateBanner는 유지하고, 공개 상태 조회만 API 계약대로 따로 응답한다.
// 일회성 화면 API 응답과 호출 횟수는 공개 상태 조회가 소비하지 않는다.
function mockFeatureFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const featureFetch = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (requestPath(input) === "/api/v1/public/system-state") {
      return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
    }
    return featureFetch(input, init);
  });
  return featureFetch;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/activities"]}>
      <Routes>
        <Route element={<ActivitiesPage />} path="/activities" />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ActivitiesPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows polls and elections without retired features even when old bootstrap permits them", async () => {
    const bootstrap = bootstrapFixture("teacher", [
      "VIEW_CLASS",
      "MANAGE_POLLS",
      "MANAGE_ELECTIONS",
      "MANAGE_SEAT_DRAWS",
      "MANAGE_TEAM_DRAWS",
      "MANAGE_DUTY_ROSTERS",
    ]);
    const fetchMock = mockFeatureFetch().mockImplementation(async (input) => {
      switch (requestPath(input)) {
        case "/api/v1/bootstrap":
          return jsonResponse(bootstrap);
        case "/api/v1/polls?scope=open":
          return jsonResponse({
            items: [{ closes_at: "2026-08-30T16:00:00Z", title: "자리 이동 순서" }],
            next_cursor: null,
            scope: "open",
            server_now: "2026-08-29T00:00:00Z",
          });
        case "/api/v1/elections":
          return jsonResponse({
            items: [
              {
                opened_at: "2026-08-29T01:00:00Z",
                published_at: null,
                status: "open",
                title: "2학기 회장 선거",
              },
            ],
          });
        default:
          return jsonResponse({ detail: "unexpected request" }, 500);
      }
    });
    renderPage();

    await screen.findByRole("button", { name: "반 활동 현황 새로고침" });
    expect(screen.getByRole("heading", { level: 1, name: "반 활동" })).toBeVisible();
    expect(document.querySelector(".content-frame-header")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "반 활동" }),
    );
    expect(screen.getByRole("heading", { name: "투표" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "대표 선거" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "자리와 모둠" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "이번 주 당번" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "당번표" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /투표 현황 보기/u })).toHaveAttribute("href", "/polls");
    expect(screen.getByRole("link", { name: /선거 목록 보기/u })).toHaveAttribute(
      "href",
      "/elections",
    );
    for (const path of ["/seating", "/grouping", "/duty"])
      expect(document.querySelector(`a[href="${path}"]`)).not.toBeInTheDocument();
    expect(await screen.findByText("자리 이동 순서")).toBeVisible();
    expect(screen.getByText("1건 진행 중")).toBeVisible();
    expect(screen.getByText("마감 2026.08.31")).toBeVisible();
    expect(screen.getByText("2학기 회장 선거")).toBeVisible();
    expect(document.querySelectorAll('[data-activity-summary="ready"]')).toHaveLength(2);
    // 열린 도움 요청 수는 담임 확인(bootstrap) 뒤에 따로 묻는다.
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => requestPath(input)).sort()).toEqual([
        "/api/v1/bootstrap",
        "/api/v1/elections",
        "/api/v1/help-requests?status=open",
        "/api/v1/polls?scope=open",
      ]),
    );
    for (const navigation of screen.getAllByRole("navigation", { name: "주요 메뉴" })) {
      expect(within(navigation).getByRole("link", { name: "반 활동" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });

  it("shows students permitted polls while ignoring retired capabilities", async () => {
    mockBootstrap(
      bootstrapFixture("student", ["VIEW_CLASS", "VOTE_IN_POLLS", "VIEW_DUTY_ROSTERS"]),
    );
    renderPage();

    expect(await screen.findByRole("link", { name: /참여할 투표 보기/u })).toHaveAttribute(
      "href",
      "/polls",
    );
    expect(screen.queryByRole("link", { name: /내 당번 보기/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /선거 목록 보기/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /내 자리 보기/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /내 모둠 보기/u })).not.toBeInTheDocument();
  });

  it("uses an explicit safe state when every activity feature is disabled", async () => {
    mockBootstrap(
      bootstrapFixture("student", [
        "VIEW_CLASS",
        "VIEW_SEAT_DRAWS",
        "VIEW_TEAM_DRAWS",
        "VIEW_DUTY_ROSTERS",
      ]),
    );
    renderPage();

    expect(await screen.findByText("지금 사용할 수 있는 반 활동이 없어요.")).toBeVisible();
    expect(document.querySelector("[data-activity-dashboard-card]")).not.toBeInTheDocument();
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([input]) => requestPath(input) !== "/api/v1/public/system-state"),
    ).toHaveLength(1);
  });

  it("keeps the activity destination usable when a live summary request fails", async () => {
    const bootstrap = bootstrapFixture("teacher", ["VIEW_CLASS", "MANAGE_POLLS"]);
    mockFeatureFetch().mockImplementation(async (input) =>
      requestPath(input) === "/api/v1/bootstrap"
        ? jsonResponse(bootstrap)
        : jsonResponse({ detail: "temporarily unavailable" }, 503),
    );
    renderPage();

    expect(await screen.findByText("현황을 불러오지 못했어요")).toBeVisible();
    expect(document.querySelector('[data-activity-summary="error"]')).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /투표 현황 보기/u })).toHaveAttribute("href", "/polls");
  });
});

describe("activity request lifetime and expired session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });
  it("clears stored authenticated state and redirects without waiting for a sibling summary", async () => {
    window.sessionStorage.setItem("classhub:idempotent-create:poll", "private");
    let resolveElection!: (response: Response) => void;
    const election = new Promise<Response>((resolve) => {
      resolveElection = resolve;
    });
    mockFeatureFetch().mockImplementation(async (input) => {
      const path = requestPath(input);
      if (path === "/api/v1/bootstrap")
        return jsonResponse(
          bootstrapFixture("teacher", ["VIEW_CLASS", "MANAGE_POLLS", "MANAGE_ELECTIONS"]),
        );
      if (path === "/api/v1/elections") return election;
      return jsonResponse({ detail: "expired" }, 401);
    });
    renderPage();
    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:idempotent-create:poll")).toBeNull();
    await act(async () => {
      resolveElection(jsonResponse({ items: [] }));
    });
    expect(screen.getByText("로그인 화면")).toBeVisible();
    expect(screen.queryByText("반 활동")).not.toBeInTheDocument();
  });
  for (const stage of ["bootstrap", "summary"] as const)
    it("ignores late 401 after leaving during " + stage, async () => {
      let resolveRequest!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
      window.sessionStorage.setItem("classhub:idempotent-create:poll", "keep");
      mockFeatureFetch().mockImplementation(async (input) => {
        if (requestPath(input) === "/api/v1/bootstrap")
          return stage === "bootstrap"
            ? pending
            : jsonResponse(bootstrapFixture("student", ["VIEW_CLASS", "VOTE_IN_POLLS"]));
        return pending;
      });
      render(
        <MemoryRouter initialEntries={["/activities"]}>
          <Link to="/elsewhere">페이지 나가기</Link>
          <Routes>
            <Route path="/activities" element={<ActivitiesPage />} />
            <Route path="/elsewhere" element={<p>다른 화면</p>} />
            <Route path="/login" element={<p>로그인 화면</p>} />
          </Routes>
        </MemoryRouter>,
      );
      if (stage === "summary") await screen.findByRole("button", { name: "반 활동 현황 새로고침" });
      fireEvent.click(screen.getByText("페이지 나가기"));
      expect(await screen.findByText("다른 화면")).toBeVisible();
      await act(async () => {
        resolveRequest(jsonResponse({ detail: "expired" }, 401));
      });
      expect(window.sessionStorage.getItem("classhub:idempotent-create:poll")).toBe("keep");
      expect(screen.getByText("다른 화면")).toBeVisible();
      expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    });
  it("clears authenticated state when bootstrap expires", async () => {
    window.sessionStorage.setItem("classhub:idempotent-create:poll", "private");
    mockFeatureFetch().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    renderPage();
    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:idempotent-create:poll")).toBeNull();
  });
});

describe("mobile header compact scope", () => {
  it("keeps title and actionable tools together without reserving a filter row", () => {
    render(<ContentFrameHeader title="반 활동" actions={<button>현황 새로고침</button>} />);
    const header = screen.getByRole("banner");
    expect(header.classList.contains("content-frame-header-title-only")).toBe(true);
    expect(screen.getByRole("heading", { name: "반 활동" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "현황 새로고침" }).closest(".content-frame-heading"),
    ).toBeTruthy();
  });
  it.each(["description", "filters"])("protects the existing extra row for %s", (kind) => {
    render(
      <ContentFrameHeader title="급식">
        {kind === "description" ? (
          <p>설명</p>
        ) : (
          <div role="tablist">
            <button role="tab">월간</button>
          </div>
        )}
      </ContentFrameHeader>,
    );
    expect(screen.getByRole("banner").classList.contains("content-frame-header-title-only")).toBe(
      false,
    );
    expect(
      kind === "description" ? screen.getByText("설명") : screen.getByRole("tablist"),
    ).toBeTruthy();
  });
  it("does not reserve a filter row for conditional content that renders nothing", () => {
    render(
      <ContentFrameHeader title="반 활동">
        {false}
        {null}
        {undefined}
      </ContentFrameHeader>,
    );
    expect(screen.getByRole("banner").classList.contains("content-frame-header-title-only")).toBe(
      true,
    );
  });
});
