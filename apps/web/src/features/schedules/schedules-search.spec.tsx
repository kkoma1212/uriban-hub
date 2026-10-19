import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { SchedulesPage } from "./schedules-page";

vi.mock("./schedule-calendar", () => ({
  ScheduleCalendar: () => <section aria-label="월간 일정 달력" />,
}));

const items = Array.from({ length: 47 }, (_, index) => ({
  id: String(index + 1),
  row_version: "1",
  due_date: "2026-09-23",
  days_until: 1,
  d_day_label: "D-1",
  schedule_type: index < 24 ? "exam" : "assignment",
  subject: index < 24 ? "영어" : "수학",
  title: `연습 ${String(index + 1).padStart(2, "0")}`,
  description: "풀이를 준비해요.",
}));
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function fixture({
  role = "student",
  path = "/schedules",
  deferEnglish = false,
  failNext = false,
}: {
  role?: "student" | "teacher";
  path?: string;
  deferEnglish?: boolean;
  failNext?: boolean;
} = {}) {
  const requests: URL[] = [];
  const pending: Array<() => void> = [];
  let failed = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://classhub.test",
    );
    if (url.pathname === "/api/v1/bootstrap")
      return json({
        account: { display_name: "합성 사용자", email_verified: true, is_active: true },
        allowed_actions: ["VIEW_CLASS", "LOGOUT"],
        current_class: { id: "1", name: "합성 반", status: "active" },
        current_membership: { id: "1", class_id: "1", role, status: "approved" },
        teacher_profile:
          role === "teacher" ? { status: "active", temporary_password_must_change: false } : null,
        destination: "HOME",
        server_today: "2026-09-22",
      });
    if (url.pathname !== "/api/v1/schedules") throw new Error(`Unexpected API ${url.pathname}`);
    requests.push(url);
    const type = url.searchParams.get("schedule_type");
    const term = url.searchParams.get("q");
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const selected = items.filter(
      (item) =>
        (type === null || item.schedule_type === type) &&
        (term === null || `${item.subject} ${item.title} ${item.description}`.includes(term)),
    );
    if (failNext && offset === 20 && !failed) {
      failed = true;
      return json({ error: { code: "UNAVAILABLE", message: "retry" } }, 503);
    }
    const response = json({
      items: selected.slice(offset, offset + 20),
      next_cursor: offset + 20 < selected.length ? String(offset + 20) : null,
      server_today: "2026-09-22",
    });
    if (deferEnglish && term === "영어")
      return new Promise<Response>((resolve) => pending.push(() => resolve(response)));
    return response;
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <SchedulesPage />
    </MemoryRouter>,
  );
  return { requests, pending };
}
async function search(value: string, requests: URL[]) {
  fireEvent.change(screen.getByRole("searchbox", { name: "과목·일정 검색" }), {
    target: { value },
  });
  await waitFor(() => expect(requests.at(-1)?.searchParams.get("q")).toBe(value));
}

describe("schedule lookup", () => {
  afterEach(() => {
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it.each(["student", "teacher"] as const)(
    "finds subject matches beyond the first server batch and pages them for %s",
    async (role) => {
      const { requests } = fixture({ role });
      await screen.findByRole("link", { name: /연습 01/u });
      expect(screen.getByRole("tablist", { name: "일정 기간" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "과제" }));
      await screen.findByRole("link", { name: /연습 25/u });
      await search("수학", requests);
      await waitFor(() =>
        expect(document.querySelector('a[href="/schedules/25"] mark')).toHaveTextContent("수학"),
      );
      const beforeJump = requests.length;
      fireEvent.click(screen.getByRole("button", { name: "조회 결과 보기" }));
      expect(screen.getByRole("region", { name: "일정 조회 결과" })).toHaveFocus();
      expect(screen.getByRole("searchbox")).toHaveValue("수학");
      expect(screen.getByRole("button", { name: "과제" })).toHaveAttribute("aria-pressed", "true");
      expect(requests).toHaveLength(beforeJump);
      fireEvent.click(screen.getByRole("button", { name: "일정 더 보기" }));
      await waitFor(() =>
        expect(screen.getByRole("list", { name: "일정 목록" }).querySelectorAll("a")).toHaveLength(
          23,
        ),
      );
      expect(
        within(screen.getByRole("tabpanel", { name: "다가오는 일정" })).getAllByRole("listitem"),
      ).toHaveLength(23);
      expect(requests.at(-1)?.searchParams.get("cursor")).toBe("20");
      expect(requests.at(-1)?.searchParams.get("schedule_type")).toBe("assignment");
      expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
      expect(screen.queryByRole("button", { name: "일정 더 보기" })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "일정 조회 결과" })).toHaveFocus();
    },
  );

  it("clears an empty result's search and type while keeping the past period", async () => {
    const { requests } = fixture({ path: "/schedules?scope=past&schedule_type=assignment" });
    await screen.findByRole("link", { name: /연습 25/u });
    await search("없는과목", requests);
    await screen.findByText("조건에 맞는 일정이 없어요.");
    fireEvent.click(screen.getByRole("button", { name: "조회 결과 보기" }));
    expect(screen.getByRole("region", { name: "일정 조회 결과" })).toHaveFocus();
    expect(screen.queryByText("최근 90일 동안 지난 일정이 없어요.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "검색·종류 초기화" }));
    await screen.findByRole("link", { name: /연습 01/u });
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(requests.at(-1)?.searchParams.get("scope")).toBe("past");
    expect(requests.at(-1)?.searchParams.get("q")).toBeNull();
    expect(requests.at(-1)?.searchParams.get("schedule_type")).toBeNull();
  });

  it.each(["지난 일정", "오늘", "이번 주"])(
    "invalidates %s and ignores late responses from old search conditions",
    async (label) => {
      const scope = label === "지난 일정" ? "past" : label === "오늘" ? "today" : "this_week";
      const { requests, pending } = fixture({ deferEnglish: true });
      await screen.findByRole("link", { name: /연습 01/u });
      fireEvent.click(screen.getByRole("tab", { name: label }));
      await waitFor(() => expect(requests.at(-1)?.searchParams.get("scope")).toBe(scope));
      await screen.findByRole("link", { name: /연습 01/u });
      await search("영어", requests);
      fireEvent.click(screen.getByRole("tab", { name: "다가오는 일정" }));
      await search("수학", requests);
      await screen.findByRole("link", { name: /연습 25/u });
      for (const resolve of pending) resolve();
      await waitFor(() =>
        expect(screen.queryByRole("link", { name: /연습 01/u })).not.toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("tab", { name: label }));
      await screen.findByRole("link", { name: /연습 25/u });
      expect(requests.at(-1)?.searchParams.get("scope")).toBe(scope);
      expect(requests.at(-1)?.searchParams.get("q")).toBe("수학");
      expect(requests.at(-1)?.searchParams.get("cursor")).toBeNull();
    },
  );

  it("retries a failed filtered page with the same cursor, type, and search", async () => {
    const { requests } = fixture({ path: "/schedules?schedule_type=assignment", failNext: true });
    await screen.findByRole("link", { name: /연습 25/u });
    await search("수학", requests);
    await waitFor(() => expect(screen.getByRole("button", { name: "일정 더 보기" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "일정 더 보기" }));
    await screen.findByText("일정 더 보기를 완료하지 못했어요.");
    expect(screen.getByRole("list", { name: "일정 목록" }).querySelectorAll("a")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "일정 목록" }).querySelectorAll("a")).toHaveLength(
        23,
      ),
    );
    expect(requests.slice(-2).map((url) => [...url.searchParams])).toEqual([
      [
        ["scope", "upcoming"],
        ["cursor", "20"],
        ["schedule_type", "assignment"],
        ["q", "수학"],
      ],
      [
        ["scope", "upcoming"],
        ["cursor", "20"],
        ["schedule_type", "assignment"],
        ["q", "수학"],
      ],
    ]);
  });
});
