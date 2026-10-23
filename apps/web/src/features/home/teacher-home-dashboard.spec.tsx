import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { listHelpRequests } from "../../api/help-requests";
import { TeacherHomeDashboard } from "./teacher-home-dashboard";

vi.mock("../../api/help-requests", () => ({ listHelpRequests: vi.fn() }));

it("warns about retained home data before the teacher can act on the chalkboard", async () => {
  vi.mocked(listHelpRequests).mockResolvedValue([]);
  render(
    <MemoryRouter>
      <TeacherHomeDashboard
        className="테스트 1반"
        error={undefined}
        home={homePayload()}
        loadFailed
        loading={false}
        loggingOut={false}
        onLogout={vi.fn()}
        onReload={vi.fn()}
      />
    </MemoryRouter>,
  );
  await act(async () => {});
  const warning = screen.getByText("최신 홈 정보를 확인하지 못했어요.");
  const board = screen.getByRole("region", { name: "우리반 칠판" });
  expect(warning.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

function homePayload(overrides: Record<string, unknown> = {}): HomeResponse {
  return {
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
    meal: {
      data: {
        calorie_kcal: 803.4,
        id: "meal-1",
        meal_date: "2026-07-25",
        menu: [
          { allergens: [], name: "현미밥" },
          { allergens: [], name: "달걀국" },
          { allergens: [], name: "김치" },
        ],
        source: "seed",
        source_loaded_on: null,
        source_updated_at: "2026-07-25T01:00:00.000Z",
      },
      status: "ok",
    },
    notices: {
      data: [
        {
          content_revision: "notice-r1",
          id: "notice-1",
          is_important: true,
          published_at: "2026-07-23T10:15:00+09:00",
          title: "먼저 정렬된 중요 공지",
        },
        {
          content_revision: "notice-r2",
          id: "notice-2",
          is_important: false,
          published_at: "2026-07-24T10:15:00+09:00",
          title: "시간상 가장 최근 공지",
        },
      ],
      status: "ok",
    },
    pending_member_count: 2,
    reminders: { data: [], status: "empty" },
    schedules: {
      data: [
        {
          d_day_label: "D-1",
          days_until: 1,
          due_date: "2026-07-26",
          id: "schedule-1",
          schedule_type: "assignment",
          subject: "국어",
          title: "합성 과제 일정",
        },
      ],
      status: "ok",
    },
    server_today: "2026-07-25",
    supplies: { data: [], status: "empty" },
    teacher_followups: null,
    ...overrides,
  } as unknown as HomeResponse;
}

function renderDashboard(
  home: HomeResponse,
  callbacks: {
    onLogout?: () => void;
    onReload?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <TeacherHomeDashboard
        className="테스트 1반"
        error={undefined}
        home={home}
        loadFailed={false}
        loading={false}
        loggingOut={false}
        onLogout={callbacks.onLogout ?? vi.fn()}
        onReload={callbacks.onReload ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("TeacherHomeDashboard", () => {
  it.each(["notices", "supplies"] as const)(
    "does not claim an empty chalkboard when %s could not be loaded",
    (failed) => {
      const home = {
        ...homePayload(),
        notices: { data: [], status: "empty" as const },
        supplies: { data: [], status: "empty" as const },
        [failed]: {
          data: [],
          status: "error",
          error_code: "SYNTHETIC_FAILURE",
          message: "private synthetic detail",
        },
      } as HomeResponse;
      renderDashboard(home);
      const chalk = screen.getByRole("region", { name: "우리반 칠판" });
      expect(
        within(chalk).getByText(
          "칠판 안내를 모두 확인하지 못했어요. 아래 소식에서 다시 확인해 주세요.",
        ),
      ).toBeVisible();
      expect(
        within(chalk).queryByText("칠판이 비어 있어요. 반에 알릴 것을 적어 보세요"),
      ).not.toBeInTheDocument();
      expect(within(chalk).queryByText("private synthetic detail")).not.toBeInTheDocument();
    },
  );

  beforeEach(() => {
    vi.mocked(listHelpRequests).mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts open student help requests in the task list", async () => {
    vi.mocked(listHelpRequests).mockResolvedValue([{ id: "7" }, { id: "8" }] as Awaited<
      ReturnType<typeof listHelpRequests>
    >);
    // 요청마다 새 응답을 준다 — 응답 본문은 한 번만 읽힌다(도움 요청·지난 반 두 요청).
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input instanceof Request ? input.url : input).includes("/past-classes")
              ? { items: [] }
              : { items: [{ id: "7" }, { id: "8" }] },
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        ),
    );
    renderDashboard(homePayload({ pending_member_count: 1 }));

    const strip = await screen.findByRole("navigation", { name: "처리할 일" });
    await waitFor(() =>
      expect(within(strip).getByRole("link", { name: "도움 요청2건" })).toHaveAttribute(
        "href",
        "/help-requests",
      ),
    );
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "도움 요청 2건" })).toBeVisible();
  });

  it("keeps retired placement and duty features out of Home", () => {
    renderDashboard(homePayload());

    expect(screen.queryByRole("link", { name: /자리.*배치/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /모둠.*배치/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /당번/u })).not.toBeInTheDocument();
  });

  it("puts the chalkboard, news feed, tasks, and today info in the mockup layout", () => {
    const home = homePayload({
      attendance: {
        data: {
          absent: 0,
          acknowledged: 0,
          early: 0,
          late: 2,
          pending: 2,
          total: 2,
        },
        status: "ok",
      },
      teacher_followups: {
        data: [
          {
            content_revision: "notice-r1",
            counts: { confirmed: 1, modified_unconfirmed: 1, unread: 2 },
            is_important: true,
            last_reminder_requested_at: null,
            published_at: "2026-07-24T10:15:00+09:00",
            resource_id: "notice-1",
            resource_type: "notice",
            title: "확인이 필요한 공지",
          },
          {
            content_revision: "supply-r1",
            counts: { checked: 1, modified_unconfirmed: 1, unchecked: 1 },
            last_reminder_requested_at: "2026-07-25T08:00:00+09:00",
            needed_on: "2026-07-26",
            resource_id: "supply-1",
            resource_type: "supply",
            title: "챙김 확인이 필요한 준비물",
          },
        ],
        status: "ok",
      },
    });

    renderDashboard(home);

    const heading = screen.getByRole("heading", { level: 1, name: "우리반 허브" });
    const header = document.querySelector('[data-teacher-home-header="true"]');
    expect(header).toBeInTheDocument();
    // 다른 탭과 같은 공통 제목 줄을 쓰고, 제목 앞에 로고를 따로 두지 않는다(2026-09-28).
    expect(header?.querySelector('[data-home-wordmark] img[src="/brand/symbol.svg"]')).toBeNull();
    expect(heading).toBeVisible();
    expect(heading.closest(".content-frame-heading")).not.toBeNull();
    expect(
      within(screen.getByRole("group", { name: "홈 상단 메뉴" })).getByText("테스트 1반"),
    ).toBeVisible();
    const chalkboard = within(header as HTMLElement).getByRole("region", { name: "우리반 칠판" });
    const date = within(chalkboard).getByText("7월 25일 토요일");
    expect(date).toHaveAttribute("datetime", "2026-07-25");
    expect(within(chalkboard).getByRole("link", { name: "칠판에 쓰기" })).toHaveAttribute(
      "href",
      "/updates?create=notice",
    );
    // 2026-10-22 사용자 A안: 학생 칠판은 일반 공지를 올리지 않으므로 '아직 안 본 것만'이라 하지 않는다.
    expect(
      within(chalkboard).getByText("학생 칠판에는 중요·바뀐 공지와 안 챙긴 준비물만 올라가요"),
    ).toBeVisible();
    expect(within(chalkboard).queryByText(/아직 안 본 것만/u)).not.toBeInTheDocument();

    // 2026-09-27 A안: 옛 업무 흐름·한눈에 보기 대신 소식 흐름(왼쪽)과 처리할 일·오늘 정보(오른쪽).
    expect(screen.queryByRole("region", { name: "한눈에 보기" })).not.toBeInTheDocument();
    const feed = document.querySelector('[data-home-news-feed="teacher"]') as HTMLElement;
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    const today = screen.getByRole("region", { name: "오늘 정보" });
    expect(feed.parentElement).toHaveClass(
      "grid",
      "xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.8fr)]",
    );
    expect(feed.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 확인 인원은 소식 카드의 막대로(확인 1 · 미확인 2 · 바뀐 뒤 미확인 1).
    const notice = within(feed).getByText("먼저 정렬된 중요 공지").closest("a") as HTMLElement;
    expect(notice).toHaveAttribute("href", "/notices/notice-1");
    expect(within(notice).getByText("3명 남음")).toBeVisible();
    // 출결 미확인·가입 대기는 처리할 일로(좁은 화면은 칠판 아래 띠, 넓은 화면은 오른쪽 칸).
    expect(
      within(screen.getByRole("navigation", { name: "처리할 일" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/attendance", "/members/manage", "/help-requests", "/updates/followups"]);
    expect(within(panel).getByRole("link", { name: "출결 확인 2건" })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(screen.queryByRole("link", { name: "소식 작성" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "학생 목록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "반 관리" })).not.toBeInTheDocument();

    expect(today).toHaveClass("teacher-home-today-surface", "xl:flex-1");
    expect(within(today).getByText("현미밥 · 달걀국")).toBeVisible();
    expect(within(today).getByText("학교 연동 정보 없음")).toBeVisible();
    expect(within(today).getByText("시간상 가장 최근 공지")).toBeVisible();
    expect(within(today).queryByText("먼저 정렬된 중요 공지")).not.toBeInTheDocument();
    const todayItems = within(today).getAllByRole("listitem");
    expect(todayItems).toHaveLength(3);
    expect(within(todayItems[0]!).getByText("최근 전달")).toBeVisible();
    expect(within(todayItems[1]!).getByText("오늘 급식")).toBeVisible();
    // 서버가 보내던 home.schedules를 화면이 버려서 교사가 일정 확인에 화면 전환을
    // 한 번 더 해야 했다(2026-08-05 실측 D31). 가장 가까운 한 건만 노출한다.
    expect(within(todayItems[2]!).getByText("가까운 일정")).toBeVisible();
    expect(within(todayItems[2]!).getByText("합성 과제 일정")).toBeVisible();
    expect(within(todayItems[2]!).getByText("D-1")).toBeVisible();
  });

  it("keeps refresh and logout available without mixing them with the primary quick actions", async () => {
    const onLogout = vi.fn();
    const onReload = vi.fn();
    renderDashboard(
      homePayload({
        pending_member_count: 0,
        teacher_followups: { data: [], status: "empty" },
      }),
      { onLogout, onReload },
    );

    const tools = screen.getByRole("group", { name: "홈 도구" });
    fireEvent.click(within(tools).getByRole("button", { name: "홈 새로고침" }));
    fireEvent.click(within(tools).getByRole("button", { name: "로그아웃" }));

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(await within(panel).findByText("처리할 일이 없어요.")).toBeVisible();
    const strip = screen.getByRole("navigation", { name: "처리할 일" });
    for (const surface of [strip, panel]) {
      const entry = within(surface).getByRole("link", { name: "기간별 확인 현황" });
      expect(entry).toHaveAttribute("href", "/updates/followups");
      expect(entry).toHaveClass("min-h-11");
      entry.focus();
      expect(entry).toHaveFocus();
    }
  });

  it("keeps the help list available on initial failure without claiming no work", async () => {
    vi.mocked(listHelpRequests).mockRejectedValue(new Error("offline"));
    renderDashboard(homePayload({ pending_member_count: 0 }));
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(within(panel).getByText("도움 요청 확인 중…")).toBeVisible();
    expect(
      await within(panel).findByRole("link", { name: "도움 요청 수 확인 불가 · 목록 보기" }),
    ).toHaveAttribute("href", "/help-requests");
    expect(within(panel).queryByText("처리할 일이 없어요.")).not.toBeInTheDocument();
  });

  it("clears old help counts during refresh and after refresh failure", async () => {
    vi.mocked(listHelpRequests)
      .mockResolvedValueOnce([{ id: "7" }] as Awaited<ReturnType<typeof listHelpRequests>>)
      .mockRejectedValueOnce(new Error("offline"));
    const firstHome = homePayload({ pending_member_count: 0 });
    const result = renderDashboard(firstHome);
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(await within(panel).findByRole("link", { name: "도움 요청 1건" })).toBeVisible();
    result.rerender(
      <MemoryRouter>
        <TeacherHomeDashboard
          className="테스트 1반"
          error={undefined}
          home={{ ...firstHome }}
          loadFailed={false}
          loading={false}
          loggingOut={false}
          onLogout={vi.fn()}
          onReload={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(within(panel).queryByRole("link", { name: "도움 요청 1건" })).not.toBeInTheDocument();
    expect(
      await within(panel).findByRole("link", { name: "도움 요청 수 확인 불가 · 목록 보기" }),
    ).toBeVisible();
    expect(within(panel).queryByText("처리할 일이 없어요.")).not.toBeInTheDocument();
  });

  it("ignores an old request after switching the class and home", async () => {
    let resolveOld!: (items: Awaited<ReturnType<typeof listHelpRequests>>) => void;
    vi.mocked(listHelpRequests)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const firstHome = homePayload({ pending_member_count: 0 });
    const result = renderDashboard(firstHome);
    result.rerender(
      <MemoryRouter>
        <TeacherHomeDashboard
          className="다른 반"
          error={undefined}
          home={{ ...firstHome }}
          loadFailed={false}
          loading={false}
          loggingOut={false}
          onLogout={vi.fn()}
          onReload={vi.fn()}
        />
      </MemoryRouter>,
    );
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(await within(panel).findByText("처리할 일이 없어요.")).toBeVisible();
    await act(async () =>
      resolveOld([{ id: "old" }] as Awaited<ReturnType<typeof listHelpRequests>>),
    );
    expect(within(panel).queryByRole("link", { name: "도움 요청 1건" })).not.toBeInTheDocument();
    expect(within(panel).getByText("처리할 일이 없어요.")).toBeVisible();
  });

  it("keeps the write path on the chalkboard when the class has no news yet", () => {
    renderDashboard(
      homePayload({
        notices: { data: [], status: "ok" },
        pending_member_count: 2,
        teacher_followups: { data: [], status: "empty" },
      }),
    );

    const feed = document.querySelector('[data-home-news-feed="teacher"]') as HTMLElement;
    expect(within(feed).getByText("새 소식이 없어요.")).toBeVisible();
    expect(screen.getByRole("link", { name: "칠판에 쓰기" })).toHaveAttribute(
      "href",
      "/updates?create=notice",
    );
    // 실제 처리할 일(가입 대기)은 그대로 보인다.
    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "참여 요청 2건" })).toHaveAttribute(
      "href",
      "/members/manage",
    );
  });

  it("does not expose links for attendance or poll features that are disabled", () => {
    renderDashboard(
      homePayload({
        attendance: undefined,
        pending_member_count: 0,
        polls: undefined,
        teacher_followups: { data: [], status: "empty" },
      }),
    );

    expect(document.querySelector('a[href^="/attendance"]')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/polls"]')).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "투표 만들기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "반 운영 바로가기" })).not.toBeInTheDocument();
  });

  it("keeps approval work visible when follow-up counts are unavailable", () => {
    renderDashboard(
      homePayload({
        pending_member_count: 1,
        teacher_followups: null,
      }),
    );

    const panel = document.querySelector("[data-teacher-tasks-panel]") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "참여 요청 1건" })).toBeVisible();
    const feed = document.querySelector('[data-home-news-feed="teacher"]') as HTMLElement;
    expect(within(feed).getAllByText("확인 현황은 글에서 볼 수 있어요")).toHaveLength(2);
  });

  it("shows distinct safe error states without also claiming that work is complete", () => {
    renderDashboard(
      homePayload({
        meal: {
          data: null,
          error_code: "MEAL_QUERY_FAILED",
          message: "raw meal detail",
          status: "error",
        },
        notices: {
          data: [],
          error_code: "NOTICE_QUERY_FAILED",
          message: "raw notice detail",
          status: "error",
        },
        pending_member_count: 0,
        schedules: {
          data: [],
          error_code: "SCHEDULE_QUERY_FAILED",
          message: "raw schedule detail",
          status: "error",
        },
        teacher_followups: {
          data: [],
          error_code: "FOLLOWUP_QUERY_FAILED",
          message: "후속 확인 현황을 불러오지 못했어요.",
          status: "error",
        },
      }),
    );

    const feed = document.querySelector('[data-home-news-feed="teacher"]') as HTMLElement;
    expect(within(feed).getByRole("alert")).toHaveTextContent(
      "공지, 확인 현황 정보를 불러오지 못했어요.",
    );
    expect(within(feed).queryByText("새 소식이 없어요.")).not.toBeInTheDocument();
    expect(within(feed).queryByText(/raw/u)).not.toBeInTheDocument();

    const today = screen.getByRole("region", { name: "오늘 정보" });
    expect(within(today).getByText("급식을 불러오지 못했어요.")).toBeVisible();
    expect(within(today).getByText("최근 전달을 불러오지 못했어요.")).toBeVisible();
    expect(within(today).getByText("일정을 불러오지 못했어요.")).toBeVisible();
    expect(within(today).getByRole("alert")).toHaveTextContent(
      "최근 전달, 급식, 일정 정보를 불러오지 못했습니다.",
    );
    expect(within(today).queryByText(/raw/u)).not.toBeInTheDocument();
  });
});
