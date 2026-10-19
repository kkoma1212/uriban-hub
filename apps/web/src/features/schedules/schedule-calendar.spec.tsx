import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduleCalendar } from "./schedule-calendar";

const leapDayItems = [
  {
    d_day_label: "D-744",
    days_until: 744,
    description: null,
    due_date: "2028-02-29",
    id: "17",
    row_version: "1",
    schedule_type: "exam" as const,
    source: "class" as const,
    subject: "수학",
    title: "윤년 첫 일정",
  },
  {
    d_day_label: "D-744",
    days_until: 744,
    description: null,
    due_date: "2028-02-29",
    id: "18",
    row_version: "1",
    schedule_type: "performance" as const,
    source: "class" as const,
    subject: null,
    title: "윤년 둘째 일정",
  },
  {
    d_day_label: "D-744",
    days_until: 744,
    description: "전 학년 정상 등교",
    due_date: "2028-02-29",
    id: "31",
    school_day_type: "수업일",
    source: "school" as const,
    source_loaded_on: "2026-07-30",
    target_grades: [1, 2, 3],
    title: "학교 공식 행사",
  },
  {
    d_day_label: "D-745",
    days_until: 745,
    description: null,
    due_date: "2028-03-01",
    id: "19",
    row_version: "1",
    schedule_type: "assignment" as const,
    source: "class" as const,
    subject: "영어",
    title: "다음 달 일정",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderCalendar() {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30") {
      return Promise.resolve(
        jsonResponse({
          end_date: "2028-03-11",
          items: leapDayItems,
          oldest_visible_date: "2027-11-17",
          server_today: "2028-02-15",
          start_date: "2028-01-30",
        }),
      );
    }
    if (url === "/api/v1/schedules/calendar?end_date=2028-04-08&start_date=2028-02-27") {
      return Promise.resolve(
        jsonResponse({
          end_date: "2028-04-08",
          items: [],
          oldest_visible_date: "2027-11-17",
          server_today: "2028-02-15",
          start_date: "2028-02-27",
        }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  render(
    <MemoryRouter>
      <ScheduleCalendar serverToday="2028-02-15" />
    </MemoryRouter>,
  );
  return fetchMock;
}

function renderOldestBoundaryCalendar() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    jsonResponse({
      end_date: "2028-03-11",
      items: [],
      oldest_visible_date: "2028-02-01",
      server_today: "2028-02-15",
      start_date: "2028-01-30",
    }),
  );
  render(
    <MemoryRouter>
      <ScheduleCalendar serverToday="2028-02-15" />
    </MemoryRouter>,
  );
}

/* 서버가 실제로 돌려주는 모양 그대로. 화면이 날짜를 스스로 아는 길은 없어야 한다. */
const AUGUST_2026_HOLIDAYS = [
  { date: "2026-08-15", name: "광복절" },
  { date: "2026-08-17", name: "대체공휴일(광복절)" },
];

function renderAugust2026Calendar({ withHolidays = true } = {}) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    jsonResponse({
      end_date: "2026-09-05",
      holidays: withHolidays ? AUGUST_2026_HOLIDAYS : [],
      items: [],
      oldest_visible_date: "2026-05-26",
      server_today: "2026-08-24",
      start_date: "2026-07-26",
    }),
  );
  render(
    <MemoryRouter>
      <ScheduleCalendar serverToday="2026-08-24" />
    </MemoryRouter>,
  );
}

describe("ScheduleCalendar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a 7-column leap-month grid with mobile counts and a selected-day agenda", async () => {
    renderCalendar();

    expect(screen.getByRole("grid", { name: "2028년 2월 일정 달력" })).toBeVisible();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    expect(
      screen.getByRole("grid", { name: "2028년 2월 일정 달력" }).closest("section"),
    ).toHaveClass("mb-4", "min-w-0");
    expect(screen.getAllByRole("row")[0]).toHaveClass("gap-px", "sm:gap-2");
    const pair = document.querySelector('[data-schedule-calendar-pair="true"]');
    const agendaPane = document.querySelector('[data-schedule-calendar-pane="selected-day"]');
    const calendarPane = document.querySelector('[data-schedule-calendar-pane="calendar"]');
    expect(pair).toHaveClass("content-split");
    expect(agendaPane?.closest(".content-split-aside")).toHaveClass("content-split-aside-mobile");
    expect(calendarPane?.closest(".content-split-main")).toBe(pair?.firstElementChild);

    const weekStrip = screen.getByRole("group", { name: "선택한 날짜가 포함된 주" });
    expect(weekStrip).toHaveAttribute("data-schedule-week-strip", "true");
    expect(within(weekStrip).getAllByRole("button")).toHaveLength(7);
    expect(
      within(weekStrip).getByRole("button", { name: /2028년 2월 15일 화요일.*오늘/u }),
    ).toHaveAttribute("aria-pressed", "true");

    const monthToggle = screen.getByRole("button", { name: "월 보기" });
    expect(monthToggle).toHaveAttribute("aria-pressed", "false");
    expect(monthToggle).toHaveAttribute("aria-controls", "schedule-month-calendar");
    fireEvent.click(monthToggle);
    expect(monthToggle).toHaveAttribute("aria-pressed", "true");
    const monthCalendar = document.querySelector<HTMLElement>(
      '[data-schedule-month-calendar="true"]',
    );
    if (monthCalendar === null) throw new Error("Month calendar was not found.");
    expect(within(monthCalendar).getByRole("button", { name: "오늘" })).toBeVisible();

    const leapDay = await screen.findByRole("gridcell", {
      name: /2028년 2월 29일 화요일, 일정 3개/u,
    });
    expect(leapDay.parentElement).toHaveClass("gap-px", "sm:gap-2");
    expect(leapDay).toHaveClass("flex", "flex-col", "items-stretch", "justify-start", "text-left");
    expect(leapDay.firstElementChild).toHaveClass("block", "text-left");
    const mobileCount = within(leapDay).getByText("3");
    expect(mobileCount).toHaveClass("lg:hidden");
    expect(within(leapDay).getByText("윤년 첫 일정").parentElement).toHaveClass(
      "hidden",
      "lg:block",
    );

    expect(within(leapDay).getByText("윤년 둘째 일정")).toBeInTheDocument();
    expect(within(leapDay).queryByText("학교 공식 행사")).not.toBeInTheDocument();
    expect(within(leapDay).getByText("+1")).toBeInTheDocument();

    fireEvent.click(leapDay);
    expect(screen.getByRole("heading", { name: "2028년 2월 29일 화요일" })).toBeVisible();
    expect(screen.getByRole("link", { name: /윤년 첫 일정/u })).toHaveAttribute(
      "href",
      "/schedules/17",
    );
    expect(screen.getByRole("link", { name: /윤년 둘째 일정/u })).toHaveAttribute(
      "href",
      "/schedules/18",
    );
    const schoolEvent = document.querySelector('[data-source="school"]');
    expect(schoolEvent).toBeVisible();
    expect(within(schoolEvent as HTMLElement).getByText("교육청(나이스) 정보")).toBeVisible();
    expect(within(schoolEvent as HTMLElement).getByText("학교")).toHaveAttribute(
      "data-schedule-kind",
      "school",
    );
    expect(within(schoolEvent as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(schoolEvent as HTMLElement).getByText(/1, 2, 3학년/u)).toBeVisible();
    expect(leapDay).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getAllByRole("gridcell").filter((cell) => cell.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });

  it("matches desktop visual and DOM order without changing the mobile order", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((media: string) => ({
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: media === "(min-width: 1280px)",
        media,
        onchange: null,
        removeEventListener: vi.fn(),
      })),
    );
    renderCalendar();
    await screen.findByRole("grid", { name: "2028년 2월 일정 달력" });

    const pair = document.querySelector('[data-schedule-calendar-pair="true"]');
    const agendaPane = document.querySelector('[data-schedule-calendar-pane="selected-day"]');
    const calendarPane = document.querySelector('[data-schedule-calendar-pane="calendar"]');
    expect(pair?.firstElementChild).toContainElement(calendarPane as HTMLElement);
    expect(pair?.lastElementChild).toContainElement(agendaPane as HTMLElement);
  });

  it("announces loading instead of a false empty selected day", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const pendingRequest = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pendingRequest);

    render(
      <MemoryRouter>
        <ScheduleCalendar serverToday="2028-02-15" />
      </MemoryRouter>,
    );

    expect(screen.getByText("일정 확인 중")).toBeVisible();
    const selectedDayLoading = screen.getByText("선택한 날짜의 일정을 불러오고 있어요.");
    expect(selectedDayLoading).toBeVisible();
    expect(selectedDayLoading).toHaveAttribute("role", "status");
    expect(
      screen.getAllByRole("button", {
        name: /2028년 2월 15일 화요일, 일정 확인 중, 오늘/u,
      }),
    ).toHaveLength(1);
    expect(document.querySelector('[role="gridcell"][aria-current="date"]')).toHaveAttribute(
      "aria-label",
      "2028년 2월 15일 화요일, 일정 확인 중, 오늘",
    );
    expect(
      screen.queryByRole("button", {
        name: /2028년 2월 15일 화요일, 일정 없음, 오늘/u,
      }),
    ).toBeNull();
    expect(screen.queryByText("선택한 날짜에 등록된 일정이 없어요.")).toBeNull();

    await act(async () => {
      resolveRequest?.(
        jsonResponse({
          end_date: "2028-03-11",
          items: [],
          oldest_visible_date: "2027-11-17",
          server_today: "2028-02-15",
          start_date: "2028-01-30",
        }),
      );
      await pendingRequest;
    });

    expect(await screen.findByText("선택한 날짜에 등록된 일정이 없어요.")).toBeVisible();
  });

  it("loads the Monday-to-Saturday overflow before a Sunday month start", async () => {
    const previousWeekItem = {
      ...leapDayItems[0],
      d_day_label: "D-2",
      days_until: 2,
      due_date: "2026-10-30",
      id: "week-boundary",
      title: "월 경계 준비 일정",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/schedules/calendar?end_date=2026-12-12&start_date=2026-11-01") {
        return Promise.resolve(
          jsonResponse({
            end_date: "2026-12-12",
            items: [],
            oldest_visible_date: "2026-08-03",
            server_today: "2026-11-01",
            start_date: "2026-11-01",
          }),
        );
      }
      if (url === "/api/v1/schedules/calendar?end_date=2026-10-31&start_date=2026-10-26") {
        return Promise.resolve(
          jsonResponse({
            end_date: "2026-10-31",
            items: [previousWeekItem],
            oldest_visible_date: "2026-08-03",
            server_today: "2026-11-01",
            start_date: "2026-10-26",
          }),
        );
      }
      if (url === "/api/v1/schedules/calendar?end_date=2026-11-07&start_date=2026-09-27") {
        return Promise.resolve(
          jsonResponse({
            end_date: "2026-11-07",
            items: [previousWeekItem],
            oldest_visible_date: "2026-08-03",
            server_today: "2026-11-01",
            start_date: "2026-09-27",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <ScheduleCalendar serverToday="2026-11-01" />
      </MemoryRouter>,
    );

    const weekStrip = screen.getByRole("group", { name: "선택한 날짜가 포함된 주" });
    const previousMonthDay = await within(weekStrip).findByRole("button", {
      name: /2026년 10월 30일 금요일, 일정 1개/u,
    });
    fireEvent.click(previousMonthDay);
    expect(await screen.findByRole("link", { name: /월 경계 준비 일정/u })).toHaveAttribute(
      "href",
      "/schedules/week-boundary",
    );
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input)).sort()).toEqual([
      "/api/v1/schedules/calendar?end_date=2026-10-31&start_date=2026-10-26",
      "/api/v1/schedules/calendar?end_date=2026-11-07&start_date=2026-09-27",
      "/api/v1/schedules/calendar?end_date=2026-12-12&start_date=2026-11-01",
    ]);
  });

  it("shows the student's own attendance record in the calendar and selected-day agenda", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30") {
        return Promise.resolve(
          jsonResponse({
            end_date: "2028-03-11",
            items: [],
            oldest_visible_date: "2027-11-17",
            server_today: "2028-02-15",
            start_date: "2028-01-30",
          }),
        );
      }
      if (url === "/api/v1/attendance-notifications/history?from=2028-01-30&to=2028-02-15") {
        return Promise.resolve(
          jsonResponse({
            counts: { absent: 0, early: 0, late: 1, total: 1 },
            items: [
              {
                expected_time: "08:40",
                notification_date: "2028-02-14",
                notification_type: "late",
                status: "acknowledged",
              },
            ],
            range: { from: "2028-01-30", to: "2028-02-15" },
            role: "student",
            server_today: "2028-02-15",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <ScheduleCalendar attendanceEnabled serverToday="2028-02-15" />
      </MemoryRouter>,
    );

    const attendanceDescription = await screen.findByText("내가 알린 출결 지각");
    const attendanceDay = attendanceDescription.closest("button");
    expect(attendanceDay).not.toBeNull();
    expect(attendanceDescription).toHaveClass("sr-only");
    if (attendanceDay === null) throw new Error("Attendance date button was not found.");
    expect(within(attendanceDay).getByText("1")).toHaveClass("lg:hidden");
    fireEvent.click(attendanceDay);
    expect(await screen.findByRole("link", { name: /내가 알린 출결.*지각/u })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(screen.getByText("담임 선생님 확인")).toBeVisible();
  });

  it("keeps a loaded attendance record visible when only schedules fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30") {
        return Promise.resolve(
          jsonResponse({ error: { code: "SCHEDULE_LOOKUP_FAILED", message: "synthetic" } }, 503),
        );
      }
      if (url === "/api/v1/attendance-notifications/history?from=2028-01-30&to=2028-02-15") {
        return Promise.resolve(
          jsonResponse({
            counts: { absent: 0, early: 0, late: 1, total: 1 },
            items: [
              {
                expected_time: "08:40",
                notification_date: "2028-02-14",
                notification_type: "late",
                status: "acknowledged",
              },
            ],
            range: { from: "2028-01-30", to: "2028-02-15" },
            role: "student",
            server_today: "2028-02-15",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter>
        <ScheduleCalendar attendanceEnabled serverToday="2028-02-15" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("이 달의 일정을 불러오지 못했어요.");
    const attendanceDay = screen.getByRole("button", {
      name: /2028년 2월 14일 월요일, 일정 확인 불가, 내가 알린 출결 지각/u,
    });
    fireEvent.click(attendanceDay);
    expect(screen.getByText("출결 1건 · 반·학교 일정 확인 불가")).toBeVisible();
    expect(screen.getByText("반·학교 일정은 지금 확인할 수 없어요.")).toBeVisible();
    expect(screen.getByRole("link", { name: /내가 알린 출결.*지각/u })).toHaveAttribute(
      "href",
      "/attendance",
    );
    expect(screen.queryByText("선택한 날짜에 등록된 일정이 없어요.")).toBeNull();
  });

  it("uses a non-destructive primary action to retry a failed month request", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30") {
        throw new Error(`Unexpected URL: ${url}`);
      }
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          jsonResponse({ error: { code: "SCHEDULE_LOOKUP_FAILED", message: "synthetic" } }, 503),
        );
      }
      return Promise.resolve(
        jsonResponse({
          end_date: "2028-03-11",
          items: leapDayItems,
          oldest_visible_date: "2027-11-17",
          server_today: "2028-02-15",
          start_date: "2028-01-30",
        }),
      );
    });

    render(
      <MemoryRouter>
        <ScheduleCalendar serverToday="2028-02-15" />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(
      await screen.findByRole("gridcell", {
        name: /2028년 2월 29일 화요일, 일정 3개/u,
      }),
    ).toBeVisible();
    expect(requestCount).toBe(2);
  });

  it("keeps the loaded calendar when Today stays within the current month", async () => {
    const fetchMock = renderCalendar();
    const leapDay = await screen.findByRole("gridcell", {
      name: /2028년 2월 29일 화요일, 일정 3개/u,
    });
    fireEvent.click(leapDay);
    fireEvent.click(screen.getByRole("button", { name: "월 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "오늘" }));

    expect(screen.getByRole("heading", { name: "2028년 2월 15일 화요일" })).toBeVisible();
    const today = screen.getByRole("gridcell", {
      name: /2028년 2월 15일 화요일, 일정 없음, 오늘/u,
    });
    await waitFor(() => expect(today).toHaveFocus());
    expect(
      screen.getByRole("gridcell", { name: /2028년 2월 29일 화요일, 일정 3개/u }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("moves roving focus with arrows and Home/End", async () => {
    renderCalendar();
    const today = await screen.findByRole("gridcell", {
      name: /2028년 2월 15일 화요일, 일정 없음, 오늘/u,
    });
    today.focus();

    fireEvent.keyDown(today, { key: "ArrowRight" });
    const nextDay = screen.getByRole("gridcell", {
      name: /2028년 2월 16일 수요일, 일정 없음/u,
    });
    await waitFor(() => expect(nextDay).toHaveFocus());
    expect(nextDay).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(nextDay, { key: "ArrowDown" });
    const nextWeek = screen.getByRole("gridcell", {
      name: /2028년 2월 23일 수요일, 일정 없음/u,
    });
    await waitFor(() => expect(nextWeek).toHaveFocus());

    fireEvent.keyDown(nextWeek, { key: "ArrowUp" });
    await waitFor(() => expect(nextDay).toHaveFocus());

    fireEvent.keyDown(nextDay, { key: "Home" });
    const weekStart = screen.getByRole("gridcell", {
      name: /2028년 2월 13일 일요일, 일정 없음/u,
    });
    await waitFor(() => expect(weekStart).toHaveFocus());

    fireEvent.keyDown(weekStart, { key: "End" });
    const weekEnd = screen.getByRole("gridcell", {
      name: /2028년 2월 19일 토요일, 일정 없음/u,
    });
    await waitFor(() => expect(weekEnd).toHaveFocus());
  });

  it("moves across a month boundary and requests the next six-week range", async () => {
    let resolveNextRequest: ((response: Response) => void) | undefined;
    const nextRequest = new Promise<Response>((resolve) => {
      resolveNextRequest = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/schedules/calendar?end_date=2028-03-11&start_date=2028-01-30") {
        return Promise.resolve(
          jsonResponse({
            end_date: "2028-03-11",
            items: leapDayItems,
            oldest_visible_date: "2027-11-17",
            server_today: "2028-02-15",
            start_date: "2028-01-30",
          }),
        );
      }
      if (url === "/api/v1/schedules/calendar?end_date=2028-04-08&start_date=2028-02-27") {
        return nextRequest;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    render(
      <MemoryRouter>
        <ScheduleCalendar serverToday="2028-02-15" />
      </MemoryRouter>,
    );
    const leapDay = await screen.findByRole("gridcell", {
      name: /2028년 2월 29일 화요일, 일정 3개/u,
    });
    leapDay.focus();

    fireEvent.keyDown(leapDay, { key: "ArrowRight" });

    expect(await screen.findByRole("heading", { name: "2028년 3월" })).toBeVisible();
    const pendingMonthDay = screen.getByRole("gridcell", {
      name: /2028년 3월 1일 수요일, 일정 확인 중/u,
    });
    await waitFor(() => expect(pendingMonthDay).toHaveFocus());
    expect(pendingMonthDay).not.toHaveAccessibleName(/일정 없음/u);

    await act(async () => {
      resolveNextRequest?.(
        jsonResponse({
          end_date: "2028-04-08",
          items: [],
          oldest_visible_date: "2027-11-17",
          server_today: "2028-02-15",
          start_date: "2028-02-27",
        }),
      );
      await nextRequest;
    });
    const nextMonthDay = await screen.findByRole("gridcell", {
      name: /2028년 3월 1일 수요일, 일정 없음/u,
    });
    await waitFor(() => expect(nextMonthDay).toHaveFocus());
    expect(await screen.findByText("이 달에 등록된 일정이 없어요.")).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestUrl(input) ===
          "/api/v1/schedules/calendar?end_date=2028-04-08&start_date=2028-02-27",
      ),
    ).toBe(true);
  });

  it("keeps focus on the oldest visible month boundary", async () => {
    renderOldestBoundaryCalendar();
    const oldestMonthDay = await screen.findByRole("gridcell", {
      name: /2028년 2월 1일 화요일, 일정 없음/u,
    });
    fireEvent.click(oldestMonthDay);
    await waitFor(() => expect(oldestMonthDay).toHaveFocus());

    fireEvent.keyDown(oldestMonthDay, { key: "ArrowLeft" });

    await waitFor(() => expect(oldestMonthDay).toHaveFocus());
    expect(oldestMonthDay).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "이전 달" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "2028년 2월" })).toBeVisible();
  });

  /*
   * 2026년 8월은 우선순위를 한 달 안에서 전부 확인할 수 있는 달이라 골랐다 —
   * 8/15 광복절이 **토요일과 겹치고**, 8/17이 대체공휴일이며, 8/29 토요일과
   * 8/30 일요일이 따로 있다. (한국천문연구원 월력요항 기준.)
   */
  it("paints holidays and sundays alike, saturdays apart, and lets a holiday beat a saturday", async () => {
    renderAugust2026Calendar();

    const holidayOnSaturday = await screen.findByRole("gridcell", {
      name: /2026년 8월 15일 토요일, 광복절 법정공휴일/u,
    });
    expect(holidayOnSaturday).toHaveAttribute("data-calendar-day-kind", "holiday");

    expect(
      screen.getByRole("gridcell", {
        name: /2026년 8월 17일 월요일, 대체공휴일\(광복절\) 법정공휴일/u,
      }),
    ).toHaveAttribute("data-calendar-day-kind", "holiday");
    expect(screen.getByRole("gridcell", { name: /2026년 8월 29일 토요일/u })).toHaveAttribute(
      "data-calendar-day-kind",
      "saturday",
    );
    expect(screen.getByRole("gridcell", { name: /2026년 8월 30일 일요일/u })).toHaveAttribute(
      "data-calendar-day-kind",
      "sunday",
    );
    expect(screen.getByRole("gridcell", { name: /2026년 8월 24일 월요일/u })).toHaveAttribute(
      "data-calendar-day-kind",
      "weekday",
    );

    // 공휴일·일요일은 같은 빨강, 토요일만 다른 파랑이다.
    expect(holidayOnSaturday.className).toContain("bg-calendar-holiday-soft");
    expect(screen.getByRole("gridcell", { name: /2026년 8월 30일 일요일/u }).className).toContain(
      "bg-calendar-holiday-soft",
    );
    expect(screen.getByRole("gridcell", { name: /2026년 8월 29일 토요일/u }).className).toContain(
      "bg-calendar-saturday-soft",
    );
  });

  it("names the holiday and its source in the selected-day card while keeping the selected aria state", async () => {
    renderAugust2026Calendar();

    const holiday = await screen.findByRole("gridcell", { name: /2026년 8월 15일 토요일/u });
    fireEvent.click(holiday);

    await waitFor(() => expect(holiday).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("heading", { name: "2026년 8월 15일 토요일" })).toBeVisible();
    expect(screen.getByText("광복절 · 법정공휴일")).toBeVisible();
    /* 고른 날은 색이 아니라 역할색 경계와 ARIA 상태로 알린다. */
    expect(holiday).toHaveClass("schedule-month-cell");
    expect(screen.getByText("광복절 · 법정공휴일")).toHaveClass("schedule-holiday-line");
    expect(holiday.querySelector("[data-calendar-day-holiday]")).toBeVisible();
  });

  it("leaves every day a plain weekday when no holiday source is supplied", async () => {
    renderAugust2026Calendar({ withHolidays: false });

    expect(
      await screen.findByRole("gridcell", { name: /2026년 8월 15일 토요일, 일정 없음/u }),
    ).toHaveAttribute("data-calendar-day-kind", "saturday");
    expect(screen.queryByText(/법정공휴일/u)).not.toBeInTheDocument();
  });
});
