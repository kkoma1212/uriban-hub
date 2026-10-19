import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduleItem } from "../../api/schedules";
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

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function renderSession(mutation: "PATCH" | "DELETE", late: boolean) {
  let rejectRefresh!: () => void;
  const refresh = new Promise<Response>((resolve) => {
    rejectRefresh = () =>
      resolve(
        jsonResponse(
          {
            error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." },
          },
          401,
        ),
      );
  });
  let reads = 0;
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
    if (url.endsWith("/links")) return Promise.resolve(jsonResponse({ notices: [], supplies: [] }));
    if (url === "/api/v1/schedules/18")
      return Promise.resolve(
        jsonResponse({ ...schedule, id: "18", title: "새 일정" }, 200, {
          ETag: '"4"',
        }),
      );
    if (url === "/api/v1/schedules/17") {
      if (init?.method === mutation)
        return Promise.resolve(
          jsonResponse({ error: { code: "RESOURCE_VERSION_CHANGED", message: "충돌" } }, 409),
        );
      reads += 1;
      return reads === 1 ? Promise.resolve(jsonResponse(schedule, 200, { ETag: '"4"' })) : refresh;
    }
    throw new Error(`예상하지 않은 경로: ${url}`);
  });
  function Path() {
    return <output data-testid="경로">{useLocation().pathname}</output>;
  }
  render(
    <MemoryRouter initialEntries={["/schedules/17"]}>
      <Link to="/schedules/18">다음 일정</Link>
      <Path />
      <Routes>
        <Route path="/schedules/:scheduleId" element={<ScheduleDetailPage />} />
        <Route path="/login" element={<h1>로그인</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  return { fetchMock, rejectRefresh, late };
}
for (const mutation of ["PATCH", "DELETE"] as const) {
  for (const late of [false, true]) {
    it(`${mutation} 충돌 후 최신 조회 401: ${late ? "이전 페이지 응답은 현재 페이지를 보존" : "현재 페이지는 캐시 제거 후 로그인 이동"}`, async () => {
      const { fetchMock, rejectRefresh } = renderSession(mutation, late);
      await screen.findByText("수학 단원평가");
      sessionStorage.setItem("classhub:idempotent-create:old", "보존 검사");
      if (mutation === "DELETE") {
        fireEvent.click(screen.getByRole("button", { name: "일정 삭제 옵션" }));
        fireEvent.click(screen.getByRole("button", { name: "일정 삭제" }));
        fireEvent.click(
          within(screen.getByRole("dialog")).getByRole("button", {
            name: "일정 삭제",
          }),
        );
      } else {
        fireEvent.click(screen.getByRole("button", { name: "일정 수정" }));
        fireEvent.change(screen.getByRole("textbox", { name: "일정 제목" }), {
          target: { value: "수정 일정" },
        });
        fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
      }
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(
            ([input, init]) =>
              requestUrl(input) === "/api/v1/schedules/17" &&
              (init?.method === undefined || init.method === "GET"),
          ),
        ).toHaveLength(2),
      );
      if (late) {
        fireEvent.click(screen.getByText("다음 일정"));
        await screen.findByText("새 일정");
      }
      await act(async () => rejectRefresh());
      if (late) {
        expect(screen.getByTestId("경로")).toHaveTextContent("/schedules/18");
        expect(sessionStorage.getItem("classhub:idempotent-create:old")).toBe("보존 검사");
      } else {
        await screen.findByRole("heading", { name: "로그인" });
        expect(sessionStorage.getItem("classhub:idempotent-create:old")).toBeNull();
      }
    });
  }
}

it("hides the previous schedule and its editing tools while the next schedule loads", async () => {
  let finishNext!: (response: Response) => void;
  const nextSchedule = new Promise<Response>((resolve) => {
    finishNext = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
    if (url.endsWith("/links")) return Promise.resolve(jsonResponse({ notices: [], supplies: [] }));
    if (url === "/api/v1/schedules/17") return Promise.resolve(jsonResponse(schedule));
    if (url === "/api/v1/schedules/18") return nextSchedule;
    throw new Error(`예상하지 않은 경로: ${url}`);
  });
  render(
    <MemoryRouter initialEntries={["/schedules/17"]}>
      <Link to="/schedules/18">다음 일정</Link>
      <Routes>
        <Route path="/schedules/:scheduleId" element={<ScheduleDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText("수학 단원평가");
  fireEvent.click(screen.getByRole("button", { name: "일정 수정" }));
  fireEvent.change(screen.getByRole("textbox", { name: "일정 제목" }), {
    target: { value: "이전 일정의 미저장 변경" },
  });
  fireEvent.click(screen.getByText("다음 일정"));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "일정 제목" })).toBeNull());
  expect(screen.queryByRole("button", { name: "수정 저장" })).toBeNull();
  expect(screen.queryByRole("button", { name: "일정 삭제 옵션" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PATCH" || init?.method === "DELETE",
    ),
  ).toHaveLength(0);
  await act(async () => finishNext(jsonResponse({ ...schedule, id: "18", title: "새 일정" })));
  await screen.findByText("새 일정");
  expect(screen.queryByRole("textbox", { name: "일정 제목" })).toBeNull();
});
