import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MealsPage } from "./meals-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const longMenuName = "우리학교특제들깨버섯두부조림과아삭한제철채소무침이함께나오는긴메뉴이름";

const meal = {
  calorie_kcal: 1452.2,
  id: "17",
  meal_date: "2026-07-14",
  menu: [
    { allergens: [], name: "현미밥" },
    { allergens: ["1", "2", "18"], name: "달걀국" },
    {
      allergens: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "18", "19"],
      name: longMenuName,
    },
  ],
  source: "seed" as const,
  source_loaded_on: null,
  source_updated_at: "2026-07-14T00:30:00.000Z",
};

const week = {
  items: [
    { data: null, date: "2026-07-13", status: "empty" },
    { data: meal, date: "2026-07-14", status: "ok" },
    { data: null, date: "2026-07-15", status: "empty" },
    { data: null, date: "2026-07-16", status: "empty" },
    { data: null, date: "2026-07-17", status: "empty" },
  ],
  server_today: "2026-07-14",
};

function monthResponse(
  month: string,
  dayCount: number,
  mealDate: string | undefined = month === "2026-07" ? "2026-07-14" : undefined,
) {
  return {
    items: Array.from({ length: dayCount }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      return date === mealDate
        ? { data: meal, date, status: "ok" }
        : { data: null, date, status: "empty" };
    }),
    month,
    server_today: "2026-07-14",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function renderMealsRoute(initialEntry = "/meals"): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/bootstrap" element={<p>초기 설정 화면</p>} />
        <Route path="/login" element={<p>로그인 화면</p>} />
        <Route path="/meals" element={<MealsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderMeals(initialEntry = "/meals", role: "student" | "teacher" = "teacher") {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "LEAVE_CLASS"],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url === "/api/v1/meals/today") {
      return Promise.resolve(
        jsonResponse({ data: meal, server_today: "2026-07-14", status: "ok" }),
      );
    }
    if (url === "/api/v1/meals/week") return Promise.resolve(jsonResponse(week));
    if (url === "/api/v1/meals/month?month=2026-07") {
      return Promise.resolve(jsonResponse(monthResponse("2026-07", 31)));
    }
    if (url === "/api/v1/meals/month?month=2026-08") {
      return Promise.resolve(jsonResponse(monthResponse("2026-08", 31)));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  renderMealsRoute(initialEntry);
  return fetchMock;
}

describe("MealsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads the latest URL when the requested view changes before bootstrap finishes", async () => {
    const bootstrapRequest = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return bootstrapRequest.promise;
      if (url === "/api/v1/meals/month?month=2026-08") {
        return Promise.resolve(jsonResponse(monthResponse("2026-08", 31)));
      }
      if (url === "/api/v1/meals/week") return Promise.resolve(jsonResponse(week));
      return Promise.resolve(jsonResponse({ detail: "unexpected request" }, 500));
    });
    render(
      <MemoryRouter initialEntries={["/meals?view=week"]}>
        <Link to="/meals?view=month&month=2026-08">8월 급식으로 이동</Link>
        <Routes>
          <Route path="/meals" element={<MealsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("link", { name: "8월 급식으로 이동" }));
    await act(async () => bootstrapRequest.resolve(jsonResponse(teacherBootstrap)));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "월간 급식" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toContain(
      "/api/v1/meals/month?month=2026-08",
    );
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).not.toContain(
      "/api/v1/meals/week",
    );
  });

  it("switches next week and back without showing this week's menu under next week's dates", async () => {
    renderMeals("/meals?view=week");
    expect(await screen.findByText("현미밥")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "다음 주" }));
    expect(await screen.findByRole("radio", { name: /7월 20일/ })).toBeInTheDocument();
    expect(screen.queryByText("현미밥")).not.toBeInTheDocument();
    expect(screen.getByText("다음 주 급식이 아직 올라오지 않았어요.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "이번 주" }));
    expect(await screen.findByText("현미밥")).toBeVisible();
    expect(screen.getByRole("button", { name: "이번 주" })).toHaveAttribute("aria-pressed", "true");
  });

  it("retries only bootstrap in place and keeps the requested meal view", async () => {
    let bootstrapRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        bootstrapRequestCount += 1;
        return Promise.resolve(
          bootstrapRequestCount === 1
            ? jsonResponse(
                {
                  error: {
                    code: "QA_FORCED_503",
                    message: "잠시 후 다시 시도해 주세요.",
                  },
                },
                503,
              )
            : jsonResponse(teacherBootstrap),
        );
      }
      if (url === "/api/v1/meals/week") return Promise.resolve(jsonResponse(week));
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderMealsRoute("/meals?view=week&wave=bootstrap-retry");

    const retryButton = await screen.findByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    expect(await screen.findByText("현미밥")).toBeVisible();
    expect(screen.getByRole("tab", { name: "주간 급식" })).toHaveAttribute("aria-selected", "true");
    expect(bootstrapRequestCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/meals/week"),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET"),
    ).toBe(true);
  });

  it("renders the shared read-only today view with exact allergen labels", async () => {
    renderMeals();

    const menuName = await screen.findByText("현미밥");
    const pageHeading = screen.getByRole("heading", { level: 1, name: "급식" });
    expect(pageHeading).toBeVisible();
    expect(pageHeading.closest("header")).toHaveClass("content-frame-header");
    expect(menuName).toBeVisible();
    expect(menuName.closest("li")).toHaveClass("flex", "justify-between");
    expect(menuName).toHaveClass("text-[17px]");
    const todayCard = document.querySelector('[data-meal-date-card="2026-07-14"]');
    expect(todayCard).toHaveClass("content-card");
    expect(todayCard).toHaveAttribute("data-today", "true");
    expect(screen.getByRole("tabpanel", { name: "오늘 급식" })).toContainElement(
      todayCard as HTMLElement,
    );
    /*
     * 알레르기는 접힌 채로 시작한다(2026-08-17 Hex 결정) — 대부분에게 필요 없는 줄이
     * 화면을 밀어내지 않게. 다만 안전 정보라 **유무는 접힌 상태에서도 보인다**.
     */
    expect(
      screen.queryByText("알레르기 난류, 우유, 조개류(굴·전복·홍합 포함)"),
    ).not.toBeInTheDocument();
    /* 있는 메뉴에는 표시가 붙고, 없는 메뉴에는 안 붙는다 — 표시가 실제로 갈린다. */
    expect(screen.getByText("달걀국").closest("li")).toHaveTextContent("알레르기 있음");
    expect(
      screen.getByText("달걀국").closest("li")?.querySelector("[data-meal-allergen-numbers]"),
    ).toHaveTextContent("1 · 2 · 18");
    expect(menuName.closest("li")).not.toHaveTextContent("알레르기 있음");
    const sourceBadge = screen.getByText("학교 연동 정보 없음").closest("[data-meal-source]");
    expect(sourceBadge).toHaveAttribute("data-meal-source", "seed");
    expect(sourceBadge).toHaveTextContent("직접 등록");
    expect(sourceBadge?.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-07-14T00:30:00.000Z",
    );
    expect(screen.getByText(longMenuName)).toHaveClass("break-words", "[overflow-wrap:anywhere]");

    /* 펼치면 그때 상세가 나온다 — 긴 목록이 칸 안에서 접히는지도 여기서 잰다. */
    const allergenToggle = screen.getByRole("button", { name: /알레르기 정보 보기/u });
    expect(allergenToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(allergenToggle);
    expect(allergenToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("알레르기 난류, 우유, 조개류(굴·전복·홍합 포함)")).toBeVisible();
    expect(
      screen.getByText(
        /알레르기 난류, 우유, 메밀, 땅콩, 대두, 밀, 고등어, 게, 새우, 돼지고기.+잣/u,
      ),
    ).toHaveClass("break-words", "[overflow-wrap:anywhere]");

    /* 다시 누르면 접힌다 — 접기가 실제로 도는지 확인. */
    fireEvent.click(screen.getByRole("button", { name: "알레르기 정보 접기" }));
    expect(
      screen.queryByText("알레르기 난류, 우유, 조개류(굴·전복·홍합 포함)"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /등록|수정|삭제/u })).not.toBeInTheDocument();
    for (const navigation of screen.getAllByRole("navigation", { name: "주요 메뉴" })) {
      expect(within(navigation).getByRole("link", { name: "홈" })).toHaveAttribute("href", "/home");
    }
  });

  it("uses accessible URL-backed tabs and keeps the Monday-to-Friday five-day shape", async () => {
    const fetchMock = renderMeals();
    const tablist = await screen.findByRole("tablist", { name: "급식 조회 기간" });
    expect(tablist).toHaveClass("content-filters");
    const todayTab = within(tablist).getByRole("tab", { name: "오늘 급식" });
    const weekTab = within(tablist).getByRole("tab", { name: "주간 급식" });
    expect(todayTab).toHaveAttribute("aria-selected", "true");
    expect(weekTab).toHaveAttribute("tabindex", "-1");

    fireEvent.focus(todayTab);
    fireEvent.keyDown(todayTab, { key: "ArrowRight" });
    expect(weekTab).toHaveFocus();
    fireEvent.click(weekTab);

    const panel = await screen.findByRole("tabpanel", { name: "주간 급식" });
    const dayPicker = within(panel).getByRole("group", { name: "요일 선택" });
    const mondayRadio = within(dayPicker).getByRole("radio", {
      name: "7월 13일 월요일 · 급식 없음",
    });
    const todayRadio = within(dayPicker).getByRole("radio", {
      name: "7월 14일 화요일 · 급식 있음",
    });
    expect(within(dayPicker).getAllByRole("radio")).toHaveLength(5);
    expect(todayRadio).toBeChecked();
    todayRadio.focus();
    expect(todayRadio).toHaveFocus();
    expect(todayRadio.closest("label")).toHaveClass("min-h-[4.5rem]");
    const dayArticles = within(panel).getAllByRole("article");
    expect(dayArticles).toHaveLength(1);
    const dateList = document.querySelector('[data-meal-date-list="week"]');
    expect(dateList).toHaveClass("grid", "gap-3");
    expect(dayArticles[0]).toHaveClass("content-card");
    expect(
      within(panel)
        .getByRole("heading", { level: 3, name: "7월 14일 화요일" })
        .querySelector("time"),
    ).toHaveAttribute("datetime", "2026-07-14");
    expect(within(panel).getByText("급식 있음")).toBeVisible();
    expect(within(panel).getByRole("article", { name: "7월 14일 화요일" })).toHaveAttribute(
      "data-mobile-selected",
      "true",
    );

    fireEvent.click(mondayRadio);
    expect(mondayRadio).toBeChecked();
    const mondayArticle = within(panel).getByRole("article", { name: "7월 13일 월요일" });
    expect(mondayArticle).toHaveAttribute("data-mobile-selected", "true");
    expect(within(mondayArticle).getByText("급식 정보가 없어요.")).toBeVisible();
    expect(within(panel).getAllByRole("article")).toHaveLength(1);
    expect(within(panel).queryByRole("article", { name: "7월 14일 화요일" })).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/v1/meals/week")).toBe(
      true,
    );
  });

  it("renders a 31-day monthly calendar, calories, and future-month availability copy", async () => {
    const fetchMock = renderMeals("/meals?view=month&month=2026-07", "student");

    const panel = await screen.findByRole("tabpanel", { name: "월간 급식" });
    expect(within(panel).getByRole("heading", { name: "2026년 7월 급식" })).toBeVisible();
    expect(
      await within(panel).findAllByRole("button", { name: /급식 (있음|없음)$/u }),
    ).toHaveLength(31);
    expect(within(panel).getByText("총 1452.2 kcal")).toBeVisible();
    /*
     * 오늘은 색만이 아니라 읽어주는 이름으로도 알 수 있어야 한다. 색으로만 표시하면
     * 색을 못 보는 사람에게는 없는 표시다.
     */
    const todayCell = within(panel).getByRole("button", {
      name: "오늘 · 7월 14일 화요일 · 급식 있음",
    });
    expect(todayCell).toHaveAttribute("aria-pressed", "true");
    expect(todayCell).toHaveAttribute("data-today", "true");
    expect(
      within(panel).getByRole("button", { name: "7월 15일 수요일 · 급식 없음" }),
    ).toHaveAttribute("data-today", "false");

    fireEvent.click(within(panel).getByRole("button", { name: "다음 달 급식 보기" }));

    expect(
      await within(panel).findByText("아직 학교에서 이 달의 급식을 제공하지 않았어요."),
    ).toBeVisible();
    expect(within(panel).getByRole("heading", { name: "2026년 8월 급식" })).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestUrl(input) === "/api/v1/meals/month?month=2026-08",
      ),
    ).toBe(true);
  });

  it("honours a direct weekly URL before issuing the first meal request", async () => {
    const fetchMock = renderMeals("/meals?view=week", "student");

    expect(await screen.findByRole("tabpanel", { name: "주간 급식" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "주간 급식" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/meals/today"),
      ).toHaveLength(0);
    });
  });

  it("keeps the weekly panel identified during loading and recovers from an error", async () => {
    const firstWeekRequest = deferred<Response>();
    let weekRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/meals/week") {
        weekRequestCount += 1;
        if (weekRequestCount === 1) return firstWeekRequest.promise;
        return Promise.resolve(jsonResponse(week));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderMealsRoute("/meals?view=week");

    const panel = await screen.findByRole("tabpanel", { name: "주간 급식" });
    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(within(panel).getByRole("status")).toHaveTextContent("급식을 불러오는 중입니다.");

    firstWeekRequest.resolve(
      jsonResponse(
        { error: { code: "MEAL_LOOKUP_FAILED", message: "급식 조회가 지연되고 있습니다." } },
        503,
      ),
    );
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("급식을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button", "ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    const dayPicker = await within(panel).findByRole("group", { name: "요일 선택" });
    expect(within(dayPicker).getAllByRole("radio")).toHaveLength(5);
    expect(weekRequestCount).toBe(2);
  });

  it("keeps successful data with an accessible stale warning and blocks duplicate retry", async () => {
    const retryRequest = deferred<Response>();
    let todayRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/meals/today") {
        todayRequestCount += 1;
        if (todayRequestCount === 1) {
          return Promise.resolve(
            jsonResponse({ data: meal, server_today: "2026-07-14", status: "ok" }),
          );
        }
        if (todayRequestCount === 2) {
          return Promise.resolve(
            jsonResponse({ error: { code: "MEAL_LOOKUP_FAILED", message: "급식 조회 실패" } }, 503),
          );
        }
        return retryRequest.promise;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderMealsRoute();
    expect(await screen.findByText("현미밥")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "오늘 급식 새로고침" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("최신 급식 정보를 확인하지 못했어요.");
    expect(alert).toHaveTextContent(
      "이전에 불러온 급식을 계속 표시하고 있어 최신 정보와 다를 수 있어요.",
    );
    expect(screen.getByText("현미밥")).toBeVisible();
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("현미밥")).toBeVisible();
    fireEvent.click(retryButton);
    expect(todayRequestCount).toBe(3);

    retryRequest.resolve(
      jsonResponse({
        data: {
          calorie_kcal: 1452.2,
          id: "18",
          meal_date: "2026-07-14",
          menu: [{ allergens: [], name: "새로 갱신된 보리밥" }],
          source: "seed",
          source_loaded_on: null,
          source_updated_at: "2026-07-14T01:00:00.000Z",
        },
        server_today: "2026-07-14",
        status: "ok",
      }),
    );

    expect(await screen.findByText("새로 갱신된 보리밥")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText("현미밥")).not.toBeInTheDocument();
    expect(todayRequestCount).toBe(3);
  });

  it("keeps each cached view's stale warning when switching away and back", async () => {
    let todayRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/meals/today") {
        todayRequestCount += 1;
        if (todayRequestCount === 1) {
          return Promise.resolve(
            jsonResponse({ data: meal, server_today: "2026-07-14", status: "ok" }),
          );
        }
        return Promise.resolve(
          jsonResponse({ error: { code: "MEAL_LOOKUP_FAILED", message: "급식 조회 실패" } }, 503),
        );
      }
      if (url === "/api/v1/meals/week") return Promise.resolve(jsonResponse(week));
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderMealsRoute();
    expect(await screen.findByText("현미밥")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "오늘 급식 새로고침" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "최신 급식 정보를 확인하지 못했어요.",
    );

    fireEvent.click(screen.getByRole("tab", { name: "주간 급식" }));
    expect(await screen.findByRole("group", { name: "요일 선택" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "오늘 급식" }));
    expect(await screen.findByText("현미밥")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("최신 급식 정보를 확인하지 못했어요.");
    expect(todayRequestCount).toBe(2);
  });

  it("redirects to login when the bootstrap session has expired", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } }, 401),
      );

    renderMealsRoute();

    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual(["/api/v1/bootstrap"]);
  });

  it("redirects to login when the meal request finds an expired session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/meals/today") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } },
            401,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderMealsRoute();

    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input)).sort()).toEqual([
      "/api/v1/bootstrap",
      "/api/v1/help-requests?status=open",
      "/api/v1/meals/today",
    ]);
  });

  it("redirects HOME responses without a current membership to bootstrap", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ...teacherBootstrap, current_membership: null }));

    renderMealsRoute();

    expect(await screen.findByText("초기 설정 화면")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual(["/api/v1/bootstrap"]);
  });
});
