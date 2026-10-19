import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulesPage } from "./schedules-page";

vi.mock("./schedule-calendar", () => ({
  ScheduleCalendar: ({ attendanceEnabled }: { attendanceEnabled?: boolean }) => (
    <section aria-label="월간 일정 달력" data-attendance-enabled={attendanceEnabled} />
  ),
}));

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const upcomingSchedule = {
  d_day_label: "D-1",
  days_until: 1,
  description: "2단원까지 복습해 오세요.",
  due_date: "2026-07-15",
  id: "17",
  row_version: "1",
  schedule_type: "exam",
  subject: "수학",
  title: "수학 단원평가",
};

const pastSchedule = {
  ...upcomingSchedule,
  d_day_label: null,
  days_until: -2,
  due_date: "2026-07-12",
  id: "18",
  title: "국어 수행평가",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderList(role: "student" | "teacher" = "teacher", initialEntry = "/schedules") {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: [
                  "CHANGE_PASSWORD",
                  "LOGOUT",
                  "LEAVE_CLASS",
                  "VIEW_CLASS",
                  "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
                ],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url === "/api/v1/schedules?scope=upcoming") {
      return Promise.resolve(
        jsonResponse({
          items: [upcomingSchedule],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    if (url === "/api/v1/schedules?scope=past") {
      return Promise.resolve(
        jsonResponse({
          items: [pastSchedule],
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SchedulesPage />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("SchedulesPage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("retries only bootstrap in place and keeps the active schedule scope", async () => {
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
      if (url === "/api/v1/schedules?scope=past") {
        return Promise.resolve(
          jsonResponse({ items: [pastSchedule], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules?scope=past&wave=bootstrap-retry"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );

    const retryButton = await screen.findByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();

    expect(await screen.findByRole("link", { name: /국어 수행평가/u })).toBeVisible();
    expect(bootstrapRequestCount).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/schedules?scope=past",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET"),
    ).toBe(true);
  });

  it("renders teacher controls and four accessible URL-backed period tabs", async () => {
    const fetchMock = renderList();

    await screen.findByRole("button", { name: "쓰기 (일정 추가)" });
    const pageHeading = screen.getByRole("heading", { level: 1, name: "일정" });
    expect(pageHeading).toBeVisible();
    expect(pageHeading.closest("header")).toHaveClass("content-frame-header");
    expect(pageHeading.closest("header")).toHaveAttribute("data-schedule-page-intro", "true");
    const scheduleLink = await screen.findByRole("link", { name: /수학 단원평가/u });
    expect(scheduleLink).toHaveAttribute("href", "/schedules/17");
    expect(scheduleLink).toHaveClass("content-card");
    expect(within(scheduleLink).getByText("시험")).toHaveClass("schedule-kind-chip");
    expect(scheduleLink.querySelector("time")).toHaveAttribute("datetime", "2026-07-15");
    expect(scheduleLink).toHaveAttribute("data-schedule-kind", "exam");
    expect(scheduleLink.querySelector(".schedule-agenda-countdown")).toHaveClass("is-near");
    expect(screen.getByRole("button", { name: "쓰기 (일정 추가)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "월간 일정 달력" })).toBeVisible();

    const tablist = screen.getByRole("tablist", { name: "일정 기간" });
    expect(tablist).toHaveClass("content-filters");
    expect(document.querySelector('[data-feature-surface="schedules-list"]')).toHaveClass(
      "min-w-0",
    );
    const upcomingTab = within(tablist).getByRole("tab", { name: "다가오는 일정" });
    const todayTab = within(tablist).getByRole("tab", { name: "오늘" });
    const weekTab = within(tablist).getByRole("tab", { name: "이번 주" });
    const pastTab = within(tablist).getByRole("tab", { name: "지난 일정" });
    expect(upcomingTab).toHaveAttribute("aria-selected", "true");
    expect(upcomingTab).toHaveAttribute("tabindex", "0");
    expect(pastTab).toHaveAttribute("tabindex", "-1");

    fireEvent.focus(upcomingTab);
    fireEvent.keyDown(upcomingTab, { key: "ArrowRight" });
    expect(todayTab).toHaveFocus();
    fireEvent.keyDown(todayTab, { key: "ArrowRight" });
    expect(weekTab).toHaveFocus();
    fireEvent.keyDown(weekTab, { key: "End" });
    expect(pastTab).toHaveFocus();
    expect(upcomingTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(pastTab);
    expect(await screen.findByRole("tabpanel", { name: "지난 일정" })).toBeVisible();
    expect(await screen.findByRole("link", { name: /국어 수행평가/u })).toHaveAttribute(
      "href",
      "/schedules/18",
    );
    expect(screen.getByText("7월 12일 일요일")).toHaveAttribute("datetime", "2026-07-12");
    expect(screen.queryByText(/D\+/u)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/v1/schedules?scope=past"),
    ).toBe(true);
  });

  it("opens a teacher form with a stable default type and returns focus on cancel", async () => {
    renderList();
    const createButton = await screen.findByRole("button", { name: "쓰기 (일정 추가)" });

    createButton.focus();
    fireEvent.click(createButton);

    expect(document.querySelector("#schedule-create-panel")).toHaveClass("min-w-0");
    expect(
      document.querySelector("#schedule-create-panel .content-input-frame"),
    ).toBeInTheDocument();
    const title = screen.getByRole("textbox", { name: "일정 제목" });
    const dueDate = screen.getByLabelText(/일정 날짜/u);
    expect(title).toHaveFocus();
    expect(title).toBeRequired();
    expect(title).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("radio", { name: "기타" })).toBeChecked();
    expect(dueDate).toHaveAttribute("type", "date");
    expect(dueDate).toBeRequired();
    expect(dueDate).toHaveAttribute("aria-required", "true");
    expect(title).toHaveAccessibleDescription("필수 · 1~100자");
    expect(dueDate).toHaveAccessibleDescription(
      "지난 날짜도 기록할 수 있으며 최근 90일 일정까지 목록에서 보여요.",
    );
    expect(screen.getByRole("group", { name: "저장 및 취소" })).toHaveAttribute(
      "data-form-action-bar",
      "fixed",
    );

    expect(screen.getByRole("button", { name: "제목을 적어 주세요" })).toBeDisabled();
    // 비활성화된 버튼을 우회한 submit에도 기존 검증과 오류 포커스를 유지한다.
    fireEvent.submit(title.closest("form")!);
    const titleError = await screen.findByText("일정 제목은 1자 이상 100자 이하로 입력해 주세요.");
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title.getAttribute("aria-describedby")).toContain(titleError.id);
    await waitFor(() => expect(title).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(createButton).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "일정 제목" })).not.toBeInTheDocument();
  });

  it("replays an ambiguous schedule create with its original idempotency key", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(idempotencyKey);
    const submittedKeys: string[] = [];
    let createCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/schedules?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({
            items: [upcomingSchedule],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/schedules" && init?.method === "POST") {
        createCalls += 1;
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        return Promise.resolve(
          createCalls === 1
            ? jsonResponse({ error: { code: "UPSTREAM_TIMEOUT", message: "시간 초과" } }, 504)
            : jsonResponse(upcomingSchedule, 201),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );
    await screen.findByText(/기준일/u);
    fireEvent.click(screen.getByRole("button", { name: "쓰기 (일정 추가)" }));
    fireEvent.change(screen.getByRole("textbox", { name: "일정 제목" }), {
      target: { value: "과학 발표" },
    });
    fireEvent.change(screen.getByLabelText(/일정 날짜/u), {
      target: { value: "2026-07-21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "등록하기" }));

    expect(await screen.findByText(/일정 추가 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    expect(screen.getByLabelText(/일정 날짜/u)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));
    await waitFor(() => expect(submittedKeys).toHaveLength(2));
    expect(submittedKeys).toEqual([idempotencyKey, idempotencyKey]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("blocks an old retry when the fresh server date advances despite a rolled-back client clock", async () => {
    const request = {
      description: null,
      due_date: "2026-07-20",
      schedule_type: "other",
      subject: null,
      title: "날짜 전환 일정",
    };
    window.sessionStorage.setItem(
      "classhub:idempotent-create:schedules:1",
      JSON.stringify({
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        request,
        serverDate: "2026-07-14",
        startedAt: 1_000,
        version: 2,
      }),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 22 * 60 * 60 * 1_000);
    let authoritativeServerToday = "2026-07-14";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/schedules?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({
            items: [upcomingSchedule],
            next_cursor: null,
            server_today: authoritativeServerToday,
          }),
        );
      }
      if (url === "/api/v1/schedules" && init?.method === "POST") {
        throw new Error("만료된 키로 POST를 보내면 안 됩니다.");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/일정 추가 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/schedules?scope=upcoming",
        ),
      ).toHaveLength(1),
    );
    authoritativeServerToday = "2026-07-15";
    fireEvent.click(screen.getByRole("button", { name: "쓰기 (일정 추가)" }));
    expect(screen.getByRole("textbox", { name: "일정 제목" })).toHaveValue(request.title);
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

    expect(await screen.findByText(/다시 확인할 수 있는 시간이 지났어요/u)).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => requestUrl(input) === "/api/v1/schedules" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/schedules?scope=upcoming",
      ),
    ).toHaveLength(2);
  });

  it("shows a student the same schedules without teacher mutation controls", async () => {
    renderList("student");

    expect(await screen.findByRole("link", { name: /수학 단원평가/u })).toBeVisible();
    expect(screen.getByText("D-1")).toBeVisible();
    expect(screen.queryByRole("button", { name: "쓰기 (일정 추가)" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "월간 일정 달력" })).toHaveAttribute(
      "data-attendance-enabled",
      "true",
    );
    expect(screen.getByRole("region", { name: "월간 일정 달력" })).toBeVisible();
  });

  it("honours a direct past-scope URL before making the first list request", async () => {
    const fetchMock = renderList("student", "/schedules?scope=past");

    expect(await screen.findByRole("link", { name: /국어 수행평가/u })).toBeVisible();
    expect(screen.getByRole("tab", { name: "지난 일정" })).toHaveAttribute("aria-selected", "true");
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/schedules?scope=upcoming",
      ),
    ).toHaveLength(0);
  });

  it("ignores a late cursor response after the user changes to a cached scope", async () => {
    let resolveLatePage: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/schedules?scope=upcoming") {
        return Promise.resolve(
          jsonResponse({
            items: [upcomingSchedule],
            next_cursor: "next-cursor",
            server_today: "2026-07-14",
          }),
        );
      }
      if (url === "/api/v1/schedules?scope=past") {
        return Promise.resolve(
          jsonResponse({ items: [pastSchedule], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      if (url === "/api/v1/schedules?scope=upcoming&cursor=next-cursor") {
        return new Promise<Response>((resolve) => {
          resolveLatePage = resolve;
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );

    const upcomingTab = await screen.findByRole("tab", { name: "다가오는 일정" });
    const pastTab = screen.getByRole("tab", { name: "지난 일정" });
    fireEvent.click(pastTab);
    expect(await screen.findByText("국어 수행평가")).toBeVisible();
    fireEvent.click(upcomingTab);
    fireEvent.click(screen.getByRole("button", { name: "일정 더 보기" }));
    fireEvent.click(pastTab);

    resolveLatePage?.(
      jsonResponse({
        items: [{ ...upcomingSchedule, id: "99", title: "늦게 도착한 일정" }],
        next_cursor: null,
        server_today: "2026-07-14",
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("국어 수행평가")).toBeVisible();
      expect(screen.queryByText("늦게 도착한 일정")).not.toBeInTheDocument();
    });
    fireEvent.click(upcomingTab);
    expect(screen.queryByText("늦게 도착한 일정")).not.toBeInTheDocument();
  });

  it("keeps cached schedules visible through a failed refresh and successful retry", async () => {
    let listRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/schedules?scope=upcoming") {
        listRequestCount += 1;
        if (listRequestCount === 1) {
          return Promise.resolve(
            jsonResponse({
              items: [upcomingSchedule],
              next_cursor: null,
              server_today: "2026-07-14",
            }),
          );
        }
        if (listRequestCount === 2) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: "SCHEDULE_LOOKUP_FAILED", message: "일정 조회 실패" } },
              503,
            ),
          );
        }
        return Promise.resolve(
          jsonResponse({
            items: [{ ...upcomingSchedule, id: "19", title: "갱신된 과학 실험 일정" }],
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: /수학 단원평가/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "다가오는 일정 새로고침" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("최신 일정을 확인하지 못했어요.");
    expect(alert).toHaveTextContent("이전에 불러온 일정을 계속 표시하고 있어");
    expect(screen.getByRole("link", { name: /수학 단원평가/u })).toBeVisible();

    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");
    fireEvent.click(retryButton);
    expect(await screen.findByRole("link", { name: /갱신된 과학 실험 일정/u })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /수학 단원평가/u })).not.toBeInTheDocument();
    expect(listRequestCount).toBe(3);
  });

  it("requires VIEW_CLASS before making the first schedules request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({ ...teacherBootstrap, allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"] }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules"]}>
        <SchedulesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === "/api/v1/bootstrap"),
      ).toHaveLength(1);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).startsWith("/api/v1/schedules")),
      ).toHaveLength(0);
    });
  });
});
