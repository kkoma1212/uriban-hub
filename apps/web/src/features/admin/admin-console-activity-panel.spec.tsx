import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassActivityPanel } from "./admin-console-activity-panel";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

const counts = {
  active_students: 18,
  attendance: 2,
  class_chat_messages: null,
  help_requests: 3,
  notices: 5,
  polls: 0,
  schedules: 4,
  supplies: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClassActivityPanel", () => {
  it("shows period totals and per-class counts only, and switches period and page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        classes: [
          { ...counts, id: "41", name: "3학년 2반", school_name: "한빛중학교", students: 24 },
        ],
        days: 7,
        page: 1,
        page_size: 20,
        total: 21,
        totals: { ...counts, notices: 12 },
      }),
    );
    const calls = () => fetchMock.mock.calls.map(([input]) => String(input));

    render(<ClassActivityPanel />);

    expect(await screen.findByText("한빛중학교")).toBeVisible();
    expect(calls()).toEqual(["/api/v1/admin/class-activity?days=7&page=1"]);
    const totals = within(screen.getByLabelText("최근 7일 전체 합계"));
    expect(totals.getByText("12")).toBeVisible();
    const row = within(screen.getByText("3학년 2반").closest("tr")!);
    expect(row.getByText("24")).toBeVisible();
    expect(row.getByText("18")).toBeVisible();
    // 반 대화가 꺼져 있으면 0이 아니라 "꺼짐"으로 보인다.
    expect(row.getByText("꺼짐")).toBeVisible();
    expect(screen.getByText("운영 중 21개 반 · 1/2쪽")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(calls()).toContain("/api/v1/admin/class-activity?days=7&page=2"));
    fireEvent.click(await screen.findByRole("button", { name: "최근 30일" }));
    await waitFor(() => expect(calls()).toContain("/api/v1/admin/class-activity?days=30&page=1"));
  });
});
