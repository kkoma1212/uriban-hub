import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { StudentHomeDashboard } from "./student-home-dashboard";
import { StudentHomeQuickActions } from "./student-home-quick-actions";
import { TodayInfoSection } from "./home-today-info";

it("warns about retained home data before the student can act on the chalkboard", () => {
  render(
    <MemoryRouter>
      <StudentHomeDashboard
        home={homePayload()}
        loadFailed
        loading={false}
        loggingOut={false}
        onLogout={vi.fn()}
        onReload={vi.fn()}
      />
    </MemoryRouter>,
  );
  const warning = screen.getByText("최신 홈 정보를 확인하지 못했어요.");
  const board = screen.getByRole("region", { name: "우리반 칠판" });
  expect(warning.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

function homePayload(): HomeResponse {
  return {
    attendance: { data: null, status: "empty" },
    meal: {
      data: {
        calorie_kcal: 803.4,
        id: "meal-1",
        meal_date: "2026-07-25",
        menu: [{ allergens: [], name: "현미밥" }],
        source: "seed",
        source_loaded_on: null,
        source_updated_at: "2026-07-25T01:00:00.000Z",
      },
      status: "ok",
    },
    notices: {
      data: [
        {
          confirmation_state: "unread",
          content_revision: "notice-r1",
          id: "notice-1",
          is_important: true,
          published_at: "2026-07-25T09:00:00+09:00",
          title: "합성 중요 공지",
        },
      ],
      status: "ok",
    },
    pending_member_count: null,
    reminders: {
      data: [
        {
          reminder_type: "notice",
          requested_at: "2026-07-25T10:00:00+09:00",
          resource_id: "notice-1",
          title: "합성 중요 공지",
        },
      ],
      status: "ok",
    },
    schedules: {
      data: [
        {
          d_day_label: "D-1",
          days_until: 1,
          due_date: "2026-07-26",
          id: "schedule-1",
          schedule_type: "assignment",
          subject: "국어",
          title: "합성 과제",
        },
      ],
      status: "ok",
    },
    server_today: "2026-07-25",
    unresolved_count: 3,
    supplies: {
      data: [
        {
          category: "general",
          check_state: "checked",
          content_revision: "supply-r1",
          description: null,
          id: "supply-1",
          needed_on: "2026-07-25",
          title: "합성 준비물",
        },
        {
          category: "homework",
          check_state: "unchecked",
          content_revision: "supply-r2",
          description: null,
          id: "supply-2",
          needed_on: "2026-07-30",
          title: "합성 숙제",
        },
      ],
      status: "ok",
    },
    teacher_followups: null,
  } as HomeResponse;
}

describe("student mobile quick actions", () => {
  it("keeps server counts and nearest KST calendar schedule above the detailed feed", () => {
    const home = homePayload();
    home.schedules = {
      status: "ok",
      data: [
        { ...homePayload().schedules.data[0]!, id: "late", due_date: "2026-07-30" },
        { ...homePayload().schedules.data[0]!, id: "past", due_date: "2026-07-24" },
        {
          ...homePayload().schedules.data[0]!,
          id: "nearest",
          due_date: "2026-07-25",
          title: "긴 일정 제목 ".repeat(20),
          d_day_label: "D-999",
        },
      ],
    };
    renderDashboard({ home });
    const quick = screen.getByRole("navigation", { name: "학생 빠른 확인" });
    expect(quick).toHaveClass("md:hidden", "min-w-0");
    expect(within(quick).getAllByRole("link")).toHaveLength(2);
    const count = within(quick).getByRole("link", { name: "아직 안 본 소식 3개 확인하기" });
    expect(count).toHaveAttribute("href", "/updates?filter=unresolved");
    expect(count).toHaveClass("min-h-11");
    const schedule = within(quick).getByRole("link", {
      name: `오늘 일정: ${"긴 일정 제목 ".repeat(20).trim()}`,
    });
    expect(schedule).toHaveAttribute("href", "/schedules/nearest");
    expect(schedule).toHaveAttribute("aria-label", `오늘 일정: ${"긴 일정 제목 ".repeat(20)}`);
    expect(schedule).toHaveClass("min-h-11", "min-w-0");
    expect(within(schedule).getByText("긴 일정 제목 ".repeat(20).trim())).toBeVisible();
    expect(within(schedule).getByText("오늘 일정")).toBeVisible();
    const feed = screen.getByRole("heading", { name: "우리반 소식" });
    expect(quick.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([0, null, undefined, -1, Number.NaN, 1.5])(
    "does not manufacture a quick count for %s",
    (count) => {
      const home = {
        ...homePayload(),
        unresolved_count: count,
        schedules: {
          status: "error",
          data: [],
          error_code: "SCHEDULE_QUERY_FAILED",
          message: "failed",
        },
      } as unknown as HomeResponse;
      render(
        <MemoryRouter>
          <StudentHomeQuickActions home={home} />
        </MemoryRouter>,
      );
      expect(screen.queryByRole("navigation", { name: "학생 빠른 확인" })).not.toBeInTheDocument();
    },
  );

  it("uses server tomorrow independently of the client clock", () => {
    const home = homePayload();
    home.unresolved_count = 0;
    home.server_today = "2026-07-25";
    render(
      <MemoryRouter>
        <StudentHomeQuickActions home={home} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "내일 일정: 합성 과제" })).toHaveAttribute(
      "href",
      "/schedules/schedule-1",
    );
  });
});

describe("quick schedule calendar boundaries", () => {
  it.each(["2026-02-30", "not-a-date", "2026-07-24"])("hides invalid or past %s", (date) => {
    const home = homePayload();
    home.unresolved_count = 0;
    home.schedules = {
      status: "ok",
      data: [{ ...homePayload().schedules.data[0]!, due_date: date }],
    };
    render(
      <MemoryRouter>
        <StudentHomeQuickActions home={home} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("navigation", { name: "학생 빠른 확인" })).not.toBeInTheDocument();
  });
});

function renderDashboard({
  home = homePayload(),
  loading = false,
  loggingOut = false,
  onLogout = vi.fn(),
  onReload = vi.fn(),
}: {
  home?: HomeResponse;
  loading?: boolean;
  loggingOut?: boolean;
  onLogout?: () => void;
  onReload?: () => void;
} = {}) {
  return render(
    <MemoryRouter>
      <StudentHomeDashboard
        className="테스트 1반"
        error={undefined}
        home={home}
        loadFailed={false}
        loading={loading}
        loggingOut={loggingOut}
        onLogout={onLogout}
        onReload={onReload}
      />
    </MemoryRouter>,
  );
}

describe("StudentHomeDashboard", () => {
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
      renderDashboard({ home });
      const chalk = screen.getByRole("region", { name: "우리반 칠판" });
      expect(
        within(chalk).getByText(
          "칠판 안내를 모두 확인하지 못했어요. 아래 소식에서 다시 확인해 주세요.",
        ),
      ).toBeVisible();
      expect(within(chalk).queryByText("칠판에 올릴 중요한 안내는 없어요")).not.toBeInTheDocument();
      expect(within(chalk).queryByText("private synthetic detail")).not.toBeInTheDocument();
    },
  );

  it("omits retired placement and duty surfaces", () => {
    renderDashboard();
    expect(screen.queryByRole("heading", { name: "교실 배치" })).not.toBeInTheDocument();
    for (const destination of ["/seating", "/grouping", "/duty"])
      expect(document.querySelector(`a[href="${destination}"]`)).not.toBeInTheDocument();
  });
  it("uses the teacher home frame: chalkboard, news feed, then today info", () => {
    const { container } = renderDashboard();

    // 제목은 크게, 현재 반은 상단 메뉴 안에 표시한다.
    expect(container.querySelector('[data-home-hero-role="student"]')).not.toHaveClass(
      "bg-home-latest-soft",
    );
    expect(
      screen.getByRole("heading", { name: "우리반 허브" }).closest(".content-frame-heading"),
    ).not.toBeNull();
    expect(
      within(screen.getByRole("group", { name: "홈 상단 메뉴" })).getByText("테스트 1반"),
    ).toBeVisible();
    expect(screen.queryByText(/오늘 챙길 일이/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/미확인 공지 1건/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/챙길 준비물 0건/u)).not.toBeInTheDocument();
    const chalkboard = screen.getByRole("region", { name: "우리반 칠판" });
    expect(within(chalkboard).getByText("7월 25일 토요일")).toHaveAttribute(
      "datetime",
      "2026-07-25",
    );
    // 칠판: 확인 안 한 중요 공지 → 아직 안 한 숙제. 이미 챙긴 준비물은 올리지 않는다.
    expect(
      within(chalkboard)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/notices/notice-1", "/supplies/supply-2"]);
    expect(within(chalkboard).queryByText("합성 준비물")).not.toBeInTheDocument();
    expect(screen.getByText("학생 홈")).toHaveClass("sr-only");
    const toolbar = screen.getByRole("group", { name: "홈 상단 메뉴" });
    expect(within(toolbar).getByRole("link", { name: "우리반 소식 보기" })).toHaveAttribute(
      "href",
      "/updates",
    );
    expect(within(toolbar).getByRole("button", { name: "홈 새로고침" })).toBeVisible();
    expect(within(toolbar).getByRole("button", { name: "로그아웃" })).toBeVisible();
    // 2026-10-02 사용자 결정: 설정은 메뉴(PC 왼쪽 아래·휴대폰 더보기)에만 두고 홈 윗줄은 교사와 같게.
    expect(screen.queryByRole("link", { name: "학생 설정" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-home-card]")).toBeNull();
    expect(screen.queryByRole("region", { name: "오늘 출결 연락" })).not.toBeInTheDocument();

    // 순서: 칠판 → 우리반 소식(한 판) → 오늘 정보(한 판). 교사 홈과 같은 틀.
    const feed = container.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    const today = container.querySelector('[data-home-today-section="student"]') as HTMLElement;
    expect(
      chalkboard.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(feed.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(feed).toHaveClass("rounded-card", "border", "bg-app-surface", "p-4", "shadow-card");
    expect(today).toHaveClass("teacher-home-today-surface", "rounded-card", "shadow-card");

    expect(
      within(feed)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/updates", "/notices/notice-1", "/supplies/supply-1", "/supplies/supply-2"]);
    const notice = within(feed).getByText("합성 중요 공지").closest("a") as HTMLElement;
    expect(within(notice).getByText("선생님 재알림")).toBeVisible();
    expect(within(notice).getByText("아직 확인 전")).toBeVisible();
    const homework = within(feed).getByText("합성 숙제").closest("a") as HTMLElement;
    expect(within(homework).getByText("아직 안 했어요")).toBeVisible();
    const supply = within(feed).getByText("합성 준비물").closest("a") as HTMLElement;
    expect(within(supply).getByText("챙겼어요")).toBeVisible();

    // 오늘 정보: 첫 줄은 학생용 '아직 안 본 것', 이어서 급식·가까운 일정(교사와 같은 줄 모양).
    expect(within(today).getByRole("heading", { name: "오늘 정보" })).toBeVisible();
    expect(
      within(today)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/updates?filter=unresolved",
      "/supplies",
      "/supplies/supply-2",
      "/meals",
      "/schedules/schedule-1",
    ]);
    // 학생만 있는 두 줄(2026-10-03): 오늘 챙길 준비물·가까운 숙제.
    const supplyRow = within(today).getByText("챙길 준비물").closest("a") as HTMLElement;
    expect(within(supplyRow).getByText("합성 준비물")).toBeVisible();
    expect(within(supplyRow).getByText("모두 챙겼어요")).toBeVisible();
    expect(within(supplyRow).getByText("오늘")).toBeVisible();
    const homeworkRow = within(today).getByText("가까운 숙제").closest("a") as HTMLElement;
    expect(within(homeworkRow).getByText("합성 숙제")).toBeVisible();
    expect(within(homeworkRow).getByText("아직 안 했어요")).toBeVisible();
    expect(within(homeworkRow).getByText("D-5")).toBeVisible();
    expect(within(today).getByText("아직 안 본 것")).toBeVisible();
    // 홈에 보이는 일부가 아니라 서버가 센 소식 탭 기준 숫자다(총검수 B2-01).
    expect(within(today).getByText("3개 남았어요")).toBeVisible();
    expect(within(today).getByText(/^현미밥/u)).toHaveClass("text-app-text");
    expect(within(today).getByText("학교 연동 정보 없음")).toBeVisible();
    expect(within(today).getByText("합성 과제")).toHaveClass("text-app-text");
    expect(within(today).getByText("D-1")).toBeVisible();
    expect(within(today).queryByText("최근 전달")).not.toBeInTheDocument();

    const undersizedMeta = Array.from(container.querySelectorAll<HTMLElement>("[class]")).filter(
      (element) => {
        const className = element.getAttribute("class") ?? "";
        return className.includes("text-[10px]") || className.includes("text-[11px]");
      },
    );
    expect(undersizedMeta).toHaveLength(0);
  });

  it("says all done only when the server count is zero and never invents a count", () => {
    const home = homePayload();
    const { unmount } = renderDashboard({ home: { ...home, unresolved_count: 0 } });
    expect(screen.getByText("모두 확인했어요").closest("a")).toHaveAttribute("href", "/updates");
    unmount();

    renderDashboard({ home: { ...home, unresolved_count: null } });
    expect(screen.queryByText("모두 확인했어요")).not.toBeInTheDocument();
    expect(screen.getByText("소식에서 확인해 주세요").closest("a")).toHaveAttribute(
      "href",
      "/updates?filter=unresolved",
    );
  });

  it("lists unchecked supplies first and keeps the two rows honest when empty or failed", () => {
    const home = homePayload();
    const supply = (
      id: string,
      title: string,
      check_state: "checked" | "unchecked",
      needed_on: string,
    ) => ({
      category: "general" as const,
      check_state,
      content_revision: `${id}-r1`,
      description: null,
      id,
      needed_on,
      title,
    });
    const { unmount } = renderDashboard({
      home: {
        ...home,
        supplies: {
          data: [
            supply("a", "챙긴 것", "checked", "2026-07-25"),
            supply("b", "체육복", "unchecked", "2026-07-26"),
            supply("c", "물감", "unchecked", "2026-07-26"),
            supply("d", "색종이", "unchecked", "2026-07-26"),
          ],
          status: "ok",
        },
      },
    });
    const row = screen.getByText("챙길 준비물").closest("a") as HTMLElement;
    expect(within(row).getByText("체육복 · 물감")).toBeVisible();
    expect(within(row).getByText("아직 안 챙긴 것 3개")).toBeVisible();
    expect(within(row).getByText("내일")).toBeVisible();
    expect(row).toHaveAttribute("href", "/supplies");
    expect(screen.getByText("다가오는 숙제가 없어요.")).toBeVisible();
    unmount();

    renderDashboard({
      home: {
        ...home,
        supplies: { data: [], error_code: "SUPPLY_QUERY_FAILED", message: "x", status: "error" },
      } as HomeResponse,
    });
    expect(screen.getByText("준비물을 불러오지 못했어요.")).toHaveClass("text-rose-700");
    expect(screen.getByText("숙제를 불러오지 못했어요.")).toHaveClass("text-rose-700");
  });

  it("omits the reminder tag when no reminder is pending", () => {
    const home = homePayload();
    renderDashboard({ home: { ...home, reminders: { data: [], status: "empty" } } });

    expect(screen.queryByText("선생님 재알림")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows only the first two menu items and the nearest schedule in today info", () => {
    const home = homePayload();
    if (home.meal.status !== "ok" || home.meal.data === null || home.schedules.status !== "ok") {
      throw new Error("The populated Home fixture must contain successful card data.");
    }
    const schedule = home.schedules.data[0];
    if (schedule === undefined)
      throw new Error("The populated Home fixture must contain a schedule.");
    home.meal.data.menu.push(
      { allergens: [], name: "second meal" },
      { allergens: [], name: "desktop meal" },
    );
    home.schedules.data.push({ ...schedule, id: "schedule-2", title: "desktop schedule" });

    const { container } = renderDashboard({ home });
    const today = container.querySelector('[data-home-today-section="student"]') as HTMLElement;
    expect(within(today).queryByText(/desktop meal/u)).not.toBeInTheDocument();
    expect(within(today).queryByText("desktop schedule")).not.toBeInTheDocument();
    expect(container.querySelector("[data-mobile-home-preview]")).toBeNull();
  });

  it("keeps refresh and logout operable and exposes their busy states", () => {
    const onLogout = vi.fn();
    const onReload = vi.fn();
    const { rerender } = renderDashboard({ onLogout, onReload });

    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <StudentHomeDashboard
          className="테스트 1반"
          error={undefined}
          home={homePayload()}
          loadFailed={false}
          loading
          loggingOut
          onLogout={onLogout}
          onReload={onReload}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "홈 새로고침" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "홈 새로고침" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "로그아웃" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("홈을 새로고침하는 중입니다.");
  });

  it("puts an open poll first in the news feed without adding a bottom tab", () => {
    const home = homePayload();
    home.polls = {
      data: [
        {
          closes_at: "2026-07-26T03:00:00.000Z",
          has_voted: false,
          id: "poll-1",
          kind: "poll",
          title: "자리 이동 순서",
        },
        {
          closes_at: "2026-07-27T03:00:00.000Z",
          has_voted: true,
          id: "poll-2",
          kind: "poll",
          title: "학급 행사 선택",
        },
      ],
      status: "ok",
    };

    const { container } = renderDashboard({ home });

    // 안 한 투표는 소식 흐름 맨 앞, 이미 한 투표는 흐름에 없다. 아래 탭은 늘리지 않는다.
    const feed = container.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    const first = within(feed).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(first).getByRole("link")).toHaveAttribute("href", "/polls/poll-1");
    expect(within(first).getByText("자리 이동 순서")).toBeVisible();
    expect(within(first).getByText("아직 투표 전")).toBeVisible();
    expect(screen.queryByText("학급 행사 선택")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-primary-navigation-item="활동"]'),
    ).not.toBeInTheDocument();
  });

  it("says there is no news only when every feed source loaded", () => {
    const home = homePayload();
    renderDashboard({
      home: {
        ...home,
        notices: { data: [], status: "empty" },
        reminders: { data: [], status: "empty" },
        supplies: { data: [], status: "empty" },
      },
    });

    expect(screen.getByText("새 소식이 없어요.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps card failures on dedicated danger surfaces", () => {
    const base = homePayload();
    renderDashboard({
      home: {
        ...base,
        meal: {
          data: null,
          error_code: "MEAL_QUERY_FAILED",
          message: "급식 정보를 확인하지 못했어요.",
          status: "error",
        },
        notices: {
          data: [],
          error_code: "NOTICE_QUERY_FAILED",
          message: "공지 정보를 확인하지 못했어요.",
          status: "error",
        },
        reminders: {
          data: [],
          error_code: "REMINDER_QUERY_FAILED",
          message: "다시 확인 요청을 확인하지 못했어요.",
          status: "error",
        },
        schedules: {
          data: [],
          error_code: "SCHEDULE_QUERY_FAILED",
          message: "일정 정보를 확인하지 못했어요.",
          status: "error",
        },
        supplies: {
          data: [],
          error_code: "SUPPLY_QUERY_FAILED",
          message: "준비물 정보를 확인하지 못했어요.",
          status: "error",
        },
      },
    });

    // 오늘 정보는 실패한 줄을 빨간 글자로 바꾸고 읽기 프로그램에 한 번 알린다. 소식 흐름은 한 줄로 알린다.
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    const feedAlert = alerts.find((alert) =>
      alert.textContent?.includes("공지, 준비물"),
    ) as HTMLElement;
    expect(feedAlert).toHaveClass("bg-danger-surface", "text-danger-text");
    expect(feedAlert).toHaveTextContent(
      "공지, 준비물·숙제, 다시 확인 요청 정보를 불러오지 못했어요.",
    );
    expect(alerts.find((alert) => alert !== feedAlert)).toHaveTextContent(
      "급식, 일정 정보를 불러오지 못했습니다.",
    );
    expect(screen.getByText("급식을 불러오지 못했어요.")).toHaveClass("text-rose-700");
    expect(screen.getByText("일정을 불러오지 못했어요.")).toHaveClass("text-rose-700");
    expect(screen.queryByText("새 소식이 없어요.")).not.toBeInTheDocument();
  });

  it("never reports a supply progress count when the supply card failed", () => {
    const base = homePayload();
    renderDashboard({
      home: {
        ...base,
        supplies: {
          data: [],
          error_code: "SUPPLY_QUERY_FAILED",
          message: "준비물 정보를 확인하지 못했어요.",
          status: "error",
        },
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("준비물·숙제 정보를 불러오지 못했어요.");
    expect(screen.queryByText(/챙김/u)).not.toBeInTheDocument();
  });

  it("surfaces an alert card failure even when other alert sources still have data", () => {
    const base = homePayload();
    renderDashboard({
      home: {
        ...base,
        reminders: {
          data: [],
          error_code: "REMINDER_QUERY_FAILED",
          message: "다시 확인 요청을 확인하지 못했어요.",
          status: "error",
        },
      },
    });

    // The notices card still has data, so the card is not empty. The reminder
    // failure must not disappear behind it. (The title also sits on the chalkboard.)
    const feed = document.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    expect(within(feed).getByText("합성 중요 공지")).toBeVisible();
    expect(within(feed).getByRole("alert")).toHaveTextContent(
      "다시 확인 요청 정보를 불러오지 못했어요.",
    );
  });

  it("treats a poll without kind as a poll in the news feed", () => {
    const base = homePayload();
    renderDashboard({
      home: {
        ...base,
        polls: {
          data: [
            {
              closes_at: "2026-07-26T09:00:00+09:00",
              has_voted: false,
              id: "poll-7",
              title: "체육대회 종목 투표",
            },
          ],
          status: "ok",
        },
      } as HomeResponse,
    });

    const feed = document.querySelector('[data-home-news-feed="student"]') as HTMLElement;
    expect(within(feed).getByText("체육대회 종목 투표").closest("a")).toHaveAttribute(
      "href",
      "/polls/poll-7",
    );
  });

  it("keeps the home activity-free when the poll feature is off", () => {
    renderDashboard();

    expect(screen.queryByRole("link", { name: "활동" })).not.toBeInTheDocument();
  });

  it("does not expose attendance when that feature is disabled", () => {
    const base = homePayload();
    const { attendance: omittedAttendance, ...homeWithoutAttendance } = base;
    void omittedAttendance;
    const { container } = renderDashboard({
      home: homeWithoutAttendance,
    });

    expect(screen.queryByRole("region", { name: "오늘 출결 연락" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /출결 연락 전체 보기/u })).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-student-home-slot="attendance-past"] [data-home-card]'),
    ).toBeNull();
  });
});

it("긴 반 이름을 유지하면서 홈 도구의 이동과 동작을 제공한다", () => {
  const className = "일정 QA 6a6345ed998f47be249ea1fb";
  const onReload = vi.fn();
  const onLogout = vi.fn();
  render(
    <MemoryRouter>
      <StudentHomeDashboard
        home={homePayload()}
        className={className}
        loadFailed={false}
        loading={false}
        loggingOut={false}
        onLogout={onLogout}
        onReload={onReload}
      />
    </MemoryRouter>,
  );
  const toolbar = screen.getByRole("group", { name: "홈 상단 메뉴" });
  expect(within(toolbar).getByLabelText(`현재 반: ${className}`)).toHaveTextContent(className);
  expect(within(toolbar).getByRole("link", { name: "우리반 소식 보기" })).toHaveAttribute(
    "href",
    "/updates",
  );
  fireEvent.click(within(toolbar).getByRole("button", { name: "홈 새로고침" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "로그아웃" }));
  expect(onReload).toHaveBeenCalledOnce();
  expect(onLogout).toHaveBeenCalledOnce();
});

describe("학생 선별 빈 칠판", () => {
  function renderEmptyHome(
    overrides: Partial<HomeResponse> = {},
    loading = false,
    loadFailed = false,
  ): void {
    const base = homePayload();
    const emptyHome = {
      ...base,
      notices: {
        status: "ok" as const,
        data:
          base.notices.status === "ok"
            ? base.notices.data.map((item) => ({ ...item, is_important: false }))
            : [],
      },
      supplies: { status: "empty" as const, data: [] },
      unresolved_count: 6,
      ...overrides,
    };
    render(
      <MemoryRouter>
        <StudentHomeDashboard
          home={emptyHome}
          loadFailed={loadFailed}
          loading={loading}
          loggingOut={false}
          onLogout={vi.fn()}
          onReload={vi.fn()}
        />
      </MemoryRouter>,
    );
  }
  it("일반 미확인 소식 6개가 있어도 중요 칠판만 비었다고 안내한다", () => {
    renderEmptyHome();
    expect(screen.getByText("칠판에 올릴 중요한 안내는 없어요")).toBeVisible();
    expect(screen.getByText("6개 확인하기")).toBeVisible();
    expect(screen.queryByText("오늘은 새로 볼 안내가 없어요")).not.toBeInTheDocument();
    expect(document.querySelector("[data-chalk-body]")).toHaveClass("min-h-[4.75rem]");
  });
  it.each(["조회 오류", "새로고침", "이전 자료"])(
    "%s는 성공한 빈 칠판으로 축소하지 않는다",
    (state) => {
      renderEmptyHome(
        state === "조회 오류"
          ? {
              notices: {
                status: "error",
                data: [],
                error_code: "NOTICE_QUERY_FAILED",
                message: "합성 오류",
              },
            }
          : {},
        state === "새로고침",
        state === "이전 자료",
      );
      expect(document.querySelector("[data-chalk-body]")).toHaveClass("min-h-[9.25rem]");
      expect(document.querySelector("[data-chalk-body]")).not.toHaveClass("min-h-[4.75rem]");
      if (state === "조회 오류")
        expect(
          screen.getByText("칠판 안내를 모두 확인하지 못했어요. 아래 소식에서 다시 확인해 주세요."),
        ).toBeVisible();
    },
  );
});

describe("학생 빠른 카드와 아래 정보의 정확한 중복", () => {
  function todayRow(label: string): HTMLLIElement {
    const today = screen.getByRole("region", { name: "오늘 정보" });
    const row = within(today).getByText(label).closest("li");
    if (!row) throw new Error("오늘 정보 행을 찾지 못했습니다.");
    return row;
  }
  it("같은 양수 미확인 지름길이 있을 때만 아래 행을768미만에서 숨긴다", () => {
    renderDashboard({ home: homePayload() });
    expect(screen.getByRole("navigation", { name: "학생 빠른 확인" })).toHaveClass("md:hidden");
    expect(todayRow("아직 안 본 것")).toHaveClass("hidden", "md:list-item");
    expect(screen.getByRole("link", { name: "아직 안 본 소식 3개 확인하기" })).toHaveAttribute(
      "href",
      "/updates?filter=unresolved",
    );
  });
  it.each([0, null, undefined, -1, Number.NaN, 1.5])(
    "미확인%s는 아래 기존 안내를 숨기지 않는다",
    (count) => {
      renderDashboard({
        home: { ...homePayload(), unresolved_count: count } as unknown as HomeResponse,
      });
      expect(todayRow("아직 안 본 것")).not.toHaveClass("hidden");
    },
  );
  it.each([null, "국어", undefined])(
    "일정 과목%s에서 정확히null인 동일 대상만 숨긴다",
    (subject) => {
      const home = homePayload();
      home.schedules = {
        status: "ok",
        data: [{ ...home.schedules.data[0]!, subject }],
      } as HomeResponse["schedules"];
      renderDashboard({ home });
      const row = todayRow("가까운 일정");
      if (subject === null) expect(row).toHaveClass("hidden", "md:list-item");
      else expect(row).not.toHaveClass("hidden");
      expect(
        within(screen.getByRole("navigation", { name: "학생 빠른 확인" })).getByRole("link", {
          name: "내일 일정: 합성 과제",
        }),
      ).toHaveAttribute("href", "/schedules/schedule-1");
    },
  );
  it("빠른 카드가 고른 일정과 아래 첫 일정의id가 다르면 아래 정보를 보존한다", () => {
    const home = homePayload();
    home.schedules = {
      status: "ok",
      data: [
        { ...home.schedules.data[0]!, id: "past", due_date: "2026-07-24", subject: null },
        { ...home.schedules.data[0]!, id: "future", subject: null },
      ],
    };
    renderDashboard({ home });
    expect(todayRow("가까운 일정")).not.toHaveClass("hidden");
    expect(
      within(screen.getByRole("navigation", { name: "학생 빠른 확인" })).getByRole("link", {
        name: "내일 일정: 합성 과제",
      }),
    ).toHaveAttribute("href", "/schedules/future");
  });
  it("일정 실패는 아래 오류 안내와 목록 진입을 보존한다", () => {
    renderDashboard({
      home: {
        ...homePayload(),
        schedules: {
          status: "error",
          data: [],
          error_code: "SCHEDULE_QUERY_FAILED",
          message: "합성 실패",
        },
      },
    });
    expect(todayRow("가까운 일정")).not.toHaveClass("hidden");
    expect(screen.getByText("일정을 불러오지 못했어요.")).toBeVisible();
  });
  it.each(["student", "teacher"] as const)("단독%s 오늘 정보는 전체 행을 유지한다", (role) => {
    render(
      <MemoryRouter>
        <TodayInfoSection home={homePayload()} role={role} />
      </MemoryRouter>,
    );
    const today = screen.getByRole("region", { name: "오늘 정보" });
    for (const row of today.querySelectorAll("li")) expect(row).not.toHaveClass("hidden");
  });
});
