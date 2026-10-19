import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { HomePage } from "./home-page";

const emptyHomePayload = {
  meal: { data: null, status: "empty" },
  notices: { data: [], status: "empty" },
  pending_member_count: 0,
  reminders: { data: [], status: "empty" },
  schedules: { data: [], status: "empty" },
  server_today: "2026-07-11",
  supplies: { data: [], status: "empty" },
  teacher_followups: { data: [], status: "empty" },
} as unknown as HomeResponse;

const teacherBootstrapPayload = {
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
  server_today: "2026-07-11",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const studentBootstrapPayload = {
  ...teacherBootstrapPayload,
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
  current_membership: {
    class_id: "1",
    id: "2",
    role: "student",
    status: "approved",
  },
  teacher_profile: null,
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockHomeRequests(bootstrap: unknown, home: unknown): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrap));
    if (url === "/api/v1/home") return Promise.resolve(jsonResponse(home));
    if (url === "/api/v1/help-requests?status=open") {
      return Promise.resolve(jsonResponse({ items: [] }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe("HomePage visual language", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-13T03:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the teacher task-first hierarchy without the legacy four-card grid", async () => {
    mockHomeRequests(teacherBootstrapPayload, emptyHomePayload);

    const { container } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "우리반 허브" })).toBeVisible();
    expect(container.querySelector("[data-teacher-home]")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-teacher-home-section]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-home-card]")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "오늘 출결 연락" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "출결 연락 상세 보기" })).not.toBeInTheDocument();

    // 2026-09-27 A안: 소식 흐름 + 처리할 일 + 오늘 정보. 옛 다음 할 일·한눈에 보기는 없다.
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "처리할 일" })).toHaveTextContent(
        "처리할 일이 없어요.",
      );
    });
    expect(screen.queryByRole("heading", { name: "다음 할 일" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "한눈에 보기" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "오늘 정보" })).toBeVisible();
    const feed = screen.getByRole("region", { name: "우리반 소식" });
    expect(within(feed).getByText("새 소식이 없어요.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "소식 작성" })).not.toBeInTheDocument();
    expect(within(feed).getByRole("link", { name: "전체" })).toHaveAttribute("href", "/updates");
    expect(screen.queryByRole("link", { name: "공지 작성" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "준비물 작성" })).not.toBeInTheDocument();

    for (const copy of ["오늘 등록된 급식이 없어요.", "아직 공지가 없어요."]) {
      expect(screen.getByText(copy)).toBeInTheDocument();
    }

    expect(screen.getByText("7월 11일 토요일")).toHaveAttribute("datetime", "2026-07-11");
    expect(screen.getByRole("group", { name: "홈 도구" })).toBeVisible();
    expect(screen.getByRole("link", { name: "반 관리" })).toHaveAttribute("href", "/class/manage");
    expect(screen.getByRole("link", { name: "더보기" })).toHaveAttribute("href", "/more");
  });

  it("shows approval and unresolved follow-ups while choosing the latest delivery by time", async () => {
    mockHomeRequests(teacherBootstrapPayload, {
      ...emptyHomePayload,
      notices: {
        data: [
          {
            content_revision: "1",
            id: "notice-1",
            is_important: true,
            published_at: "2026-07-11T01:00:00.000Z",
            title: "오래된 중요 공지",
          },
          {
            content_revision: "1",
            id: "notice-2",
            is_important: false,
            published_at: "2026-07-11T05:00:00.000Z",
            title: "가장 최근 공지",
          },
        ],
        status: "ok",
      },
      pending_member_count: 2,
      teacher_followups: {
        data: [
          {
            content_revision: "1",
            counts: { confirmed: 1, modified_unconfirmed: 1, unread: 2 },
            is_important: true,
            last_reminder_requested_at: null,
            published_at: "2026-07-11T01:00:00.000Z",
            resource_id: "notice-1",
            resource_type: "notice",
            title: "확인이 필요한 공지",
          },
        ],
        status: "ok",
      },
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    const tasks = await screen.findByRole("region", { name: "처리할 일" });
    expect(within(tasks).getByRole("link", { name: /가입 요청\s*2/u })).toHaveAttribute(
      "href",
      "/members/manage",
    );
    // 미해결 인원은 소식 카드의 확인 막대로(확인 1 · 미확인 2 · 바뀐 뒤 미확인 1).
    const feed = screen.getByRole("region", { name: "우리반 소식" });
    const notice = within(feed).getByText("오래된 중요 공지").closest("a") as HTMLElement;
    expect(within(notice).getByText("3명 남음")).toBeVisible();

    const today = screen.getByRole("region", { name: "오늘 정보" });
    expect(within(today).getByText("가장 최근 공지")).toBeVisible();
    expect(within(today).queryByText("오래된 중요 공지")).not.toBeInTheDocument();
  });

  it("puts real and actionable content before compact empty cards", async () => {
    mockHomeRequests(studentBootstrapPayload, {
      ...emptyHomePayload,
      attendance: { data: null, status: "empty" },
      notices: {
        data: [
          {
            confirmation_state: "unread",
            content_revision: "1",
            id: "notice-action",
            is_important: true,
            published_at: "2026-07-11T01:00:00.000Z",
            title: "오늘 꼭 확인할 공지",
          },
        ],
        status: "ok",
      },
      pending_member_count: null,
      schedules: {
        data: [
          {
            d_day_label: "D-Day",
            days_until: 0,
            due_date: "2026-07-11",
            id: "schedule-today",
            schedule_type: "other",
            subject: null,
            title: "오늘 제출",
          },
        ],
        status: "ok",
      },
    } satisfies HomeResponse);

    const { container } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    // 2026-09-27 시안: 확인 안 한 중요 공지는 칠판 맨 위와 우리반 소식에 함께 보인다.
    const chalkboard = await screen.findByRole("region", { name: "우리반 칠판" });
    expect(within(chalkboard).getByText("오늘 꼭 확인할 공지")).toBeVisible();
    const feed = container.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    expect(within(feed).getByText("오늘 꼭 확인할 공지")).toBeVisible();
    // 2026-10-02 사용자 결정: 칠판 → 우리반 소식 → 오늘 정보(교사 홈과 같은 순서).
    const today = container.querySelector('[data-home-today-section="student"]') as HTMLElement;
    expect(feed.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[data-home-card]")).toBeNull();
    expect(screen.queryByRole("region", { name: "다시 확인 요청" })).not.toBeInTheDocument();
    expect(within(today).getByText("오늘 제출")).toBeVisible();
    expect(within(feed).getByRole("link", { name: "전체" })).toHaveAttribute("href", "/updates");
  });

  it("keeps the same cards for a student while rendering role-safe content", async () => {
    mockHomeRequests(studentBootstrapPayload, {
      attendance: { data: null, status: "empty" },
      notices: {
        data: [
          {
            confirmation_state: "confirmed",
            content_revision: "1",
            id: "notice-important",
            is_important: true,
            published_at: "2026-07-10T23:30:00.000Z",
            title: "시험 범위 안내",
          },
          {
            confirmation_state: "unread",
            content_revision: "1",
            id: "notice-latest",
            is_important: false,
            published_at: "2026-07-11T01:00:00.000Z",
            title: "동아리 안내",
          },
        ],
        status: "ok",
      },
      meal: {
        data: {
          calorie_kcal: null,
          id: "meal-1",
          meal_date: "2026-07-11",
          menu: [{ allergens: ["1"], name: "비빔밥" }],
          source: "seed",
          source_loaded_on: null,
          source_updated_at: "2026-07-11T01:00:00.000Z",
        },
        status: "ok",
      },
      pending_member_count: null,
      reminders: {
        data: [
          {
            reminder_type: "notice",
            requested_at: "2026-07-11T02:30:00.000Z",
            resource_id: "notice-reminder-1",
            title: "가정통신문 다시 확인",
          },
          {
            reminder_type: "supply",
            requested_at: "2026-07-11T02:00:00.000Z",
            resource_id: "supply-reminder-1",
            title: "체육복 다시 확인",
          },
          {
            reminder_type: "notice",
            requested_at: "2026-07-11T01:30:00.000Z",
            resource_id: "notice-reminder-2",
            title: "동의서 다시 확인",
          },
        ],
        status: "ok",
      },
      schedules: {
        data: [
          {
            d_day_label: "D-1",
            days_until: 1,
            due_date: "2026-07-12",
            id: "schedule-1",
            schedule_type: "exam",
            subject: "수학",
            title: "수학 수행평가",
          },
        ],
        status: "ok",
      },
      server_today: "2026-07-11",
      supplies: {
        data: [
          {
            check_state: "checked",
            content_revision: "1",
            description: null,
            id: "supply-1",
            needed_on: "2026-07-11",
            title: "미술 준비물",
          },
        ],
        status: "ok",
      },
    });

    const { container } = render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("학생 홈")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "우리반 허브" });
    expect(heading.closest("[data-home-hero-role]")).toHaveAttribute(
      "data-home-hero-role",
      "student",
    );
    expect(screen.getByText("테스트 1반")).toHaveClass("break-words");
    expect(screen.queryByRole("link", { name: "학생 설정" })).not.toBeInTheDocument();
    expect(screen.queryByText(/오늘 챙길 일이/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/미확인 공지 1건/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/챙길 준비물 0건/u)).not.toBeInTheDocument();
    expect(container.querySelector('[data-home-today-section="student"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /학생 관리/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /반 관리/u })).not.toBeInTheDocument();

    const accountLink = screen.getByRole("link", { name: /내 계정학생/u });
    expect(accountLink).toHaveAttribute("href", "/settings");

    expect(screen.getAllByText("비빔밥")).toHaveLength(1);
    // 2026-09-27 A안: 재알림은 우리반 소식 맨 앞에 '선생님 재알림'으로 모두 모이고,
    // 최근 공지·챙긴 준비물도 확인 상태와 함께 이어진다.
    const feed = container.querySelector<HTMLElement>(
      '[data-home-news-feed="student"]',
    ) as HTMLElement;
    const links = within(feed)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(links.slice(0, 4)).toEqual([
      "/updates",
      "/notices/notice-reminder-1",
      "/supplies/supply-reminder-1",
      "/notices/notice-reminder-2",
    ]);
    expect(within(feed).getAllByText("선생님 재알림")).toHaveLength(3);
    const latest = within(feed).getByText("동아리 안내").closest("a") as HTMLElement;
    expect(within(latest).getByText("아직 확인 전")).toBeVisible();
    const supply = within(feed).getByText("미술 준비물").closest("a") as HTMLElement;
    expect(within(supply).getByText("챙겼어요")).toBeVisible();
    for (const link of screen.getAllByRole("link", { name: /수학 수행평가/u })) {
      expect(link).toHaveAttribute("href", "/schedules/schedule-1");
    }

    // 가까운 일정은 교사 오늘 정보와 같은 줄: 제목 + D-day 표시.
    const today = container.querySelector('[data-home-today-section="student"]') as HTMLElement;
    expect(within(today).getByText("D-1")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText("우리반 허브").length).toBeGreaterThan(0);
    });
  });

  it.each([360, 390, 1440])("keeps every student reminder reachable at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    mockHomeRequests(studentBootstrapPayload, {
      ...emptyHomePayload,
      pending_member_count: null,
      reminders: {
        data: [
          {
            reminder_type: "notice",
            requested_at: "2026-07-11T02:30:00.000Z",
            resource_id: "notice-long",
            title: "아주 긴 한국어 공지 제목도 줄바꿈되어 모두 보여야 해요",
          },
        ],
        status: "ok",
      },
    } satisfies HomeResponse);

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <HomePage />
      </MemoryRouter>,
    );

    await screen.findByText("아주 긴 한국어 공지 제목도 줄바꿈되어 모두 보여야 해요");
    const feed = document.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    const title = within(feed).getByText("아주 긴 한국어 공지 제목도 줄바꿈되어 모두 보여야 해요");
    expect(title.closest("a")).toHaveAccessibleName(
      expect.stringContaining("아주 긴 한국어 공지 제목도 줄바꿈되어 모두 보여야 해요"),
    );
    expect(title.closest("a")).toHaveAttribute("href", "/notices/notice-long");
  });
});
