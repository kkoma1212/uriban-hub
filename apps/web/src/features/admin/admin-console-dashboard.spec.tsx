import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminOverview } from "../../api/admin-overview";
import { OverviewPanel } from "./admin-console-overview-panel";
import { AttentionStrip, RecentSignups, TrendSection } from "./admin-console-dashboard";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

const calm: AdminOverview = {
  generated_at: "2026-09-30T03:00:00.000Z",
  scale: { active_classes: 3, active_users: 40, schools: 2, students: 30, teachers: 4 },
  server: {
    database_ms: 3,
    errors_last_hour: 0,
    maintenance_mode: false,
    memory_mb: 180,
    redis_ok: true,
    started_at: "2026-09-30T00:00:00.000Z",
  },
  signups: { new_last_7_days: 5, pending_students: 1, pending_teachers: 0 },
  support: { class_chat_reports_open: 0, inquiries_in_progress: 1, inquiries_open: 0 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AttentionStrip", () => {
  it.each([
    ["admin", "관리자 서비스"],
    ["user", "학생·교사 서비스"],
    ["all", "통합 서비스"],
    [undefined, "현재 서비스"],
  ] as const)("labels only the responding service for %s", (surface, label) => {
    render(
      <AttentionStrip
        canOpen={() => true}
        onOpen={vi.fn()}
        overview={{
          ...calm,
          server: {
            ...calm.server,
            ...(surface === undefined ? {} : { api_surface: surface }),
            errors_last_hour: 2,
          },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: `${label} 최근 1시간 오류 2건 →` })).toBeVisible();
  });
  it("says there is nothing to check when every count is calm", () => {
    render(<AttentionStrip canOpen={() => true} onOpen={vi.fn()} overview={calm} />);
    expect(screen.getByRole("status")).toHaveTextContent("지금 확인할 것이 없습니다.");
  });

  it("lists only non-zero items and links just the menus the role can open", () => {
    const onOpen = vi.fn();
    render(
      <AttentionStrip
        canOpen={(target) => target === "inquiries"}
        onOpen={onOpen}
        overview={{
          ...calm,
          server: { ...calm.server, errors_last_hour: 2 },
          signups: { ...calm.signups, pending_teachers: 3 },
          support: { ...calm.support, class_chat_reports_open: 1, inquiries_open: 4 },
        }}
      />,
    );
    const strip = within(screen.getByRole("region", { name: "확인할 것" }));
    expect(strip.getByText("확인할 것 4가지")).toBeVisible();
    fireEvent.click(strip.getByRole("button", { name: "새 문의 4건 →" }));
    expect(onOpen).toHaveBeenCalledWith("inquiries");
    // 권한 밖 메뉴와 바로가기 없는 신고는 글자로만 보인다.
    expect(strip.getByText("승인 기다리는 선생님 3명")).toBeVisible();
    expect(strip.queryByRole("button", { name: /승인 기다리는/u })).not.toBeInTheDocument();
    expect(strip.getByText("반 대화 열린 신고 1건")).toBeVisible();
    expect(strip.getByText("현재 서비스 최근 1시간 오류 2건")).toBeVisible();
  });
});

describe("TrendSection", () => {
  it("draws daily totals, switches to 30 days and downloads numbers-only CSV", async () => {
    const series = (days: number) =>
      Array.from({ length: days }, (_, index) => ({
        activity: index,
        date: `2026-09-${String(index + 1).padStart(2, "0")}`,
        signups: index === 0 ? 2 : 0,
      }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const days = Number(new URL(String(input), "http://x").searchParams.get("days"));
      const points = series(days);
      return jsonResponse({ days, from: points[0]!.date, series: points, to: points.at(-1)!.date });
    });
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:trend";
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<TrendSection />);

    const [signupChart, activityChart] = await screen.findAllByRole("figure");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/admin/activity-trend?days=7",
    ]);
    // 7일 합계: 가입 2명, 활동 0+1+…+6 = 21건
    expect(signupChart).toHaveTextContent("새 가입합계 2명");
    expect(activityChart).toHaveTextContent("합계 21건");
    expect(screen.getByRole("table", { hidden: true })).toHaveTextContent("2026-09-07");

    fireEvent.click(screen.getByRole("button", { name: "CSV 받기" }));
    expect(click).toHaveBeenCalledTimes(1);
    // 엑셀이 한글을 UTF-8로 읽도록 맨 앞에 BOM(EF BB BF)이 있다.
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv.split("\r\n")).toEqual([
      "날짜,새 가입,새 활동",
      ...series(7).map((point) => `${point.date},${point.signups},${point.activity}`),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "최근 30일" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
        "/api/v1/admin/activity-trend?days=30",
      ),
    );
    await waitFor(() => expect(screen.getAllByRole("figure")[1]).toHaveTextContent("합계 435건"));
  });
});

describe("RecentSignups", () => {
  it("is hidden without the people menu and shows the newest ten with masked email otherwise", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        page: 1,
        page_size: 30,
        people: Array.from({ length: 12 }, (_, index) => ({
          class_name: null,
          created_at: "2026-09-29T03:00:00.000Z",
          display_name: `가입자${index + 1}`,
          email_masked: `u${index}***@example.com`,
          id: String(index + 1),
          last_login_at: null,
          role: index === 0 ? "teacher" : "student",
          school_name: null,
          status: index === 0 ? "pending" : "active",
        })),
        total: 12,
      }),
    );
    const { unmount } = render(<RecentSignups canOpen={() => false} onOpen={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "최근 가입" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    const onOpen = vi.fn();
    render(<RecentSignups canOpen={() => true} onOpen={onOpen} />);
    expect(await screen.findByText("가입자1")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/admin/people?page=1",
    ]);
    const rows = within(screen.getByRole("region", { name: "최근 가입" })).getAllByRole("row");
    expect(rows).toHaveLength(11);
    expect(screen.getByText("u0***@example.com")).toBeVisible();
    expect(screen.getByText("승인 대기")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "전체 보기" }));
    expect(onOpen).toHaveBeenCalledWith("people");
  });
});

describe("maintenance state", () => {
  it.each([
    [true, "켜짐"],
    [false, "꺼짐"],
    [null, "확인 불가"],
  ] as const)("shows %s in the overview card", async (maintenance, label) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/admin/overview"))
        return jsonResponse({ ...calm, server: { ...calm.server, maintenance_mode: maintenance } });
      return jsonResponse({
        days: 7,
        from: "2026-09-30",
        to: "2026-09-30",
        series: [{ date: "2026-09-30", signups: 0, activity: 0 }],
      });
    });
    render(<OverviewPanel canOpen={() => false} onOpen={vi.fn()} />);
    const stat = (await screen.findByText("점검 모드")).closest("[data-admin-stat]")!;
    expect(within(stat as HTMLElement).getByText(label)).toBeVisible();
    expect(stat.querySelector("dd")).toHaveClass(
      maintenance === false ? "text-app-text" : "text-danger-text",
    );
  });
  it.each([
    [true, "점검 모드 켜짐"],
    [null, "점검 모드 확인 불가"],
  ] as const)("links %s maintenance attention to the system menu", (maintenance, label) => {
    const onOpen = vi.fn();
    const overview = { ...calm, server: { ...calm.server, maintenance_mode: maintenance } };
    const { rerender } = render(
      <AttentionStrip canOpen={() => true} onOpen={onOpen} overview={overview} />,
    );
    fireEvent.click(screen.getByRole("button", { name: label + " →" }));
    expect(onOpen).toHaveBeenCalledWith("system");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<AttentionStrip canOpen={() => false} onOpen={onOpen} overview={overview} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("빈 기간 추이의 요약과 상세 접근", () => {
  const zeroTrend = {
    days: 7,
    from: "2026-09-01",
    to: "2026-09-07",
    series: Array.from({ length: 7 }, (_, i) => ({
      date: "2026-09-" + String(i + 1).padStart(2, "0"),
      signups: 0,
      activity: 0,
    })),
  };
  it("성공한 전체 0값만 요약하고 날짜별 차트와 원본 CSV를 계속 제공한다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(zeroTrend));
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:zero";
      }),
      revokeObjectURL: vi.fn(),
    });
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<TrendSection />);
    expect(
      await screen.findByText("9/1부터 9/7까지 새 가입 합계 0명 · 새 활동 합계 0건"),
    ).toBeVisible();
    for (const figure of screen.getAllByRole("figure")) expect(figure).not.toBeVisible();
    expect(screen.getByRole("button", { name: "최근 7일" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "최근 30일" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "CSV 받기" }));
    expect(download).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(await blobs[0]!.arrayBuffer())).toContain("2026-09-07,0,0");
    const summary = screen.getByText("날짜별 차트 펼치기");
    fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(screen.getByRole("table", { hidden: true })).toHaveTextContent("2026-09-07");
  });
  it("기간 전환 중과 오류에는 이전 차트를 보존하고 0값 성공 요약으로 오인시키지 않는다", async () => {
    let fail!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      fail = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(zeroTrend))
      .mockReturnValueOnce(pending);
    render(<TrendSection />);
    await screen.findByText("9/1부터 9/7까지 새 가입 합계 0명 · 새 활동 합계 0건");
    fireEvent.click(screen.getByRole("button", { name: "최근 30일" }));
    expect(screen.queryByText("날짜별 차트 펼치기")).toBeNull();
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "최근 30일" })).toBeDisabled();
    fail(
      new Response(
        JSON.stringify({ error: { code: "QA_FORCED_503", message: "합성 추이 실패" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    await screen.findByText("합성 추이 실패");
    expect(screen.queryByText("날짜별 차트 펼치기")).toBeNull();
    expect(screen.getAllByRole("figure")).toHaveLength(2);
  });
  it("일부 값이 0이어도 비0 활동이 있으면 기존 그래프를 항상 보여 준다", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...zeroTrend,
        series: zeroTrend.series.map((point, i) => ({ ...point, activity: i === 0 ? 1 : 0 })),
      }),
    );
    render(<TrendSection />);
    const figures = await screen.findAllByRole("figure");
    expect(figures[0]).toHaveTextContent("합계 0명");
    expect(figures[1]).toHaveTextContent("합계 1건");
    expect(screen.queryByText("날짜별 차트 펼치기")).toBeNull();
  });
});

it("첫 조회 대기와 실패를 0값 성공 요약으로 표시하지 않는다", async () => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  render(<TrendSection />);
  expect(screen.getByRole("status")).toBeVisible();
  expect(screen.queryByText("날짜별 차트 펼치기")).toBeNull();
  expect(screen.queryAllByRole("figure")).toHaveLength(0);
  finish(
    new Response(
      JSON.stringify({ error: { code: "QA_FORCED_503", message: "합성 첫 조회 실패" } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ),
  );
  expect(await screen.findByText("합성 첫 조회 실패")).toBeVisible();
  expect(screen.queryByText("날짜별 차트 펼치기")).toBeNull();
  expect(screen.queryAllByRole("figure")).toHaveLength(0);
});
