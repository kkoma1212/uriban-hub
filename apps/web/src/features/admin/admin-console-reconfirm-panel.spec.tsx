import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconfirmReportPanel } from "./admin-console-reconfirm-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const report = {
  classes: [
    {
      earlier_revisions_excluded: 1,
      eligible: 8,
      id: "41",
      name: "=3학년 2반",
      reconfirmed_total: 7,
      reconfirmed_within_window: 6,
      revisions: 3,
      school_name: "한빛중학교",
    },
  ],
  events: [
    {
      class_id: "41",
      eligible: 8,
      item_id: "17",
      kind: "notice",
      reconfirmed_total: 7,
      reconfirmed_within_window: 6,
      revised_at: "2026-10-20T03:00:00.000Z",
      revision: "3",
    },
  ],
  from: "2026-09-23",
  to: "2026-10-22",
  totals: {
    earlier_revisions_excluded: 1,
    eligible: 8,
    reconfirmed_total: 7,
    reconfirmed_within_window: 6,
    revisions: 3,
  },
  window_hours: 24,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReconfirmReportPanel", () => {
  it("shows the 24-hour reconfirm rate, counts and per-class rows only, and queries a period", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(report));
    const calls = () => fetchMock.mock.calls.map(([input]) => String(input));

    render(<ReconfirmReportPanel />);

    expect(await screen.findByText("한빛중학교")).toBeVisible();
    expect(calls()).toEqual(["/api/v1/admin/reconfirm-report"]);
    const totals = within(screen.getByLabelText("2026-09-23부터 2026-10-22까지 전체 합계"));
    // 6/8 = 75%
    expect(totals.getByText("75%")).toBeVisible();
    expect(totals.getByText("8")).toBeVisible();
    const row = within(screen.getByText("=3학년 2반").closest("tr")!);
    expect(row.getByText("75%")).toBeVisible();
    expect(screen.getByLabelText("시작일")).toHaveValue("2026-09-23");
    expect(screen.getByLabelText("종료일")).toHaveValue("2026-10-22");
    expect(document.body).not.toHaveTextContent(/학생가|student/u);

    fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "조회" }));
    await waitFor(() =>
      expect(calls()).toContain("/api/v1/admin/reconfirm-report?from=2026-10-01&to=2026-10-22"),
    );
  });

  it("shows a dash instead of a rate when nobody was eligible, and the server's period message", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () =>
        jsonResponse({
          ...report,
          classes: [],
          events: [],
          totals: { ...report.totals, eligible: 0, reconfirmed_within_window: 0 },
        }),
      )
      .mockImplementationOnce(async () =>
        jsonResponse(
          {
            error: {
              code: "ADMIN_REPORT_PERIOD_INVALID",
              message: "기간은 실제 날짜로, 시작일이 끝날보다 늦지 않게, 120일 이내로 골라 주세요.",
              request_id: "r",
            },
          },
          400,
        ),
      );
    render(<ReconfirmReportPanel />);
    expect(await screen.findByText("이 기간에 판이 바뀐 공지·준비물이 없습니다.")).toBeVisible();
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.getByRole("button", { name: /수정별 표\(CSV\) 받기/u })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "조회" }));
    expect(await screen.findByText(/120일 이내로 골라 주세요/u)).toBeVisible();
  });

  it("downloads per-revision rows with the class name kept out of spreadsheet formulas", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(report));
    let csv: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      csv = blob as Blob;
      return "blob:reconfirm";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(<ReconfirmReportPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /수정별 표\(CSV\) 받기/u }));

    expect(click).toHaveBeenCalledOnce();
    const text = await csv!.text();
    const lines = text.replace(/^﻿/u, "").split("\r\n");
    expect(lines[0]).toBe(
      "학교,반,종류,글 번호,판,고친 시각(한국),대상 학생,24시간 안 재확인,지금까지 재확인",
    );
    // '='로 시작하는 반 이름은 수식으로 실행되지 않게 앞에 '를 붙인다. 시각은 한국 시간(UTC+9).
    expect(lines[1]).toBe("한빛중학교,'=3학년 2반,공지,17,3,2026-10-20 12:00,8,6,7");
  });
});
