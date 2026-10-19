import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { NoticeDetailPage } from "../notices/notice-detail-page";
import { ScheduleDetailPage } from "../schedules/schedule-detail-page";
import { SchedulesPage } from "../schedules/schedules-page";
import { SuppliesPage } from "../supplies/supplies-page";
import { SupplyDetailPage } from "../supplies/supply-detail-page";
import { UpdatesPage } from "../updates/updates-page";

const bootstrap = {
  session_context: "v1." + "a".repeat(43),
  account: { display_name: "합성 학생", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "합성 학급", status: "active" },
  current_membership: { id: "1", class_id: "1", role: "student", status: "approved" },
  destination: "HOME",
  server_today: "2026-09-22",
  teacher_profile: null,
};
const allItems = Array.from({ length: 57 }, (_, index) => ({
  audience_mode: "all_snapshot",
  category: "homework",
  kind: "supply",
  check_state: "unchecked",
  confirmation_state: "unread",
  content: "합성 내용",
  content_revision: "1",
  d_day_label: "D-1",
  days_until: 1,
  description: null,
  due_date: "2026-09-23",
  id: String(index + 1),
  is_important: false,
  needed_on: "2026-09-23",
  published_at: "2026-09-22T03:00:00Z",
  row_version: "1",
  schedule_type: "assignment",
  subject: "수학",
  title: `수학 과제 ${String(index + 1).padStart(2, "0")}`,
}));
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function HistoryBack(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button onClick={() => void navigate(-1)} type="button">
      브라우저 뒤로
    </button>
  );
}
const cases = [
  { path: "/updates?filter=homework", api: "updates", detail: "supplies", label: "소식" },
  { path: "/updates?filter=performance", api: "updates", detail: "notices", label: "소식" },
  {
    path: "/supplies?scope=past&category=homework&check_state=unchecked",
    api: "supplies",
    detail: "supplies",
    label: "준비물",
  },
  {
    path: "/schedules?scope=past&schedule_type=assignment",
    api: "schedules",
    detail: "schedules",
    label: "일정",
    tabLabel: "지난 일정",
  },
  {
    path: "/schedules?scope=today&schedule_type=assignment",
    api: "schedules",
    detail: "schedules",
    label: "일정",
    tabLabel: "오늘",
  },
  {
    path: "/schedules?scope=this_week&schedule_type=assignment",
    api: "schedules",
    detail: "schedules",
    label: "일정",
    tabLabel: "이번 주",
  },
  {
    path: "/supplies?scope=today&category=homework",
    api: "supplies",
    detail: "supplies",
    label: "준비물",
    tabLabel: "오늘 준비물·숙제",
  },
  {
    path: "/supplies?scope=this_week&category=homework&check_state=unchecked",
    api: "supplies",
    detail: "supplies",
    label: "준비물",
    tabLabel: "이번 주 준비물·숙제",
  },
] as const;

function listBackName(api: (typeof cases)[number]["api"]): string {
  return api === "schedules" ? "일정" : "소식";
}

function fixture(
  config: (typeof cases)[number],
  mode: "normal" | "invalid" | "empty" | "failure" | "session" = "normal",
  detailId = 56,
) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  let opened = false;
  let failed = false;
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(path, "https://classhub.test");
    if (url.pathname === "/api/v1/bootstrap")
      return json({
        ...bootstrap,
        session_context:
          opened && mode === "session" ? "v1." + "b".repeat(43) : bootstrap.session_context,
      });
    if (url.pathname === `/api/v1/${config.detail}/${detailId}`) {
      opened = true;
      return json({
        ...allItems[detailId - 1],
        ...(config.detail === "notices" ? { category: "performance", kind: "notice" } : {}),
      });
    }
    if (url.pathname === "/api/v1/schedules/calendar")
      return json({
        items: [],
        holidays: [],
        server_today: "2026-09-22",
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        oldest_visible_date: "2026-06-24",
      });
    if (url.pathname !== `/api/v1/${config.api}`)
      throw new Error(`Unexpected request: ${url.pathname}`);
    requests.push(url);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    if (opened && offset === 40) {
      if (mode === "invalid")
        return json({ error: { code: "INVALID_CURSOR", message: "invalid cursor" } }, 400);
      if (mode === "empty")
        return json({ items: [], next_cursor: null, server_today: "2026-09-22" });
      if (mode === "failure" && !failed) {
        failed = true;
        return json({ error: { code: "UNAVAILABLE", message: "retry" } }, 503);
      }
    }
    const items = allItems.slice(offset, offset + 20).map((item) => ({
      ...item,
      ...(config.detail === "notices" ? { kind: "notice", category: "performance" } : {}),
      ...(opened && item.id === "56"
        ? { title: "수학 과제 56 수정", check_state: "checked", confirmation_state: "confirmed" }
        : {}),
    }));
    return json({
      items,
      next_cursor: offset + 20 < allItems.length ? String(offset + 20) : null,
      server_today: "2026-09-22",
      selected_audience_enabled: false,
    });
  });
  render(
    <MemoryRouter initialEntries={[config.path]}>
      <HistoryBack />
      <Routes>
        <Route path="/updates" element={<UpdatesPage />} />
        <Route path="/supplies" element={<SuppliesPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/notices/:noticeId" element={<NoticeDetailPage />} />
        <Route path="/supplies/:supplyId" element={<SupplyDetailPage />} />
        <Route path="/schedules/:scheduleId" element={<ScheduleDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return requests;
}
// 인라인 검색 강조 조각의 접근성 공백은 CSS 적용 여부에 따라 달라진다.
function contentTitleName(title: string): (name: string) => boolean {
  const compactTitle = title.replace(/\s+/gu, "");
  return (name) => name.replace(/\s+/gu, "").includes(compactTitle);
}

async function openThirdBatch(config: (typeof cases)[number], requests: URL[], detailId = 56) {
  await screen.findByRole("link", { name: contentTitleName("수학 과제 01") });
  fireEvent.click(screen.getByRole("button", { name: /검색 열기/u }));
  {
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "수학" } });
    await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe("수학"));
    await waitFor(() => expect(screen.getByRole("button", { name: /더 보기$/u })).toBeEnabled());
  }
  for (const number of [21, 41]) {
    fireEvent.click(screen.getByRole("button", { name: /더 보기$/u }));
    await waitFor(() => {
      expect(document.querySelector(`a[href="/${config.detail}/${number}"]`)).toHaveTextContent(
        `수학 과제 ${number}`,
      );
    });
  }
  vi.spyOn(window, "scrollY", "get").mockReturnValue(480);
  const link = document.querySelector(`a[href="/${config.detail}/${detailId}"]`);
  expect(link).not.toBeNull();
  fireEvent.click(link!);
  await screen.findByRole("heading", {
    name: `수학 과제 ${String(detailId).padStart(2, "0")}`,
    level: 1,
  });
}

describe("returning from content details", () => {
  afterEach(() => {
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it.each(cases)(
    "restores every expanded batch of $path with fresh content and the original focus",
    async (config) => {
      const requests = fixture(config);
      await openThirdBatch(config, requests);
      const before = requests.length;
      const scroll = vi.spyOn(window, "scrollTo");
      fireEvent.click(screen.getByRole("button", { name: listBackName(config.api) }));
      await screen.findByRole("link", { name: contentTitleName("수학 과제 56 수정") });
      const link = document.querySelector(`a[href="/${config.detail}/56"]`);
      expect(link).toHaveTextContent("수학 과제 56 수정");
      await waitFor(() => expect(link).toHaveFocus());
      expect(scroll).toHaveBeenCalledWith({ top: 480, left: 0, behavior: "auto" });
      expect(requests.slice(before).map((url) => url.searchParams.get("cursor"))).toEqual([
        null,
        "20",
        "40",
      ]);
      expect(requests.at(-1)?.searchParams.get("cursor")).toBe("40");
      {
        fireEvent.click(screen.getByRole("button", { name: /검색 열기/u }));
        expect(screen.getByRole("searchbox")).toHaveValue("수학");
        expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
      }
      if (config.api === "schedules") {
        expect(screen.getByRole("button", { name: "과제" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(requests.at(-1)?.searchParams.get("schedule_type")).toBe("assignment");
        expect(requests.at(-1)?.searchParams.get("scope")).toBe(
          new URL(config.path, "https://classhub.test").searchParams.get("scope"),
        );
      }
      if (config.api === "supplies") {
        const expectedState = new URL(config.path, "https://classhub.test").searchParams.get(
          "check_state",
        );
        expect(requests.at(-1)?.searchParams.get("check_state")).toBe(expectedState);
        expect(screen.getByRole("combobox", { name: "내 확인 상태" })).toHaveValue(
          expectedState ?? "",
        );
        expect(screen.getByRole("button", { name: "숙제" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(requests.at(-1)?.searchParams.get("category")).toBe("homework");
        expect(requests.at(-1)?.searchParams.get("scope")).toBe(
          new URL(config.path, "https://classhub.test").searchParams.get("scope"),
        );
      }
      if (config.api !== "updates")
        expect(
          screen.getByRole("tab", { name: "tabLabel" in config ? config.tabLabel : /지난/u }),
        ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("link", { name: contentTitleName("수학 과제 01") })).toBeVisible();
      expect(screen.getByRole("link", { name: contentTitleName("수학 과제 21") })).toBeVisible();
      expect(screen.getByRole("link", { name: contentTitleName("수학 과제 57") })).toBeVisible();
      expect(screen.queryByRole("button", { name: /더 보기$/u })).not.toBeInTheDocument();
    },
  );

  it.each(["invalid", "empty"] as const)(
    "recovers a %s saved cursor to the first page of the same search",
    async (mode) => {
      const config = cases[0];
      const requests = fixture(config, mode);
      await openThirdBatch(config, requests);
      const before = requests.length;
      fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
      await screen.findByRole("link", { name: contentTitleName("수학 과제 01") });
      if (mode === "invalid") {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: /더 보기$/u })).toBeEnabled(),
        );
      } else {
        await waitFor(() => expect(requests.slice(before)).toHaveLength(3));
        expect(
          await screen.findByRole("link", { name: contentTitleName("수학 과제 21") }),
        ).toBeVisible();
        expect(screen.queryByRole("button", { name: /더 보기$/u })).not.toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole("button", { name: /검색 열기/u }));
      expect(screen.getByRole("searchbox")).toHaveValue("수학");
      expect(
        requests
          .slice(before)
          .map((url) => [url.searchParams.get("cursor"), url.searchParams.get("q")]),
      ).toEqual(
        mode === "invalid"
          ? [
              [null, "수학"],
              ["20", "수학"],
              ["40", "수학"],
              [null, "수학"],
            ]
          : [
              [null, "수학"],
              ["20", "수학"],
              ["40", "수학"],
            ],
      );
    },
  );

  it("keeps later batches when returning from an item in the first batch", async () => {
    const config = cases[0];
    const requests = fixture(config, "normal", 1);
    await openThirdBatch(config, requests, 1);
    fireEvent.click(screen.getByRole("button", { name: listBackName(config.api) }));
    await screen.findByRole("link", { name: contentTitleName("수학 과제 56 수정") });
    const first = document.querySelector(`a[href="/${config.detail}/1"]`);
    await waitFor(() => expect(first).toHaveFocus());
    expect(screen.getByRole("link", { name: contentTitleName("수학 과제 21") })).toBeVisible();
    expect(screen.getByRole("link", { name: contentTitleName("수학 과제 57") })).toBeVisible();
  });

  it("retries a failed return at the same page instead of silently resetting the search", async () => {
    const config = cases[2];
    const requests = fixture(config, "failure");
    await openThirdBatch(config, requests);
    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await screen.findByText("준비물 목록을 불러오지 못했어요.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("link", { name: contentTitleName("수학 과제 56 수정") });
    expect(requests.slice(-6).map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "20",
      "40",
      null,
      "20",
      "40",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /검색 열기/u }));
    expect(screen.getByRole("searchbox")).toHaveValue("수학");
  });

  it("does not restore a previous session's search or page", async () => {
    const config = cases[0];
    const requests = fixture(config, "session");
    await openThirdBatch(config, requests);
    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await screen.findByRole("link", { name: contentTitleName("수학 과제 01") });
    fireEvent.click(screen.getByRole("button", { name: /검색 열기/u }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(requests.at(-1)?.searchParams.get("q")).toBeNull();
    expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
  });
});
