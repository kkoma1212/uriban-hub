import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PastClassUpdatesPage } from "./past-class-updates-page";
import { PastClassesEntry } from "./past-classes-entry";
import { PastClassesPage } from "./past-classes-page";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
const url = (input: RequestInfo | URL): string =>
  String(input instanceof Request ? input.url : input);

const pastClass = (id: string, year: number) => ({
  academic_year: year,
  archived_at: `${year + 1}-02-20T01:00:00.000000Z`,
  class_id: id,
  class_name: `${id}반`,
  grade: 2,
  role: "teacher" as const,
  school_name: "합성 고등학교",
  visible_until: `${year + 2}-02-20T01:00:00.000000Z`,
});

const feedItem = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  audience_mode: "legacy_class",
  category: "general",
  content: `${title} 본문`,
  content_revision: "1",
  id,
  is_important: false,
  kind: "notice",
  needed_on: null,
  published_at: "2025-09-01T01:00:00.000000Z",
  row_version: "1",
  title,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("past classes (S1)", () => {
  it("hides the entry without past classes and shows the count when there are some", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ items: [] }));
    const { unmount } = render(
      <MemoryRouter>
        <PastClassesEntry />
      </MemoryRouter>,
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /지난 반 기록/u })).not.toBeInTheDocument();
    unmount();

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ items: [pastClass("1", 2025), pastClass("2", 2024)] }),
    );
    render(
      <MemoryRouter>
        <PastClassesEntry />
      </MemoryRouter>,
    );
    const entry = await screen.findByRole("link", { name: /지난 반 기록/u });
    expect(entry).toHaveAttribute("href", "/past-classes");
    expect(entry).toHaveTextContent("지난 반 2개");
  });

  it("lists past classes and filters them by academic year", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ items: [pastClass("1", 2025), pastClass("2", 2024)] }),
    );
    render(
      <MemoryRouter>
        <PastClassesPage />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "지난 반 목록" });
    expect(within(list).getAllByRole("link")).toHaveLength(2);
    expect(within(list).getAllByRole("link")[0]).toHaveAttribute("href", "/past-classes/1");

    fireEvent.click(screen.getByRole("button", { name: "2024학년도" }));
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(within(list).getByRole("link")).toHaveAttribute("href", "/past-classes/2");
  });

  it("reads a past class feed read-only, with type filter and more pages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const requested = url(input);
      if (requested === "/api/v1/past-classes") return json({ items: [pastClass("1", 2025)] });
      if (requested.includes("cursor=next"))
        return json({
          items: [feedItem("3", "두 번째 쪽 공지")],
          next_cursor: null,
          selected_audience_enabled: true,
          server_today: "2026-09-26",
        });
      return json({
        items: [
          feedItem("1", "지난 공지"),
          feedItem("2", "지난 준비물", {
            kind: "supply",
            needed_on: "2025-03-02",
            category: "homework",
          }),
        ],
        next_cursor: "next",
        selected_audience_enabled: true,
        server_today: "2026-09-26",
      });
    });
    render(
      <MemoryRouter initialEntries={["/past-classes/1"]}>
        <Routes>
          <Route element={<PastClassUpdatesPage />} path="/past-classes/:classId" />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "2025학년도 2학년 1반" })).toBeVisible();
    const list = screen.getByRole("list", { name: "지난 반 소식 목록" });
    expect(within(list).getByText("지난 공지")).toBeVisible();
    expect(within(list).getByText(/숙제 · 2025-03-02 필요/u)).toBeVisible();
    // 읽기 전용: 확인·체크·수정 버튼이 없다.
    expect(screen.queryByRole("button", { name: /확인|체크|수정|삭제/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(await within(list).findByText("두 번째 쪽 공지")).toBeVisible();
    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "숙제" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          url(input).startsWith("/api/v1/past-classes/1/updates?filter=homework"),
        ),
      ).toBe(true),
    );
  });

  it("담임으로 있던 지난 반에서만 반 기록 내려받기를 보이고 그 반 주소로 받는다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const requested = url(input);
      if (requested === "/api/v1/past-classes")
        return json({
          items: [pastClass("1", 2025), { ...pastClass("2", 2024), role: "student" }],
        });
      if (requested.endsWith("/records.csv")) return new Response("\uFEFF\r\n");
      return json({
        items: [],
        next_cursor: null,
        selected_audience_enabled: true,
        server_today: "2026-09-26",
      });
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:records");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const { unmount } = render(
      <MemoryRouter initialEntries={["/past-classes/1"]}>
        <Routes>
          <Route element={<PastClassUpdatesPage />} path="/past-classes/:classId" />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "반 기록 CSV 받기" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([input]) => url(input))).toContain(
      "/api/v1/past-classes/1/records.csv",
    );
    unmount();

    render(
      <MemoryRouter initialEntries={["/past-classes/2"]}>
        <Routes>
          <Route element={<PastClassUpdatesPage />} path="/past-classes/:classId" />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "2024학년도 2학년 2반" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "반 기록 CSV 받기" })).not.toBeInTheDocument();
  });

  it("shows a plain not-found state for an expired or foreign class", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      url(input) === "/api/v1/past-classes"
        ? json({ items: [] })
        : json({ error: { code: "NOT_FOUND", message: "지난 반을 찾을 수 없습니다." } }, 404),
    );
    render(
      <MemoryRouter initialEntries={["/past-classes/77"]}>
        <Routes>
          <Route element={<PastClassUpdatesPage />} path="/past-classes/:classId" />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("이 반의 기록을 찾을 수 없어요.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "지난 반 소식 목록" })).not.toBeInTheDocument();
  });
});
