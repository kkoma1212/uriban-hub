import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduleItem } from "../../api/schedules";
import { itemListOriginState, rememberItemListPosition } from "../layout/item-list-history";
import { ScheduleDetailPage } from "./schedule-detail-page";

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

const schedule: ScheduleItem = {
  d_day_label: "D-1",
  days_until: 1,
  description: "2단원까지 복습해 오세요.",
  due_date: "2026-07-15",
  id: "17",
  row_version: "4",
  schedule_type: "exam",
  subject: "수학",
  title: "수학 단원평가",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function ScheduleListProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="일정 목록 검색 조건">{location.search}</output>;
}

let detailLinks: unknown;

function renderDetail(
  role: "student" | "teacher" = "teacher",
  item = schedule,
  originEntryKey?: string,
) {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "LEAVE_CLASS", "VIEW_CLASS"],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url === "/api/v1/schedules/17" && (init?.method === undefined || init.method === "GET")) {
      return Promise.resolve(jsonResponse(item, 200, { ETag: '"4"' }));
    }
    if (url === "/api/v1/schedules/17" && init?.method === "PATCH") {
      return Promise.resolve(jsonResponse(item, 200, { ETag: '"4"' }));
    }
    if (url === "/api/v1/schedules/17/links" && detailLinks !== undefined) {
      return Promise.resolve(jsonResponse(detailLinks));
    }
    if (url === "/api/v1/schedules/17" && init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const initialEntries =
    originEntryKey === undefined
      ? ["/schedules/17"]
      : [
          { key: originEntryKey, pathname: "/schedules", search: "?scope=past&from=kept" },
          {
            pathname: "/schedules/17",
            state: itemListOriginState("schedules", originEntryKey),
          },
        ];
  if (originEntryKey !== undefined) {
    rememberItemListPosition("schedules", originEntryKey, "17", 280);
  }

  render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <Routes>
        <Route element={<ScheduleDetailPage />} path="/schedules/:scheduleId" />
        <Route element={<ScheduleListProbe />} path="/schedules" />
      </Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("ScheduleDetailPage", () => {
  afterEach(() => {
    detailLinks = undefined;
    vi.restoreAllMocks();
  });

  it("shows linked notices and supplies returned for a student", async () => {
    detailLinks = {
      notices: [{ id: "21", is_important: true, title: "체험학습 안내" }],
      supplies: [{ id: "32", category: "homework", needed_on: "2026-09-17", title: "동의서" }],
    };
    renderDetail("student");
    expect(await screen.findByRole("heading", { name: "관련 안내" })).toBeVisible();
    expect(screen.getByRole("link", { name: /중요 공지\s*체험학습 안내/u })).toHaveAttribute(
      "href",
      "/notices/21",
    );
    expect(screen.getByRole("link", { name: /숙제.*동의서/u })).toHaveAttribute(
      "href",
      "/supplies/32",
    );
  });

  it("shows a quiet note instead of breaking when links cannot load", async () => {
    renderDetail("student");
    expect(await screen.findByText(/관련 안내를 불러오지 못했어요/u)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "관련 안내" })).not.toBeInTheDocument();
  });

  it("keeps the teacher shell and page heading while the schedule load waits and fails", async () => {
    let resolveSchedule!: (response: Response) => void;
    const pendingSchedule = new Promise<Response>((resolve) => {
      resolveSchedule = resolve;
    });
    let scheduleRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/schedules/17") {
        scheduleRequestCount += 1;
        return scheduleRequestCount === 1
          ? pendingSchedule
          : Promise.resolve(jsonResponse(schedule, 200, { ETag: '"4"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/schedules/17"]}>
        <Routes>
          <Route element={<ScheduleDetailPage />} path="/schedules/:scheduleId" />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2),
    );
    expect(screen.getByRole("heading", { level: 1, name: "일정" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("일정을 불러오고 있어요.");

    await act(async () => {
      resolveSchedule(
        jsonResponse(
          {
            error: {
              code: "QA_FORCED_503",
              message: "INTERNAL_QA_DIAGNOSTIC private_schedule_table",
              request_id: "qa-schedule-load",
            },
          },
          503,
        ),
      );
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("일정을 불러오지 못했어요.");
    expect(screen.getByRole("heading", { level: 1, name: "일정" })).toBeVisible();
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.queryByText(/private_schedule_table/u)).not.toBeInTheDocument();

    const retry = within(alert).getByRole("button", { name: "다시 불러오기" });
    expect(retry).toHaveClass("ui-button-primary");
    expect(retry).not.toHaveClass("ui-button-danger");
    expect(within(alert).getByRole("button", { name: "일정 목록으로" })).toHaveClass(
      "ui-button-secondary",
    );

    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { level: 1, name: schedule.title })).toBeVisible();
    expect(scheduleRequestCount).toBe(2);
  });

  it("shows teacher controls, performs an explicit no-op update, and restores focus", async () => {
    const fetchMock = renderDetail();

    const pageHeading = await screen.findByRole("heading", { name: "수학 단원평가", level: 1 });
    expect(pageHeading).toBeVisible();
    expect(pageHeading.closest("header")).toHaveAttribute("data-detail-heading");
    expect(pageHeading.closest("article")).toHaveClass("border-app-border", "bg-app-surface");
    expect(screen.getByText("D-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "일정 삭제 옵션" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    const editButton = screen.getByRole("button", { name: "일정 수정" });
    editButton.focus();
    fireEvent.click(editButton);
    expect(screen.getByRole("textbox", { name: "일정 제목" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
    expect(
      await screen.findByText("변경된 내용이 없어 기존 일정을 그대로 유지했습니다."),
    ).toBeVisible();
    await waitFor(() => expect(editButton).toHaveFocus());

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => requestUrl(input) === "/api/v1/schedules/17" && init?.method === "PATCH",
    );
    expect(new Headers(patchCall?.[1]?.headers).get("If-Match")).toBe('"4"');
    expect(new Headers(patchCall?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      description: "2단원까지 복습해 오세요.",
      due_date: "2026-07-15",
      schedule_type: "exam",
      subject: "수학",
      title: "수학 단원평가",
    });
  });

  it("uses history for an internal return to the exact originating list entry", async () => {
    renderDetail("teacher", schedule, "schedule-origin");

    expect(await screen.findByRole("heading", { name: "수학 단원평가", level: 1 })).toBeVisible();
    const backButton = screen.getByRole("button", { name: "일정" });
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).queryByRole("link", {
        name: "일정",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(backButton);

    expect(await screen.findByRole("status", { name: "일정 목록 검색 조건" })).toHaveTextContent(
      "?scope=past&from=kept",
    );
  });

  it("validates a Unicode delete reason and cancels the custom dialog without deleting", async () => {
    const fetchMock = renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "일정 삭제 옵션" }));
    const reason = await screen.findByRole("textbox", { name: /삭제 사유/u });
    const deleteButton = screen.getByRole("button", { name: "일정 삭제" });

    fireEvent.change(reason, { target: { value: "가".repeat(301) } });
    fireEvent.click(deleteButton);
    expect(await screen.findByText("삭제 사유는 300자 이하로 입력해 주세요.")).toBeVisible();
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.change(reason, { target: { value: "가".repeat(300) } });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole("dialog", { name: /일정을 삭제할까요/u });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          requestUrl(input) === "/api/v1/schedules/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          requestUrl(input) === "/api/v1/schedules/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);
  });

  it("renders a past schedule for a student without D+ or mutation controls", async () => {
    renderDetail("student", {
      ...schedule,
      d_day_label: null,
      days_until: -2,
      due_date: "2026-07-12",
      title: "지난 수행평가",
    });

    expect(await screen.findByRole("heading", { name: "지난 수행평가" })).toBeVisible();
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).getByRole("link", {
        name: "일정",
      }),
    ).toHaveAttribute("href", "/schedules?scope=past");
    expect(screen.queryByText(/D\+/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "일정 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "일정 삭제" })).not.toBeInTheDocument();
    expect(screen.queryByText("위험 작업")).not.toBeInTheDocument();
  });
});
