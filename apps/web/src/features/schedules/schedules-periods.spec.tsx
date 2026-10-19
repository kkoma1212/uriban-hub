import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { SchedulesPage } from "./schedules-page";

vi.mock("./schedule-calendar", () => ({
  ScheduleCalendar: () => <section aria-label="월간 일정 달력" />,
}));

const items = [
  ...Array.from({ length: 7 }, () => ({ due_date: "2026-09-21" })),
  ...Array.from({ length: 23 }, () => ({ due_date: "2026-09-22" })),
  ...Array.from({ length: 4 }, () => ({ due_date: "2026-09-23" })),
  { due_date: "2026-09-27" },
  ...Array.from({ length: 4 }, () => ({ due_date: "2026-09-28" })),
  ...Array.from({ length: 2 }, () => ({ due_date: "2026-09-22", schedule_type: "exam" })),
  ...Array.from({ length: 3 }, () => ({ due_date: "2026-09-22", subject: "영어" })),
].map((item, index) => ({
  id: String(index + 1),
  row_version: "1",
  days_until: 0,
  d_day_label: null,
  schedule_type: "assignment",
  subject: "수학",
  description: "풀이를 준비해요.",
  title: `연습 ${String(index + 1).padStart(2, "0")}`,
  ...item,
}));
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function fixture(scope: "today" | "this_week") {
  let today = "2026-09-22";
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://classhub.test",
    );
    if (url.pathname === "/api/v1/bootstrap")
      return json({
        account: { display_name: "합성 학생", email_verified: true, is_active: true },
        allowed_actions: ["VIEW_CLASS", "LOGOUT"],
        current_class: { id: "1", name: "합성 반", status: "active" },
        current_membership: { id: "1", class_id: "1", role: "student", status: "approved" },
        teacher_profile: null,
        destination: "HOME",
        server_today: today,
      });
    if (url.pathname !== "/api/v1/schedules") throw new Error(`Unexpected API ${url.pathname}`);
    requests.push(url);
    const period = url.searchParams.get("scope");
    const range =
      period === "today"
        ? { start_date: today, end_date: today }
        : period === "this_week"
          ? today < "2026-09-28"
            ? { start_date: "2026-09-21", end_date: "2026-09-27" }
            : { start_date: "2026-09-28", end_date: "2026-10-04" }
          : undefined;
    const stamp = range === undefined ? "upcoming" : `${range.start_date}/${range.end_date}`;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !cursor.startsWith(`${stamp}/`))
      return json({ error: { code: "INVALID_CURSOR", message: "period changed" } }, 400);
    const offset = Number(cursor?.split("/").at(-1) ?? 0);
    const type = url.searchParams.get("schedule_type"),
      term = url.searchParams.get("q");
    const selected = items
      .filter(
        (item) =>
          (range === undefined
            ? item.due_date >= today
            : item.due_date >= range.start_date && item.due_date <= range.end_date) &&
          (type === null || item.schedule_type === type) &&
          (term === null || `${item.subject} ${item.title} ${item.description}`.includes(term)),
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || Number(a.id) - Number(b.id));
    return json({
      items: selected.slice(offset, offset + 20),
      next_cursor: offset + 20 < selected.length ? `${stamp}/${offset + 20}` : null,
      server_today: today,
      date_range: range,
    });
  });
  render(
    <MemoryRouter initialEntries={[`/schedules?scope=${scope}&schedule_type=assignment`]}>
      <SchedulesPage />
    </MemoryRouter>,
  );
  return {
    requests,
    setToday: (value: string) => {
      today = value;
    },
  };
}
async function searchMath(requests: URL[]) {
  fireEvent.change(await screen.findByRole("searchbox", { name: "과목·일정 검색" }), {
    target: { value: "수학" },
  });
  // 검색은 0.3초 모았다가 보낸다(content-search-box). 전체 시험이 함께 돌아 느려지면 기본 대기 1초를 넘겨
  // 가끔 실패했다(2026-10-04, 6번 중 1~2번) — 동작이 아니라 기다리는 시간만 늘린다.
  const settle = { timeout: 3_000 };
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("수학"), settle);
  await waitFor(
    () => expect(screen.getByRole("button", { name: "일정 더 보기" })).toBeEnabled(),
    settle,
  );
}
async function nextPage(number: number) {
  const visibleCount = () =>
    screen.getByRole("list", { name: "일정 목록" }).querySelectorAll("a").length;
  if (visibleCount() >= (number - 1) * 10 + 1) return;
  const before = visibleCount();
  fireEvent.click(screen.getByRole("button", { name: "일정 더 보기" }));
  await waitFor(() => expect(visibleCount()).toBeGreaterThan(before));
}
function dateRangeValues() {
  return [...document.querySelectorAll("[data-schedule-date-range] time")].map((node) =>
    node.getAttribute("datetime"),
  );
}

describe("nearby schedule periods", () => {
  afterEach(() => {
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    { scope: "today", label: "오늘", pages: 3, count: 23, dates: ["2026-09-22"] },
    {
      scope: "this_week",
      label: "이번 주",
      pages: 4,
      count: 35,
      dates: ["2026-09-21", "2026-09-27"],
    },
  ] as const)(
    "combines $scope with subject/type and pages only that period",
    async ({ scope, label, pages, count, dates }) => {
      const { requests } = fixture(scope);
      await searchMath(requests);
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      expect(dateRangeValues()).toEqual(dates);
      for (let number = 2; number <= pages; number++) await nextPage(number);
      expect(
        within(screen.getByRole("tabpanel", { name: label })).getAllByRole("listitem"),
      ).toHaveLength(count);
      expect(screen.queryByRole("button", { name: "일정 더 보기" })).not.toBeInTheDocument();
      expect(requests.at(-1)?.searchParams.get("scope")).toBe(scope);
      expect(requests.at(-1)?.searchParams.get("schedule_type")).toBe("assignment");
      expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
      expect(requests.at(-1)?.searchParams.get("cursor")).toContain("/20");
      if (scope === "this_week")
        expect(screen.getByRole("link", { name: /연습 35/u })).toHaveAttribute(
          "href",
          "/schedules/35",
        );
    },
  );

  it("re-reads today's range on tab return and preserves the search and type", async () => {
    const { requests, setToday } = fixture("today");
    await searchMath(requests);
    fireEvent.click(screen.getByRole("tab", { name: "다가오는 일정" }));
    await screen.findByRole("link", { name: /연습 08/u });
    setToday("2026-09-23");
    fireEvent.click(screen.getByRole("tab", { name: "오늘" }));
    await screen.findByRole("link", { name: /연습 31/u });
    expect(dateRangeValues()).toEqual(["2026-09-23"]);
    expect(screen.queryByRole("link", { name: /연습 08/u })).not.toBeInTheDocument();
    expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
    expect(requests.at(-1)?.searchParams.get("schedule_type")).toBe("assignment");
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
  });

  it("replaces old results with page one when a next-page cursor crosses midnight", async () => {
    const { requests, setToday } = fixture("today");
    await searchMath(requests);
    await nextPage(2);
    const before = requests.length;
    setToday("2026-09-23");
    fireEvent.click(screen.getByRole("button", { name: "일정 더 보기" }));
    await screen.findByRole("link", { name: /연습 31/u });
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tabpanel", { name: "오늘" })).getAllByRole("listitem"),
    ).toHaveLength(4);
    expect(requests.slice(before).map((url) => url.searchParams.get("cursor"))).toEqual([
      "2026-09-22/2026-09-22/20",
      null,
    ]);
    expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
    expect(requests.at(-1)?.searchParams.get("schedule_type")).toBe("assignment");
    expect(dateRangeValues()).toEqual(["2026-09-23"]);
  });

  it("refreshes the current page on foregrounding and resets it only when the week changes", async () => {
    const { requests, setToday } = fixture("this_week");
    await searchMath(requests);
    await nextPage(2);
    await nextPage(3);
    const before = requests.length;
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByRole("tabpanel", { name: "이번 주" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(requests.slice(before).map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "2026-09-21/2026-09-27/20",
    ]);
    expect(screen.getByRole("link", { name: /연습 01/u })).toBeVisible();
    expect(screen.getByRole("link", { name: /연습 35/u })).toBeVisible();
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
    setToday("2026-09-28");
    fireEvent(window, new Event("focus"));
    await screen.findByRole("link", { name: /연습 36/u });
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
    expect(dateRangeValues()).toEqual(["2026-09-28", "2026-10-04"]);
    expect(screen.getByRole("searchbox")).toHaveValue("수학");
    expect(screen.getByRole("button", { name: "과제" })).toHaveAttribute("aria-pressed", "true");
  });
});
