import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulesPage } from "../schedules/schedules-page";
import { SuppliesPage } from "../supplies/supplies-page";
import { UpdatesPage } from "../updates/updates-page";

const bootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "합성 학급", status: "active" },
  current_membership: { id: "1", class_id: "1", role: "student", status: "approved" },
  destination: "HOME",
  server_today: "2026-09-22",
  teacher_profile: null,
};
const items = Array.from({ length: 23 }, (_, index) => ({
  audience_mode: "all_snapshot",
  category: "homework",
  check_state: "unchecked",
  content: null,
  content_revision: "1",
  d_day_label: "D-1",
  description: null,
  due_date: "2026-09-23",
  id: String(index + 1),
  is_important: false,
  kind: "supply",
  needed_on: "2026-09-23",
  published_at: "2026-09-22T03:00:00Z",
  row_version: "1",
  schedule_type: "assignment",
  subject: "수학",
  title: `합성 과제 ${String(index + 1).padStart(2, "0")}`,
}));
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
/** 검색어 강조로 글자가 나뉜 카드도 링크 안 글자 전체로 찾는다. */
function supplyCard(text: string): HTMLElement | undefined {
  return screen.queryAllByRole("link").find((link) => link.textContent?.includes(text));
}

function urlOf(input: RequestInfo | URL): URL {
  return new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "https://classhub.test",
  );
}

describe("content list pagination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  /*
   * 2026-09-27 확정 시안: 쪽 번호 대신 서버 한 번(20개)씩 "더 보기"로 이어 붙인다.
   * 지키는 것은 같다 — 한 번에 끝없이 받지 않고, 이어 받기가 실패해도 보던 목록은 그대로다.
   */
  it.each([
    ["updates", "소식", "지난 소식 더 보기", UpdatesPage],
    ["supplies", "준비물", "준비물·숙제 더 보기", SuppliesPage],
    ["schedules", "일정", "일정 더 보기", SchedulesPage],
  ] as const)(
    "loads %s in bounded batches and keeps the list after a failed load-more",
    async (path, label, moreLabel, Page) => {
      let requests = 0;
      let failNext = true;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = urlOf(input);
        if (url.pathname === "/api/v1/bootstrap") return response(bootstrap);
        if (url.pathname !== `/api/v1/${path}`) throw new Error(`Unexpected path: ${url.pathname}`);
        requests += 1;
        if (url.searchParams.has("cursor") && failNext) {
          failNext = false;
          return response({ message: "잠시 후 다시 시도" }, 503);
        }
        return response({
          items: url.searchParams.has("cursor") ? items.slice(20) : items.slice(0, 20),
          next_cursor: url.searchParams.has("cursor") ? null : "remaining",
          selected_audience_enabled: false,
          server_today: "2026-09-22",
        });
      });
      render(
        <MemoryRouter initialEntries={[`/${path}`]}>
          <Page />
        </MemoryRouter>,
      );
      await screen.findByRole("link", { name: /합성 과제 01/u });
      const rows = () => screen.getAllByRole("link", { name: /합성 과제 \d+/u });
      const more = () => screen.getByRole("button", { name: moreLabel });
      expect(rows()).toHaveLength(20);
      expect(requests).toBe(1);
      fireEvent.click(more());
      await screen.findByText(`${label} 더 보기를 완료하지 못했어요.`);
      expect(rows()).toHaveLength(20);
      fireEvent.click(more());
      await screen.findByRole("link", { name: /합성 과제 23/u });
      expect(rows()).toHaveLength(23);
      expect(screen.getByRole("link", { name: /합성 과제 01/u })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: moreLabel })).not.toBeInTheDocument();
      expect(requests).toBe(3);
    },
  );

  it("invalidates both supply periods when searching and keeps the visible search text", async () => {
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/v1/bootstrap") return response(bootstrap);
      requests.push(url);
      return response({
        items: [
          {
            ...items[0],
            title: `${url.searchParams.get("scope")} ${url.searchParams.get("q") ?? "전체"}`,
          },
        ],
        next_cursor: null,
        server_today: "2026-09-22",
      });
    });
    render(
      <MemoryRouter initialEntries={["/supplies"]}>
        <SuppliesPage />
      </MemoryRouter>,
    );
    await screen.findByText("upcoming 전체");
    fireEvent.click(screen.getByRole("tab", { name: /지난/u }));
    await screen.findByText("past 전체");
    fireEvent.click(screen.getByRole("tab", { name: /다가오는/u }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "수학" } });
    // 검색어는 제목 안에서 강조 표시로 따로 감싸이므로 카드 링크의 글자 전체로 찾는다.
    await waitFor(() => expect(supplyCard("upcoming 수학")).toBeDefined());
    fireEvent.click(screen.getByRole("tab", { name: /지난/u }));
    await waitFor(() => expect(supplyCard("past 수학")).toBeDefined());
    expect(screen.getByRole("searchbox")).toHaveValue("수학");
    expect(screen.queryByText("past 전체")).not.toBeInTheDocument();
    expect(
      requests.some(
        (url) => url.searchParams.get("scope") === "past" && url.searchParams.get("q") === "수학",
      ),
    ).toBe(true);
  });

  it("restarts a homework search from the first batch and binds the next cursor to that search", async () => {
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/v1/bootstrap") return response(bootstrap);
      requests.push(url);
      return response({
        items: url.searchParams.has("cursor") ? items.slice(20) : items.slice(0, 20),
        next_cursor: url.searchParams.has("cursor") ? null : "remaining",
        server_today: "2026-09-22",
      });
    });
    render(
      <MemoryRouter initialEntries={["/updates?filter=homework"]}>
        <UpdatesPage />
      </MemoryRouter>,
    );
    // 검색어 강조로 제목 글자가 나뉘므로 링크 안 글자 전체로 센다.
    const rows = () =>
      screen.queryAllByRole("link").filter((link) => /합성 과제 \d+/u.test(link.textContent ?? ""));
    await screen.findByRole("link", { name: /합성 과제 01/u });
    fireEvent.click(screen.getByRole("button", { name: "지난 소식 더 보기" }));
    await waitFor(() => expect(rows()).toHaveLength(23));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "과제" } });
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("과제"));
    // 새 검색은 첫 묶음부터 다시 받는다(앞 검색의 커서를 쓰지 않음).
    expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
    await waitFor(() => expect(rows()).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "지난 소식 더 보기" }));
    await waitFor(() => expect(rows()).toHaveLength(23));
    expect(requests.at(-1)?.searchParams.get("cursor")).toBe("remaining");
    expect(document.querySelector('a[href="/supplies/23"]')).toHaveTextContent("합성 과제 23");
    expect(requests.at(-1)?.searchParams.get("q")).toBe("과제");
    expect(requests.at(-1)?.searchParams.get("filter")).toBe("homework");
    expect(screen.getByRole("searchbox")).toHaveValue("과제");
  });
});
