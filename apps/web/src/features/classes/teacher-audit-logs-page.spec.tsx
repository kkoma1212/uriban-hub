import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogItem } from "../../api/audit-logs";
import {
  auditActionLabel,
  auditChangeSummary,
  auditReasonLabel,
  TeacherAuditLogsPage,
} from "./teacher-audit-logs-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "41", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "41",
    id: "51",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const classItem: AuditLogItem = {
  action: "class.updated",
  actor: { display_name: "김교사", role: "teacher" },
  after: { name: "새 반" },
  before: { name: "이전 반" },
  created_at: "2026-07-18T03:04:05.123456Z",
  reason: "학급명 정정",
  target: { id: "101", snapshot: null, type: "class" },
};

const noticeItem: AuditLogItem = {
  action: "notice.updated",
  actor: { display_name: "김교사", role: "teacher" },
  after: { title: "새 공지" },
  before: { title: "이전 공지" },
  created_at: "2026-07-17T03:04:05.123456Z",
  reason: null,
  target: { id: "202", snapshot: null, type: "notice" },
};

const reminderItem: AuditLogItem = {
  action: "notice.reminder_created",
  actor: { display_name: "김교사", role: "teacher" },
  after: {
    content_revision: "3",
    cooldown_suppressed_count: 1,
    created_count: 2,
    current_unresolved_count: 4,
    reminder_batch_id: "b9fa877e-af6d-4d52-a3c5-306b5da229a1",
  },
  before: null,
  created_at: "2026-07-17T03:04:05.123456Z",
  reason: null,
  target: { id: "203", snapshot: null, type: "notice" },
};

const adjustedSeatItem: AuditLogItem = {
  action: "seat_draw.adjusted",
  actor: { display_name: "박교사", role: "teacher" },
  after: { assigned_student_count: 28, row_count: 6 },
  before: null,
  created_at: "2026-07-16T03:04:05.123456Z",
  reason: "teacher_swap_assignments",
  target: { id: "204", snapshot: null, type: "seat_draw" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function errorResponse(message: string): Response {
  return jsonResponse({ error: { code: "INTERNAL_ERROR", message } }, 503);
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button onClick={() => void navigate(-1)} type="button">
        테스트 뒤로
      </button>
    </>
  );
}

function renderPage(initialEntry = "/class/manage/audit-logs"): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route element={<TeacherAuditLogsPage />} path="/class/manage/audit-logs" />
        <Route element={<p>반 관리 화면</p>} path="/class/manage" />
        <Route element={<p>초기 설정 화면</p>} path="/bootstrap" />
        <Route element={<p>로그인 화면</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

function bootstrapResponse(url: string): Response | undefined {
  if (url === "/api/v1/bootstrap") return jsonResponse(teacherBootstrap);
  return undefined;
}

describe("TeacherAuditLogsPage", () => {
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    vi.restoreAllMocks();
  });

  it("renders the safe Korean activity summary and requests the default 90-day window", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const bootstrap = bootstrapResponse(url);
      if (bootstrap !== undefined) return Promise.resolve(bootstrap);
      if (url === "/api/v1/audit-logs?days=90") {
        return Promise.resolve(
          jsonResponse({ items: [classItem, adjustedSeatItem], next_cursor: null }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    expect(await screen.findByRole("heading", { name: "반 정보를 수정했어요" })).toBeVisible();
    expect(screen.getByText("반 이름: 이전 반 → 새 반")).toBeVisible();
    expect(screen.getByText("김교사").closest("p")).toHaveTextContent("실행: 김교사 · 선생님");
    expect(screen.getByText("학급명 정정").closest("p")).toHaveTextContent("사유: 학급명 정정");
    expect(screen.getByText("두 학생의 자리를 서로 바꿈").closest("p")).toHaveTextContent(
      "사유: 두 학생의 자리를 서로 바꿈",
    );
    expect(screen.queryByText("teacher_swap_assignments")).not.toBeInTheDocument();
    expect(screen.getByLabelText("활동 종류")).toHaveValue("");
    expect(screen.getByLabelText("조회 기간")).toHaveValue("90");
    expect(auditActionLabel("notice.unapproved")).toBe("기타 활동");
    expect(auditActionLabel("seat_draw.published")).toBe("자리표를 공개했어요");
    expect(auditActionLabel("team_draw.published")).toBe("모둠표를 공개했어요");
    expect(auditActionLabel("notice.reminder_created")).toBe("공지 다시 확인을 요청했어요");
    expect(auditActionLabel("supply.reminder_created")).toBe("준비물·숙제 다시 확인을 요청했어요");
    expect(auditActionLabel("seat_draw.adjusted")).toBe("자리표를 조정했어요");
    expect(auditActionLabel("team_draw.adjusted")).toBe("모둠표를 조정했어요");
    expect(auditReasonLabel("seat_draw.adjusted", "teacher_swap_assignments")).toBe(
      "두 학생의 자리를 서로 바꿈",
    );
    expect(auditReasonLabel("seat_draw.adjusted", "teacher_move_assignment")).toBe(
      "학생 한 명의 자리를 이동함",
    );
    expect(auditReasonLabel("team_draw.adjusted", "teacher_swap_assignments")).toBe(
      "두 학생의 모둠을 서로 바꿈",
    );
    expect(auditReasonLabel("class.updated", "학급명 정정")).toBe("학급명 정정");
    for (const label of ["공지 다시 확인을 요청했어요", "준비물·숙제 다시 확인을 요청했어요"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("option", { name: /자리표|모둠표|당번/u })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "자리표를 조정했어요" })).toBeVisible();
    for (const link of screen.getAllByRole("link"))
      expect(link.getAttribute("href")).not.toMatch(/^\/(seating|grouping|duty)(?:\/|$)/u);
    expect(auditChangeSummary(reminderItem)).toEqual([
      "몇 번째 내용: 3",
      "재요청 대기 중인 학생 수: 1",
      "새로 요청한 학생 수: 2",
      "현재 미확인 학생 수: 4",
    ]);

    const auditCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === "/api/v1/audit-logs?days=90",
    );
    expect(auditCall?.[1]).toMatchObject({ credentials: "include" });
  });

  it("keeps prior items on a partial-page error and retries the same cursor", async () => {
    let moreCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const bootstrap = bootstrapResponse(url);
      if (bootstrap !== undefined) return Promise.resolve(bootstrap);
      if (url === "/api/v1/audit-logs?days=90") {
        return Promise.resolve(jsonResponse({ items: [classItem], next_cursor: "next cursor" }));
      }
      if (url === "/api/v1/audit-logs?days=90&cursor=next+cursor") {
        moreCalls += 1;
        return Promise.resolve(
          moreCalls === 1
            ? errorResponse("이전 기록을 불러오지 못했습니다.")
            : jsonResponse({ items: [noticeItem], next_cursor: null }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();
    const moreButton = await screen.findByRole("button", {
      name: "이전 활동 더 보기",
    });
    moreButton.focus();
    fireEvent.click(moreButton);

    const alert = await screen.findByRole("alert", {
      name: "이전 감사 로그 일부 불러오기 오류",
    });
    expect(alert).toHaveFocus();
    expect(screen.getByRole("heading", { name: "반 정보를 수정했어요" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByRole("heading", { name: "공지를 수정했어요" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "반 정보를 수정했어요" })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/audit-logs?days=90&cursor=next+cursor",
      ),
    ).toHaveLength(2);
  });

  // 학년 중간에 부임한 담임이 전임 시절 기록을 보려면 보관기간(365일)까지 닿아야
  // 한다. 예전 URL 파싱은 아는 값 셋 외를 전부 90으로 떨어뜨렸다(T-HUB-13).
  it("honours a full-year window from the URL instead of falling back to 90 days", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const bootstrap = bootstrapResponse(url);
      if (bootstrap !== undefined) return Promise.resolve(bootstrap);
      if (url === "/api/v1/audit-logs?days=365") {
        return Promise.resolve(jsonResponse({ items: [classItem], next_cursor: null }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage("/class/manage/audit-logs?days=365");

    expect(await screen.findByRole("heading", { name: "반 정보를 수정했어요" })).toBeVisible();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/v1/audit-logs?days=365"),
      ).toBe(true);
    });
    expect(screen.getByRole("combobox", { name: "조회 기간" })).toHaveValue("365");
  });

  it("stores filters in URL history, resets the old cursor, and restores filters on Back", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const bootstrap = bootstrapResponse(url);
      if (bootstrap !== undefined) return Promise.resolve(bootstrap);
      if (url === "/api/v1/audit-logs?days=90") {
        return Promise.resolve(jsonResponse({ items: [classItem], next_cursor: "old cursor" }));
      }
      if (url === "/api/v1/audit-logs?days=90&action=notice.updated") {
        return Promise.resolve(jsonResponse({ items: [noticeItem], next_cursor: null }));
      }
      if (url === "/api/v1/audit-logs?days=30&action=notice.updated") {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                ...noticeItem,
                after: { title: "30일 공지" },
                target: { ...noticeItem.target, id: "203" },
              },
            ],
            next_cursor: null,
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();
    await screen.findByRole("heading", { name: "반 정보를 수정했어요" });
    fireEvent.change(screen.getByLabelText("활동 종류"), {
      target: { value: "notice.updated" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/class/manage/audit-logs?action=notice.updated&days=90",
      ),
    );
    expect(await screen.findByRole("heading", { name: "공지를 수정했어요" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "반 정보를 수정했어요" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이전 활동 더 보기" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("조회 기간"), {
      target: { value: "30" },
    });
    expect(await screen.findByText("30일 공지")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/class/manage/audit-logs?action=notice.updated&days=30",
    );

    fireEvent.click(screen.getByRole("button", { name: "테스트 뒤로" }));
    await waitFor(() => {
      expect(screen.getByLabelText("활동 종류")).toHaveValue("notice.updated");
      expect(screen.getByLabelText("조회 기간")).toHaveValue("90");
    });
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes("cursor=old"))).toBe(
      false,
    );
  });

  it("recovers a full-load error and distinguishes filtered empty results", async () => {
    let auditCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      const bootstrap = bootstrapResponse(url);
      if (bootstrap !== undefined) return Promise.resolve(bootstrap);
      if (url.startsWith("/api/v1/audit-logs?")) {
        auditCalls += 1;
        return Promise.resolve(
          auditCalls === 1
            ? errorResponse("감사 로그 서비스가 잠시 불안정합니다.")
            : jsonResponse({ items: [], next_cursor: null }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("감사 로그 서비스가 잠시 불안정합니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "아직 기록된 활동이 없어요" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("조회 기간"), {
      target: { value: "7" },
    });
    expect(await screen.findByRole("heading", { name: "조건에 맞는 활동이 없어요" })).toBeVisible();
  });

  it.each([360, 390, 1440])(
    "keeps native, keyboard-focusable 44px filters at %ipx",
    async (width) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      window.dispatchEvent(new Event("resize"));
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        const bootstrap = bootstrapResponse(url);
        if (bootstrap !== undefined) return Promise.resolve(bootstrap);
        if (url === "/api/v1/audit-logs?days=90") {
          return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      renderPage();
      await screen.findByRole("heading", {
        name: "아직 기록된 활동이 없어요",
      });
      const filter = screen.getByRole("region", { name: "감사 로그 필터" });
      const action = screen.getByLabelText("활동 종류");
      const days = screen.getByLabelText("조회 기간");
      expect(filter).toHaveClass("min-w-0", "sm:grid-cols-2");
      for (const control of [action, days]) {
        expect(control.tagName).toBe("SELECT");
        expect(control).toHaveClass("min-h-11", "w-full", "min-w-0");
        control.focus();
        expect(control).toHaveFocus();
      }
    },
  );
});
