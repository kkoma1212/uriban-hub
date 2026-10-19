import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompactContentProgress,
  DateGroupedList,
  contentDateGroup,
  isDueSoon,
  readContentList,
  useContentListPosition,
} from "./content-list-view";

describe("content list dates and restoration", () => {
  it("groups KST dates at the day and Monday boundaries without inventing a date", () => {
    expect(contentDateGroup("2026-09-27T15:01:00Z", "2026-09-28")).toBe("오늘");
    expect(contentDateGroup("2026-09-27", "2026-09-28")).toBe("지난주");
    expect(contentDateGroup("2026-09-29", "2026-09-28")).toBe("이번 주");
    expect(contentDateGroup("2026-10-05", "2026-09-28")).toBe("다가오는 날");
    expect(contentDateGroup("2026-09-20", "2026-09-28")).toBe("그 전");
    expect(contentDateGroup("unknown", "2026-09-28")).toBe("날짜 미정");
    expect(isDueSoon("2026-09-29", "2026-09-28")).toBe(true);
    expect(isDueSoon("2026-09-30", "2026-09-28")).toBe(false);
  });

  it("restores every expanded batch using fresh returned cursors", async () => {
    const request = vi.fn(async (cursor: string | undefined) => ({
      items:
        cursor === undefined
          ? ["first", "second"]
          : cursor === "fresh-2"
            ? ["third", "fourth"]
            : ["fifth"],
      next_cursor: cursor === undefined ? "fresh-2" : cursor === "fresh-2" ? "fresh-3" : null,
      server_today: "2026-09-28",
    }));
    const loaded = await readContentList(request, "stale-3", {
      index: 2,
      pages: [
        { cursor: undefined, offset: 0, start: 1 },
        { cursor: "stale-2", offset: 0, start: 3 },
        { cursor: "stale-3", offset: 0, start: 5 },
      ],
    });
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "fresh-2", "fresh-3"]);
    expect(loaded.result.items).toEqual(["first", "second", "third", "fourth", "fifth"]);
    expect(loaded.restore?.pages).toEqual([
      { cursor: undefined, offset: 0, start: 1 },
      { cursor: "fresh-2", offset: 0, start: 3 },
      { cursor: "fresh-3", offset: 0, start: 5 },
    ]);
  });

  it("reads legacy ten-item page bookmarks once per server batch", async () => {
    const request = vi.fn(async (cursor: string | undefined) => ({
      items: [cursor ?? "first"],
      next_cursor: cursor === undefined ? "next" : null,
    }));
    await readContentList(request, "next", {
      index: 3,
      pages: [
        { cursor: undefined, offset: 0, start: 1 },
        { cursor: undefined, offset: 10, start: 11 },
        { cursor: "next", offset: 0, start: 21 },
        { cursor: "next", offset: 10, start: 31 },
      ],
    });
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "next"]);
  });

  it("restarts when a date boundary changes during restoration", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["old first"],
        next_cursor: "old-next",
        server_today: "2026-09-27",
      })
      .mockResolvedValueOnce({ items: ["new tail"], next_cursor: null, server_today: "2026-09-28" })
      .mockResolvedValueOnce({
        items: ["new first"],
        next_cursor: null,
        server_today: "2026-09-28",
      });
    const loaded = await readContentList(request, "old-next", {
      index: 1,
      pages: [
        { cursor: undefined, offset: 0, start: 1 },
        { cursor: "old-next", offset: 0, start: 21 },
      ],
    });
    expect(loaded.result.items).toEqual(["new first"]);
    expect(loaded.restore).toBeUndefined();
  });

  it("stores all expanded server batches and replaces the record on a new query", () => {
    const { result } = renderHook(() => useContentListPosition());
    act(() => result.current.received("all", 0, 20, false));
    act(() => result.current.received("all", 20, 20, true, "batch-2"));
    act(() => result.current.received("all", 40, 10, true, "batch-3"));
    expect(result.current.page("all", []).snapshot).toEqual({
      index: 2,
      pages: [
        { cursor: undefined, offset: 0, start: 1 },
        { cursor: "batch-2", offset: 0, start: 21 },
        { cursor: "batch-3", offset: 0, start: 41 },
      ],
    });
    act(() => result.current.received("all", 50, 2, false));
    expect(result.current.page("all", []).snapshot.pages).toEqual([
      { cursor: undefined, offset: 0, start: 1 },
    ]);
  });
});

describe("content list presentation and progress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("moves expired entries to the end of their own date group without changing source order", () => {
    const items = [
      { title: "지난 숙제", date: "2026-09-28", past: true },
      { title: "오늘 공지", date: "2026-09-28", past: false },
      { title: "다음 준비물", date: "2026-09-28", past: false },
      { title: "더 오래된 공지", date: "2026-09-20", past: false },
    ];
    render(
      <DateGroupedList
        items={items}
        dateFor={(item) => item.date}
        moveLast={(item) => item.past}
        today="2026-09-28"
        label="소식 목록"
        renderItem={(item) => <li key={item.title}>{item.title}</li>}
      />,
    );
    expect(
      within(screen.getByRole("list"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["오늘 공지", "다음 준비물", "지난 숙제", "더 오래된 공지"]);
    expect(items[0]?.title).toBe("지난 숙제");
  });

  it("observes the PC list scroll area and starts at most three visible progress requests", async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      options?: IntersectionObserverInit;
    }> = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          observers.push({ callback, ...(options === undefined ? {} : { options }) });
        }
        observe() {}
        disconnect() {}
      },
    );
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const { container } = render(
      <div className="content-split-main">
        {["1", "2", "3", "4"].map((id) => (
          <CompactContentProgress key={id} id={id} kind="notice" revision="1" doneLabel="확인" />
        ))}
      </div>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(observers).toHaveLength(4);
    expect(
      observers.every(
        ({ options }) => options?.root === container.firstChild && options.rootMargin === "80px",
      ),
    ).toBe(true);
    act(() => {
      for (const observer of observers)
        observer.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(container.querySelectorAll('[data-content-progress="waiting"]')).toHaveLength(1);
    const reply = () =>
      new Response(
        JSON.stringify({
          content_revision: "1",
          counts: { confirmed: 3, unread: 2, modified_unconfirmed: 1 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    await act(async () => pending.shift()?.(reply()));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => {
      for (const finish of pending.splice(0)) finish(reply());
    });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-content-progress="ready"]')).toHaveLength(4),
    );
    expect(screen.getAllByText("3명 남음")).toHaveLength(4);
  });
});
