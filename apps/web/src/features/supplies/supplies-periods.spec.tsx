import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { SuppliesPage } from "./supplies-page";

const items = [
  ...Array.from({ length: 7 }, () => ({ needed_on: "2026-09-21" })),
  ...Array.from({ length: 23 }, () => ({ needed_on: "2026-09-22" })),
  ...Array.from({ length: 4 }, () => ({ needed_on: "2026-09-23" })),
  { needed_on: "2026-09-27" },
  ...Array.from({ length: 4 }, () => ({ needed_on: "2026-09-28" })),
  ...Array.from({ length: 2 }, () => ({ needed_on: "2026-09-22", category: "general" })),
  ...Array.from({ length: 3 }, () => ({
    needed_on: "2026-09-22",
    description: "영어 풀이를 준비해요.",
  })),
].map((item, index) => ({
  id: String(index + 1),
  row_version: "1",
  content_revision: "1",
  audience_mode: "all_snapshot",
  check_state: "unchecked",
  category: "homework",
  description: `${"설명 앞부분을 읽어 주세요. ".repeat(16)}수학 풀이를 준비해요.`,
  title: `연습 ${String(index + 1).padStart(2, "0")}`,
  ...item,
}));
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function fixture(
  scope: "today" | "this_week",
  role: "student" | "teacher" = "student",
  deferEnglish = false,
  options: { states?: boolean; checkState?: string } = {},
) {
  const fixtureItems = options.states
    ? items.map((item, index) => ({
        ...item,
        check_state: index < 8 ? "checked" : index < 33 ? "unchecked" : "modified_unconfirmed",
      }))
    : items;
  let today = "2026-09-22";
  const requests: URL[] = [];
  const pending: Array<() => void> = [];
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
        current_membership: { id: "1", class_id: "1", role, status: "approved" },
        teacher_profile:
          role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
        destination: "HOME",
        server_today: today,
      });
    if (url.pathname !== "/api/v1/supplies") throw new Error(`Unexpected API ${url.pathname}`);
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
    const type = url.searchParams.get("category"),
      term = url.searchParams.get("q");
    const state = url.searchParams.get("check_state");
    const selected = fixtureItems
      .filter(
        (item) =>
          (range === undefined
            ? item.needed_on >= today
            : item.needed_on >= range.start_date && item.needed_on <= range.end_date) &&
          (type === null || item.category === type) &&
          (state === null || item.check_state === state) &&
          (term === null || `${item.title} ${item.description}`.includes(term)),
      )
      .sort((a, b) => a.needed_on.localeCompare(b.needed_on) || Number(a.id) - Number(b.id));
    const response = json({
      items: selected.slice(offset, offset + 20),
      selected_audience_enabled: false,
      next_cursor: offset + 20 < selected.length ? `${stamp}/${offset + 20}` : null,
      server_today: today,
      date_range: range,
    });
    if (deferEnglish && term === "영어")
      return new Promise<Response>((resolve) => pending.push(() => resolve(response)));
    return response;
  });
  render(
    <MemoryRouter
      initialEntries={[
        `/supplies?scope=${scope}&category=homework${options.checkState === undefined ? "" : `&check_state=${options.checkState}`}`,
      ]}
    >
      <SuppliesPage />
    </MemoryRouter>,
  );
  return {
    requests,
    pending,
    setToday: (value: string) => {
      today = value;
    },
  };
}
async function searchMath(requests: URL[]) {
  const input = await screen.findByRole("searchbox", { name: "준비물·숙제 검색" });
  // Drive the real debounce explicitly and verify its 300ms boundary.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.change(input, { target: { value: "수학" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(requests.at(-1)?.searchParams.get("q")).not.toBe("수학");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  } finally {
    vi.useRealTimers();
  }
  expect(input).toHaveValue("수학");
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("수학"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "준비물·숙제 더 보기" })).toBeEnabled(),
  );
}
async function nextPage(number: number) {
  const visibleCount = () =>
    screen.getByRole("list", { name: "준비물·숙제 목록" }).querySelectorAll("a").length;
  if (visibleCount() >= (number - 1) * 10 + 1) return;
  const before = visibleCount();
  fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 더 보기" }));
  await waitFor(() => expect(visibleCount()).toBeGreaterThan(before));
}
function dateRangeValues() {
  return [...document.querySelectorAll("[data-supply-date-range] time")].map((node) =>
    node.getAttribute("datetime"),
  );
}

describe("nearby supply and homework periods", () => {
  afterEach(() => {
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps a pending search when collapsing filters and focuses the results", async () => {
    const { requests } = fixture("this_week", "student", false, { checkState: "unchecked" });
    await screen.findByRole("link", { name: /연습 01/u });
    const input = screen.getByRole("searchbox");
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 검색 열기" }));
    fireEvent.change(input, { target: { value: "수학" } });
    fireEvent.click(screen.getByRole("button", { name: "검색 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "결과 보기" }));
    expect(screen.getByRole("heading", { name: "조회 결과" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "준비물·숙제 검색 열기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("수학"));
    expect(requests.at(-1)?.searchParams.get("check_state")).toBe("unchecked");
    expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
    expect(screen.getByRole("tab", { name: "이번 주 준비물·숙제" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "숙제" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "내 확인 상태" })).toHaveValue("unchecked");
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 검색 열기" }));
    expect(screen.getByRole("searchbox")).toBe(input);
    expect(input).toHaveValue("수학");
    fireEvent.click(screen.getByRole("button", { name: "검색 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "검색·필터 초기화" }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("check_state")).toBeNull());
    expect(requests.at(-1)?.searchParams.get("q")).toBeNull();
    expect(requests.at(-1)?.searchParams.get("scope")).toBe("this_week");
    expect(screen.getByRole("button", { name: "준비물·숙제 검색 열기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it.each([
    { state: "unchecked", first: "09", pages: 3, lastCount: 25 },
    { state: "modified_unconfirmed", first: "34", pages: 1, lastCount: 2 },
    { state: "checked", first: "01", pages: 1, lastCount: 8 },
  ])(
    "combines personal $state deep links with search, category and all result pages",
    async ({ state, first, pages, lastCount }) => {
      const { requests } = fixture("this_week", "student", false, {
        states: true,
        checkState: state,
      });
      await screen.findByRole("link", { name: new RegExp(`연습 ${first}`, "u") });
      expect(screen.getByRole("combobox", { name: "내 확인 상태" })).toHaveValue(state);
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "수학" } });
      await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("수학"));
      await waitFor(() =>
        expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false"),
      );
      for (let number = 2; number <= pages; number++) await nextPage(number);
      expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem")).toHaveLength(lastCount);
      expect(screen.queryByRole("button", { name: "준비물·숙제 더 보기" })).not.toBeInTheDocument();
      expect(requests.at(-1)?.searchParams.get("check_state")).toBe(state);
      expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
      expect(requests.at(-1)?.searchParams.get("scope")).toBe("this_week");
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
      await screen.findByRole("link", { name: /연습 01/u });
      expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
      expect(screen.getByRole("searchbox")).toHaveValue("수학");
      expect(requests.at(-1)?.searchParams.get("check_state")).toBeNull();
      expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
    },
  );

  it("ignores a late prior-state response and invalidates state caches across periods", async () => {
    const { requests, pending } = fixture("this_week", "student", true, {
      states: true,
      checkState: "modified_unconfirmed",
    });
    await screen.findByRole("link", { name: /연습 34/u });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "영어" } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unchecked" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!();
    await screen.findByText("검색 결과가 없어요.");
    pending[0]!();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /연습 42/u })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "검색어 지우기" }));
    await screen.findByRole("link", { name: /연습 09/u });
    fireEvent.click(screen.getByRole("tab", { name: "오늘 준비물·숙제" }));
    await screen.findByRole("link", { name: /연습 09/u });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "checked" } });
    await screen.findByRole("link", { name: /연습 08/u });
    fireEvent.click(screen.getByRole("tab", { name: "이번 주 준비물·숙제" }));
    await screen.findByRole("link", { name: /연습 01/u });
    expect(requests.at(-1)?.searchParams.get("check_state")).toBe("checked");
    expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
    expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem")).toHaveLength(8);
  });

  it("does not offer or send personal state filtering for a teacher deep link", async () => {
    const { requests } = fixture("this_week", "teacher", false, {
      states: true,
      checkState: "unchecked",
    });
    await screen.findByRole("link", { name: /연습 01/u });
    expect(screen.queryByRole("combobox", { name: "내 확인 상태" })).not.toBeInTheDocument();
    expect(requests.every((url) => url.searchParams.get("check_state") === null)).toBe(true);
  });

  it.each([
    {
      scope: "today",
      label: "오늘 준비물·숙제",
      role: "student",
      pages: 3,
      count: 23,
      dates: ["2026-09-22"],
    },
    {
      scope: "this_week",
      label: "이번 주 준비물·숙제",
      role: "teacher",
      pages: 4,
      count: 35,
      dates: ["2026-09-21", "2026-09-27"],
    },
  ] as const)(
    "combines $scope with description/category and pages only that period for $role",
    async ({ scope, label, pages, count, dates, role }) => {
      const { requests } = fixture(scope, role);
      await searchMath(requests);
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      expect(dateRangeValues()).toEqual(dates);
      const firstDescription = within(screen.getByRole("tabpanel", { name: label }))
        .getAllByRole("link")[0]!
        .querySelector("p");
      expect(firstDescription).toHaveTextContent(/^…수학 풀이/u);
      expect(firstDescription?.querySelector("mark")).toHaveTextContent("수학");
      expect(firstDescription).toHaveClass("line-clamp-4");
      for (let number = 2; number <= pages; number++) await nextPage(number);
      expect(
        within(screen.getByRole("tabpanel", { name: label })).getAllByRole("listitem"),
      ).toHaveLength(count);
      expect(screen.queryByRole("button", { name: "준비물·숙제 더 보기" })).not.toBeInTheDocument();
      expect(requests.at(-1)?.searchParams.get("scope")).toBe(scope);
      expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
      expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
      expect(requests.at(-1)?.searchParams.get("cursor")).toContain("/20");
      if (scope === "this_week")
        expect(screen.getByRole("link", { name: /연습 35/u })).toHaveAttribute(
          "href",
          "/supplies/35",
        );
    },
  );

  it("clears an empty search and category while keeping this week's period", async () => {
    const { requests } = fixture("this_week", "student", false, {
      states: true,
      checkState: "unchecked",
    });
    await searchMath(requests);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "없는내용" } });
    await screen.findByText("검색 결과가 없어요.");
    fireEvent.click(screen.getByRole("button", { name: "검색·필터 초기화" }));
    await screen.findByRole("link", { name: /연습 01/u });
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "전체" })).toHaveAttribute("aria-pressed", "true");
    expect(requests.at(-1)?.searchParams.get("scope")).toBe("this_week");
    expect(requests.at(-1)?.searchParams.get("category")).toBeNull();
    expect(requests.at(-1)?.searchParams.get("q")).toBeNull();
    expect(requests.at(-1)?.searchParams.get("check_state")).toBeNull();
    expect(screen.getByRole("combobox", { name: "내 확인 상태" })).toHaveValue("");
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
    const description = screen.getByRole("link", { name: /연습 01/u }).querySelector("p");
    expect(description).toHaveTextContent(/^설명 앞부분/u);
    expect(description?.querySelector("mark")).toBeNull();
    expect(description).toHaveClass("line-clamp-2");
  });

  it("ignores a late old-period search and resets cached results on category change", async () => {
    const { requests, pending } = fixture("this_week", "student", true);
    await screen.findByRole("link", { name: /연습 01/u });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "영어" } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole("tab", { name: "오늘 준비물·숙제" }));
    await searchMath(requests);
    await screen.findByRole("link", { name: /연습 08/u });
    for (const resolve of pending) resolve();
    fireEvent.click(screen.getByRole("button", { name: "준비물" }));
    await screen.findByRole("link", { name: /연습 40/u });
    fireEvent.click(screen.getByRole("tab", { name: "이번 주 준비물·숙제" }));
    await screen.findByRole("link", { name: /연습 40/u });
    expect(
      within(screen.getByRole("tabpanel", { name: "이번 주 준비물·숙제" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
    expect(requests.at(-1)?.searchParams.get("category")).toBe("general");
    expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
    expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
  });

  it("re-reads today's range on tab return and preserves the search and type", async () => {
    const { requests, setToday } = fixture("today");
    await searchMath(requests);
    fireEvent.click(screen.getByRole("tab", { name: "다가오는 준비물·숙제" }));
    await screen.findByRole("link", { name: /연습 08/u });
    setToday("2026-09-23");
    fireEvent.click(screen.getByRole("tab", { name: "오늘 준비물·숙제" }));
    await screen.findByRole("link", { name: /연습 31/u });
    expect(dateRangeValues()).toEqual(["2026-09-23"]);
    expect(screen.queryByRole("link", { name: /연습 08/u })).not.toBeInTheDocument();
    expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
    expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
  });

  it("replaces old results with page one when a next-page cursor crosses midnight", async () => {
    const { requests, setToday } = fixture("today");
    await searchMath(requests);
    await nextPage(2);
    const before = requests.length;
    setToday("2026-09-23");
    fireEvent.click(screen.getByRole("button", { name: "준비물·숙제 더 보기" }));
    await screen.findByRole("link", { name: /연습 31/u });
    expect(screen.queryByText(/^[0-9]+페이지$/u)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tabpanel", { name: "오늘 준비물·숙제" })).getAllByRole("listitem"),
    ).toHaveLength(4);
    expect(requests.slice(before).map((url) => url.searchParams.get("cursor"))).toEqual([
      "2026-09-22/2026-09-22/20",
      null,
    ]);
    expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
    expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
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
      expect(screen.getByRole("tabpanel", { name: "이번 주 준비물·숙제" })).toHaveAttribute(
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
    expect(screen.getByRole("button", { name: "숙제" })).toHaveAttribute("aria-pressed", "true");
  });
});
