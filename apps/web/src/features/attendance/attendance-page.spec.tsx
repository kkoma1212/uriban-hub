import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttendancePage } from "./attendance-page";

const bootstrapBase = {
  account: { email_verified: true, is_active: true },
  allowed_actions: [
    "CHANGE_PASSWORD",
    "LOGOUT",
    "VIEW_CLASS",
    "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
  ],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "student",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: null,
};

const studentBootstrap = bootstrapBase;
const teacherBootstrap = {
  ...bootstrapBase,
  allowed_actions: [
    "CHANGE_PASSWORD",
    "LOGOUT",
    "VIEW_CLASS",
    "MANAGE_CLASS",
    "MANAGE_ATTENDANCE_NOTIFICATIONS",
  ],
  current_membership: { ...bootstrapBase.current_membership, role: "teacher" },
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const studentItem = {
  acknowledged_at: null,
  expected_time: "08:30",
  id: "17",
  notification_type: "late",
  row_version: "4",
  status: "pending",
  submitted_at: "2026-07-18T00:01:00.000Z",
  updated_at: "2026-07-18T00:01:00.000Z",
};

const teacherItem = {
  ...studentItem,
  account_state: "inactive",
  display_name: "김학생",
  member_id: "31",
  membership_state: "removed",
  student_number: 7,
};

const counts = { absent: 1, acknowledged: 1, early: 1, late: 1, pending: 2, total: 4 };

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function errorResponse(code: string, message: string, status = 409): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

// 실제 SystemStateBanner는 유지하고, 공개 상태 조회만 API 계약대로 따로 응답한다.
// 일회성 화면 API 응답과 호출 횟수는 공개 상태 조회가 소비하지 않는다.
function mockFeatureFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const featureFetch = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (requestUrl(input) === "/api/v1/public/system-state") {
      return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
    }
    return featureFetch(input, init);
  });
  return featureFetch;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function studentToday(notification: unknown = null): unknown {
  return { notification, role: "student", server_today: "2026-07-18" };
}

function teacherToday(
  items: unknown[] = [teacherItem],
  nextCursor: string | null = null,
  nextCounts = counts,
): unknown {
  return {
    counts: nextCounts,
    items,
    next_cursor: nextCursor,
    role: "teacher",
    server_today: "2026-07-18",
  };
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
      <button onClick={() => void navigate("/updates")} type="button">
        테스트 이탈
      </button>
      <button onClick={() => void navigate("/attendance?type=late")} type="button">
        테스트 지각 필터
      </button>
    </>
  );
}

function renderAttendance(initialEntry = "/attendance", withLocation = false): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      {withLocation ? <LocationProbe /> : null}
      <Routes>
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/bootstrap" element={<p>초기 설정 화면</p>} />
        <Route path="/login" element={<p>로그인 화면</p>} />
        <Route path="/home" element={<p>홈 화면</p>} />
        <Route path="/updates" element={<p>통합 알림 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AttendancePage", () => {
  it("keeps bootstrap preparation visible while the redirect destination is loading", async () => {
    const destination = deferred<null>();
    mockFeatureFetch().mockResolvedValue(
      jsonResponse({ ...studentBootstrap, allowed_actions: ["VIEW_CLASS"] }),
    );
    const router = createMemoryRouter(
      [
        { path: "/attendance", element: <AttendancePage /> },
        { path: "/home", loader: () => destination.promise, element: <p>홈 화면</p> },
      ],
      { initialEntries: ["/attendance"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.navigation.location?.pathname).toBe("/home"));
    expect(screen.getByText("출결 연락 화면을 준비하고 있어요.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    await act(async () => destination.resolve(null));
    expect(await screen.findByText("홈 화면")).toBeVisible();
  });
  it.each(["update", "cancel"])(
    "ignores late student %s unauthorized response after leaving",
    async (operation) => {
      const pending = deferred<Response>();
      mockFeatureFetch().mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
        if (init?.method === "PATCH" || url.endsWith("/cancel")) return pending.promise;
        if (url.includes("history"))
          return Promise.resolve(
            jsonResponse({
              counts: { absent: 0, early: 0, late: 0 },
              items: [],
              range: { from: "2025-07-18", to: "2026-07-18" },
            }),
          );
        return Promise.resolve(jsonResponse(studentToday(studentItem), 200, { ETag: '"4"' }));
      });
      renderAttendance("/attendance", true);
      await screen.findByRole("heading", { name: "지각 · 08:30 예정" });
      if (operation === "update") {
        fireEvent.click(screen.getByRole("button", { name: "유형·시각 수정" }));
        fireEvent.click(screen.getByRole("button", { name: "수정 내용 저장" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "연락 취소" }));
        fireEvent.click(
          within(screen.getByRole("dialog", { name: "오늘 출결 연락을 취소할까요?" })).getByRole(
            "button",
            { name: "연락 취소" },
          ),
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
      await screen.findByText("통합 알림 화면");
      await act(async () => pending.resolve(errorResponse("UNAUTHENTICATED", "로그인 필요", 401)));
      expect(screen.getByText("통합 알림 화면")).toBeVisible();
    },
  );
  it.each(["mutation", "reconcile"])(
    "ignores teacher %s unauthorized completion after leaving",
    async (stage) => {
      const pending = deferred<Response>();
      let listCalls = 0;
      mockFeatureFetch().mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
        if (url.endsWith("/acknowledge"))
          return stage === "mutation"
            ? pending.promise
            : Promise.resolve(errorResponse("ATTENDANCE_NOTIFICATION_VERSION_CONFLICT", "바뀜"));
        listCalls += 1;
        if (stage === "reconcile" && listCalls > 2) return pending.promise;
        return Promise.resolve(jsonResponse(teacherToday()));
      });
      renderAttendance("/attendance", true);
      await screen.findByText("김학생");
      fireEvent.click(screen.getByRole("button", { name: "읽음으로 확인" }));
      const dialog = screen.getByRole("dialog", { name: "김학생 학생 연락을 확인할까요?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "읽음으로 확인" }));
      if (stage === "reconcile") await waitFor(() => expect(listCalls).toBeGreaterThan(2));
      fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
      await screen.findByText("통합 알림 화면");
      await act(async () => pending.resolve(errorResponse("UNAUTHENTICATED", "로그인 필요", 401)));
      expect(screen.getByText("통합 알림 화면")).toBeVisible();
    },
  );
  it.each(["401", "permission", "success"])(
    "ignores late bootstrap %s after leaving",
    async (outcome) => {
      const pending = deferred<Response>();
      mockFeatureFetch().mockReturnValue(pending.promise);
      renderAttendance("/attendance", true);
      fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
      await screen.findByText("통합 알림 화면");
      await act(async () =>
        pending.resolve(
          outcome === "401"
            ? errorResponse("UNAUTHENTICATED", "로그인 필요", 401)
            : jsonResponse(
                outcome === "permission"
                  ? { ...studentBootstrap, allowed_actions: [] }
                  : studentBootstrap,
              ),
        ),
      );
      expect(screen.getByText("통합 알림 화면")).toBeVisible();
      expect(screen.getByTestId("location")).toHaveTextContent("/updates");
    },
  );

  it.each([false, true])(
    "keeps cached teacher A after held B finishes, unauthorized=%s",
    async (unauthorized) => {
      const pending = deferred<Response>();
      mockFeatureFetch().mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
        if (url.includes("type=late")) return pending.promise;
        return Promise.resolve(jsonResponse(teacherToday()));
      });
      renderAttendance("/attendance", true);
      await screen.findByText("김학생");
      fireEvent.click(screen.getByRole("button", { name: "테스트 지각 필터" }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("type=late"));
      fireEvent.click(screen.getByRole("button", { name: "테스트 뒤로" }));
      await screen.findByText("김학생");
      await act(async () =>
        pending.resolve(
          unauthorized
            ? errorResponse("UNAUTHENTICATED", "로그인 필요", 401)
            : jsonResponse(teacherToday([{ ...teacherItem, display_name: "이전 필터 학생" }])),
        ),
      );
      expect(screen.getByText("김학생")).toBeVisible();
      expect(screen.queryByText("이전 필터 학생")).not.toBeInTheDocument();
      expect(screen.getByTestId("location")).toHaveTextContent("/attendance");
      expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    },
  );

  it.each(["success", "401", "unknown"])(
    "ignores late student creation %s without touching another session attempt",
    async (outcome) => {
      const pending = deferred<Response>();
      mockFeatureFetch().mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
        if (init?.method === "POST") return pending.promise;
        if (url.includes("history"))
          return Promise.resolve(
            jsonResponse({
              counts: { absent: 0, early: 0, late: 0 },
              items: [],
              range: { from: "2025-07-18", to: "2026-07-18" },
            }),
          );
        return Promise.resolve(jsonResponse(studentToday()));
      });
      renderAttendance("/attendance", true);
      fireEvent.click(await screen.findByLabelText("결석"));
      fireEvent.click(screen.getByRole("button", { name: "연락 보내기" }));
      await waitFor(() => expect(sessionStorage.length).toBeGreaterThan(0));
      const attemptKey = Object.keys(sessionStorage).find((key) => key.includes("attendance"))!;
      fireEvent.click(screen.getByRole("button", { name: "테스트 이탈" }));
      await screen.findByText("통합 알림 화면");
      sessionStorage.setItem(attemptKey, "new-session-attempt");
      await act(async () =>
        pending.resolve(
          outcome === "success"
            ? jsonResponse({ ...studentItem, notification_type: "absent", expected_time: null })
            : errorResponse(
                outcome === "401" ? "UNAUTHENTICATED" : "SERVER_ERROR",
                "늦은 오류",
                outcome === "401" ? 401 : 500,
              ),
        ),
      );
      expect(screen.getByText("통합 알림 화면")).toBeVisible();
      expect(sessionStorage.getItem(attemptKey)).toBe("new-session-attempt");
    },
  );
  beforeEach(() => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("redirects a direct visit when the attendance feature action is absent", async () => {
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(
          jsonResponse({
            ...studentBootstrap,
            allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();

    expect(await screen.findByText("홈 화면")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "출결 연락" })).not.toBeInTheDocument();
  });

  it("shows only the student's own recent-year notification counts", async () => {
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/attendance-notifications/today?status=all&type=all") {
        return Promise.resolve(jsonResponse(studentToday()));
      }
      if (url === "/api/v1/attendance-notifications/history?from=2025-07-18&to=2026-07-18") {
        return Promise.resolve(
          jsonResponse({
            counts: { absent: 1, early: 1, late: 2, total: 4 },
            items: [],
            range: { from: "2025-07-18", to: "2026-07-18" },
            role: "student",
            server_today: "2026-07-18",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();

    fireEvent.click(await screen.findByText("최근 출결 연락 보기"));
    const summary = await screen.findByRole("region", { name: "내가 알린 출결" });
    expect(within(summary).getByText("최근 1년")).toBeVisible();
    await waitFor(() =>
      expect(Array.from(summary.querySelectorAll("dt")).map((item) => item.textContent)).toEqual([
        "전체",
        "지각",
        "결석",
        "조퇴",
      ]),
    );
    expect(Array.from(summary.querySelectorAll("dd")).map((item) => item.textContent)).toEqual([
      "4회",
      "2회",
      "1회",
      "1회",
    ]);
    expect(within(summary).getByText(/공식 출석부가 아니라/u)).toBeVisible();
  });

  it("keeps a successful student create over a late refresh and submits only once", async () => {
    const createPending = deferred<Response>();
    const lateRefresh = deferred<Response>();
    let todayCalls = 0;
    const fetchMock = mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/attendance-notifications/today?status=all&type=all") {
        todayCalls += 1;
        return todayCalls === 1
          ? Promise.resolve(jsonResponse(studentToday()))
          : lateRefresh.promise;
      }
      if (url === "/api/v1/attendance-notifications") return createPending.promise;
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();

    expect(await screen.findByText("오늘 보낸 출결 연락이 없어요.")).toBeVisible();
    const studentHeading = screen.getByRole("heading", { level: 1, name: "출결 연락" });
    expect(studentHeading).toBeVisible();
    expect(studentHeading.closest("header")).toHaveAttribute(
      "data-attendance-header-role",
      "student",
    );
    expect(studentHeading.closest("header")).toHaveClass("content-frame-header");
    const studentForm = document.querySelector<HTMLElement>(
      '[data-attendance-surface="student-form"]',
    );
    if (studentForm === null) throw new Error("출결 연락 폼을 찾지 못했습니다.");
    expect(within(studentForm).getByRole("radiogroup", { name: "출결 연락 종류" })).toBeVisible();
    expect(
      within(studentForm).getByRole("button", { name: "예정 시각을 입력해 주세요" }),
    ).toBeDisabled();
    const boundarySummary = within(studentForm).getByText("공식 출결이 아닌 사전 연락이에요");
    fireEvent.click(boundarySummary);
    expect(boundarySummary.closest("details")).toHaveAttribute("open");
    expect(screen.queryByText("학생별 접수 현황")).not.toBeInTheDocument();
    const lateRadio = screen.getByRole("radio", { name: "지각" });
    expect(lateRadio).toBeChecked();
    expect(lateRadio.closest("label")).toHaveClass(
      "border-role-primary",
      "bg-role-soft",
      "text-role-primary",
    );
    expect(screen.getByLabelText("도착 예정 시각")).toHaveAttribute("step", "60");

    fireEvent.click(screen.getByRole("radio", { name: "결석" }));
    expect(screen.queryByLabelText("도착 예정 시각")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(todayCalls).toBe(2));
    const submit = screen.getByRole("button", { name: "연락 보내기" });
    const form = submit.closest("form");
    if (form === null) throw new Error("출결 연락 폼을 찾지 못했습니다.");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(submit).toBeDisabled());
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/attendance-notifications",
      ),
    ).toHaveLength(1);

    createPending.resolve(
      jsonResponse({ ...studentItem, expected_time: null, notification_type: "absent" }, 201, {
        ETag: '"4"',
      }),
    );
    const successNotice = await screen.findByText("오늘 출결 연락을 보냈어요.");
    expect(successNotice).toBeVisible();
    expect(successNotice).toHaveClass(
      "border-home-supplies-line",
      "bg-home-supplies-soft",
      "text-home-supplies",
    );
    const statusHeading = screen.getByRole("heading", { name: "결석 · 하루 종일" });
    expect(statusHeading).toBeVisible();
    expect(statusHeading.closest('[data-attendance-surface="student-status"]')).toHaveClass(
      "border-role-border",
      "bg-app-surface",
    );
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await act(async () => {
      lateRefresh.resolve(jsonResponse(studentToday()));
    });
    expect(screen.getByRole("heading", { name: "결석 · 하루 종일" })).toBeVisible();
    expect(screen.queryByText("오늘 보낸 출결 연락이 없어요.")).not.toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === "/api/v1/attendance-notifications",
    );
    expect(createCall?.[1]?.body).toBe(
      JSON.stringify({ expected_time: null, notification_type: "absent" }),
    );
  });

  it("retries a lost create response with the same key and one logical record", async () => {
    const storedByKey = new Map<string, typeof studentItem>();
    const submittedKeys: string[] = [];
    let createdRows = 0;
    let loseFirstResponse = true;
    mockFeatureFetch().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/attendance-notifications/today?status=all&type=all") {
        return Promise.resolve(jsonResponse(studentToday()));
      }
      if (url === "/api/v1/attendance-notifications" && init?.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        if (!storedByKey.has(key)) {
          storedByKey.set(key, studentItem);
          createdRows += 1;
        }
        if (loseFirstResponse) {
          loseFirstResponse = false;
          return Promise.reject(new TypeError("response lost after commit"));
        }
        return Promise.resolve(jsonResponse(storedByKey.get(key), 201, { ETag: '"4"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    await screen.findByText("오늘 보낸 출결 연락이 없어요.");
    fireEvent.change(screen.getByLabelText("도착 예정 시각"), { target: { value: "08:30" } });
    fireEvent.click(screen.getByRole("button", { name: "연락 보내기" }));

    expect(
      await screen.findByText(/출결 연락 전송 요청이 저장됐는지 확인하지 못했어요/u),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "지각" })).toBeDisabled();
    expect(screen.getByLabelText("도착 예정 시각")).toBeDisabled();
    expect(screen.getByRole("button", { name: "결과 다시 확인" })).toBeEnabled();
    expect(createdRows).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));
    expect(await screen.findByText("오늘 출결 연락을 보냈어요.")).toBeVisible();
    expect(submittedKeys).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(createdRows).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("retires an unresolved previous-date attempt before allowing today's new key", async () => {
    const previousKey = "99999999-9999-4999-8999-999999999999";
    window.sessionStorage.setItem(
      "classhub:idempotent-create:attendance:1",
      JSON.stringify({
        idempotencyKey: previousKey,
        request: {
          body: { expected_time: "08:30", notification_type: "late" },
          serverToday: "2026-07-17",
        },
        startedAt: Date.now(),
        version: 1,
      }),
    );
    let submittedKey: string | null = null;
    mockFeatureFetch().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url === "/api/v1/attendance-notifications/today?status=all&type=all") {
        return Promise.resolve(jsonResponse(studentToday()));
      }
      if (url === "/api/v1/attendance-notifications" && init?.method === "POST") {
        submittedKey = new Headers(init.headers).get("Idempotency-Key");
        return Promise.resolve(jsonResponse(studentItem, 201, { ETag: '"4"' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    expect(
      await screen.findByText(/기준 날짜가 바뀌어 이전 날짜 요청은 다시 보내지 않았습니다/u),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "지각" })).toBeEnabled();
    expect(screen.getByLabelText("도착 예정 시각")).toHaveValue("08:30");
    fireEvent.click(screen.getByRole("button", { name: "연락 보내기" }));

    expect(await screen.findByText("오늘 출결 연락을 보냈어요.")).toBeVisible();
    expect(submittedKey).toBe("11111111-1111-4111-8111-111111111111");
    expect(submittedKey).not.toBe(previousKey);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("keeps student update and cancel successes over late refreshes and guards cancel", async () => {
    const lateUpdateRefresh = deferred<Response>();
    const lateCancelRefresh = deferred<Response>();
    const cancelPending = deferred<Response>();
    let todayCalls = 0;
    let cancelCalls = 0;
    const fetchMock = mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url.startsWith("/api/v1/attendance-notifications/today")) {
        todayCalls += 1;
        if (todayCalls === 1)
          return Promise.resolve(jsonResponse(studentToday(studentItem), 200, { ETag: '"4"' }));
        if (todayCalls === 2) return lateUpdateRefresh.promise;
        if (todayCalls === 3) return lateCancelRefresh.promise;
      }
      if (url === "/api/v1/attendance-notifications/17") {
        return Promise.resolve(
          jsonResponse(
            {
              ...studentItem,
              expected_time: "13:15",
              notification_type: "early",
              row_version: "5",
            },
            200,
            { ETag: '"5"' },
          ),
        );
      }
      if (url === "/api/v1/attendance-notifications/17/cancel") {
        cancelCalls += 1;
        return cancelPending.promise;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    expect(await screen.findByRole("heading", { name: "지각 · 08:30 예정" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(todayCalls).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "유형·시각 수정" }));
    fireEvent.click(screen.getByRole("radio", { name: "조퇴" }));
    fireEvent.change(screen.getByLabelText("조퇴 예정 시각"), { target: { value: "13:15" } });
    fireEvent.click(screen.getByRole("button", { name: "수정 내용 저장" }));

    expect(await screen.findByText("출결 연락을 수정했어요.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "조퇴 · 13:15 예정" })).toBeVisible();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await act(async () => {
      lateUpdateRefresh.resolve(jsonResponse(studentToday(studentItem), 200, { ETag: '"4"' }));
    });
    expect(screen.getByRole("heading", { name: "조퇴 · 13:15 예정" })).toBeVisible();
    const patchCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === "/api/v1/attendance-notifications/17",
    );
    expect(patchCall?.[1]?.method).toBe("PATCH");
    expect(new Headers(patchCall?.[1]?.headers).get("If-Match")).toBe('"4"');

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(todayCalls).toBe(3));
    const cancelTrigger = screen.getByRole("button", { name: "연락 취소" });
    fireEvent.click(cancelTrigger);
    const dialog = screen.getByRole("dialog", { name: "오늘 출결 연락을 취소할까요?" });
    expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
    const confirmCancel = within(dialog).getByRole("button", { name: "연락 취소" });
    act(() => {
      confirmCancel.click();
      confirmCancel.click();
    });
    expect(cancelCalls).toBe(1);
    expect(screen.getByText(/기준 날짜/u)).toHaveFocus();
    cancelPending.resolve(jsonResponse({ ...studentItem, row_version: "6", status: "canceled" }));
    expect(await screen.findByText(/오늘 출결 연락을 취소했어요/u)).toBeVisible();
    expect(screen.getByText("오늘 보낸 출결 연락이 없어요.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("radio", { name: "조퇴" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await act(async () => {
      lateCancelRefresh.resolve(
        jsonResponse(
          studentToday({
            ...studentItem,
            expected_time: "13:15",
            notification_type: "early",
            row_version: "5",
          }),
          200,
          { ETag: '"5"' },
        ),
      );
    });
    expect(screen.getByText("오늘 보낸 출결 연락이 없어요.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "조퇴 · 13:15 예정" })).not.toBeInTheDocument();
    const cancelCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === "/api/v1/attendance-notifications/17/cancel",
    );
    expect(cancelCall?.[1]?.body).toBeUndefined();
    expect(new Headers(cancelCall?.[1]?.headers).get("If-Match")).toBe('"5"');
  });

  it("locks an acknowledged student item and never exposes class aggregates", async () => {
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url.startsWith("/api/v1/attendance-notifications/today")) {
        return Promise.resolve(
          jsonResponse(
            studentToday({
              ...studentItem,
              acknowledged_at: "2026-07-18T01:10:00.000Z",
              status: "acknowledged",
            }),
            200,
            { ETag: '"4"' },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    expect(await screen.findByText("선생님이 봤어요")).toBeVisible();
    expect(screen.getByText(/읽은 뒤에는 수정하거나 취소할 수 없습니다/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "유형·시각 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "연락 취소" })).not.toBeInTheDocument();
    expect(screen.queryByText("전체")).not.toBeInTheDocument();
  });

  it("preserves a student's draft when a date conflict cannot be refreshed", async () => {
    let todayCalls = 0;
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(studentBootstrap));
      if (url.startsWith("/api/v1/attendance-notifications/today")) {
        todayCalls += 1;
        return Promise.resolve(
          todayCalls === 1
            ? jsonResponse(studentToday())
            : errorResponse("HOME_UNAVAILABLE", "최신 화면을 불러오지 못했습니다.", 503),
        );
      }
      if (url === "/api/v1/attendance-notifications") {
        return Promise.resolve(
          errorResponse("ATTENDANCE_NOTIFICATION_DATE_CHANGED", "날짜가 바뀌었습니다."),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    await screen.findByText("오늘 보낸 출결 연락이 없어요.");
    fireEvent.click(screen.getByRole("radio", { name: "조퇴" }));
    fireEvent.change(screen.getByLabelText("조퇴 예정 시각"), { target: { value: "12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "연락 보내기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "요청은 반영되지 않았습니다. 최신 상태도 불러오지 못해 기존 입력과 화면을 그대로 두었어요.",
    );
    expect(screen.getByRole("radio", { name: "조퇴" })).toBeChecked();
    expect(screen.getByLabelText("조퇴 예정 시각")).toHaveValue("12:30");
    expect(screen.getByText("오늘 보낸 출결 연락이 없어요.")).toBeVisible();
  });

  it("shows six filter-independent teacher counts, independent filters, and membership badges without account state", async () => {
    const fetchMock = mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.endsWith("?status=all&type=all")) {
        return Promise.resolve(jsonResponse(teacherToday()));
      }
      if (url.endsWith("?status=all&type=late")) {
        return Promise.resolve(jsonResponse(teacherToday([], null)));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    const studentName = await screen.findByText("김학생");
    const teacherHeading = screen.getByRole("heading", { level: 1, name: "출결 연락" });
    expect(teacherHeading).toBeVisible();
    expect(teacherHeading.closest("header")).toHaveAttribute(
      "data-attendance-header-role",
      "teacher",
    );
    expect(teacherHeading.closest("header")).toHaveClass("content-frame-header");
    expect(studentName).toBeVisible();
    expect(document.querySelector('[data-attendance-surface="teacher-summary"] dl')).toHaveClass(
      "grid",
      "grid-cols-3",
      "md:flex",
      "md:overflow-x-auto",
    );
    expect(screen.getByRole("region", { name: "학생별 접수 현황" })).toBeVisible();
    const teacherItem = studentName.closest<HTMLElement>(
      '[data-attendance-surface="teacher-item"]',
    );
    if (teacherItem === null) throw new Error("교사 출결 연락 카드를 찾지 못했습니다.");
    expect(teacherItem).toHaveClass("content-card", "p-3", "sm:p-5");
    const nameHeading = within(teacherItem).getByRole("heading", { name: "김학생" });
    expect(nameHeading.parentElement).toHaveClass("flex", "items-baseline", "sm:block");
    expect(within(nameHeading.parentElement!).getByText("7번")).toBeVisible();
    expect(within(teacherItem).getByRole("button", { name: "읽음으로 확인" })).toHaveClass(
      "min-h-11",
    );
    const timeLine = within(teacherItem).getByText(/지각 ·/).parentElement;
    expect(timeLine).toHaveClass("sm:bg-app-surface-muted", "sm:rounded-2xl", "sm:px-4", "sm:py-3");
    expect(timeLine).not.toHaveClass("bg-app-surface-muted", "rounded-2xl", "px-4", "py-3");
    expect(within(teacherItem).getByText("확인 대기")).toHaveClass(
      "bg-app-danger/10",
      "text-app-danger",
    );
    const countList = screen.getByText("전체", { selector: "dt" }).closest("dl");
    expect(countList).not.toBeNull();
    for (const label of ["전체", "지각", "결석", "조퇴", "확인 대기", "확인 완료"]) {
      expect(within(countList!).getByText(label, { selector: "dt" })).toBeVisible();
    }
    expect(within(countList!).getByText("4", { selector: "dd" })).toBeVisible();
    expect(screen.queryByText("비활성 계정")).not.toBeInTheDocument();
    expect(screen.queryByText("삭제된 계정")).not.toBeInTheDocument();
    expect(screen.getByText("반에서 제외")).toBeVisible();
    expect(screen.getByText("김학생")).toHaveClass("break-words");

    const typeFilters = screen.getByRole("group", { name: "출결 연락 종류" });
    fireEvent.click(within(typeFilters).getByRole("button", { name: "지각" }));
    expect(await screen.findByText("선택한 조건의 출결 연락이 없어요.")).toBeVisible();
    expect(document.querySelector('[data-attendance-surface="teacher-empty"]')).toHaveClass(
      "border-role-border",
      "bg-role-soft",
    );
    const refreshedTypeFilters = screen.getByRole("group", { name: "출결 연락 종류" });
    expect(within(refreshedTypeFilters).getByRole("button", { name: "지각" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(refreshedTypeFilters).getByRole("button", { name: "전체 종류" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          requestUrl(input) === "/api/v1/attendance-notifications/today?status=all&type=late",
      ),
    ).toBe(true);
  });

  it("preserves long student names and distinct pending or acknowledged meaning in compact cards", async () => {
    const name = "아주긴학생이름가나다라마바사아자차카타파하";
    mockFeatureFetch().mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(
          requestUrl(input) === "/api/v1/bootstrap"
            ? teacherBootstrap
            : teacherToday([
                { ...teacherItem, display_name: name, student_number: null },
                {
                  ...teacherItem,
                  id: "18",
                  display_name: "확인한학생",
                  status: "acknowledged",
                  acknowledged_at: "2026-07-18T01:10:00.000Z",
                  membership_state: "approved",
                },
              ]),
        ),
      ),
    );
    renderAttendance();
    const heading = await screen.findByRole("heading", { name });
    expect(heading).toHaveClass("min-w-0", "break-words");
    const card = heading.closest<HTMLElement>("article")!;
    expect(card).toHaveAccessibleName(name + " 출결 연락");
    expect(within(card).getByText("번호 없음")).toBeVisible();
    expect(within(card).getByText("반에서 제외")).toBeVisible();
    expect(within(card).getByText("확인 대기")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "읽음으로 확인" }));
    const dialog = screen.getByRole("dialog", { name: name + " 학생 연락을 확인할까요?" });
    expect(dialog).toHaveTextContent("공식 출결을 확정하는 것이 아니라");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(within(card).getByRole("button", { name: "읽음으로 확인" })).toHaveFocus();
    const acknowledged = screen
      .getByRole("heading", { name: "확인한학생" })
      .closest<HTMLElement>("article")!;
    expect(within(acknowledged).getByText("확인 완료")).toBeVisible();
    expect(
      within(acknowledged).queryByRole("button", { name: "읽음으로 확인" }),
    ).not.toBeInTheDocument();
  });

  it("appends a cursor page, stores it in the URL, and restores the prior page on Back", async () => {
    const secondItem = {
      ...teacherItem,
      account_state: "active",
      display_name: "이학생",
      id: "18",
      member_id: "32",
      membership_state: "approved",
      student_number: 8,
    };
    let listCalls = 0;
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.endsWith("?status=all&type=all")) {
        listCalls += 1;
        return Promise.resolve(jsonResponse(teacherToday([teacherItem], "next cursor")));
      }
      if (url.endsWith("?status=all&type=all&cursor=next+cursor")) {
        listCalls += 1;
        return Promise.resolve(jsonResponse(teacherToday([secondItem], null)));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance("/attendance", true);
    expect(await screen.findByText("김학생")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "다음 20명 더 보기" }));
    expect(await screen.findByText("이학생")).toBeVisible();
    expect(screen.getByText("김학생")).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("cursor=next+cursor");

    fireEvent.click(screen.getByRole("button", { name: "테스트 뒤로" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/attendance"));
    expect(screen.getByText("김학생")).toBeVisible();
    expect(screen.queryByText("이학생")).not.toBeInTheDocument();
    expect(listCalls).toBe(2);
  });

  it("does not restore an acknowledged first-page item when a cumulative pending page refreshes", async () => {
    const secondItem = {
      ...teacherItem,
      account_state: "active",
      display_name: "이학생",
      id: "18",
      member_id: "32",
      membership_state: "approved",
      student_number: 8,
    };
    let secondPageCalls = 0;
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.endsWith("?status=pending&type=all")) {
        return Promise.resolve(jsonResponse(teacherToday([teacherItem], "next cursor")));
      }
      if (url.endsWith("?status=pending&type=all&cursor=next+cursor")) {
        secondPageCalls += 1;
        return Promise.resolve(jsonResponse(teacherToday([secondItem], null)));
      }
      if (url === "/api/v1/attendance-notifications/17/acknowledge") {
        return Promise.resolve(
          jsonResponse(
            {
              ...studentItem,
              acknowledged_at: "2026-07-18T01:10:00.000Z",
              row_version: "5",
              status: "acknowledged",
            },
            200,
            { ETag: '"5"' },
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance("/attendance?status=pending");
    expect(await screen.findByText("김학생")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "다음 20명 더 보기" }));
    expect(await screen.findByText("이학생")).toBeVisible();

    const firstItemCard = screen.getByRole("article", { name: "김학생 출결 연락" });
    fireEvent.click(within(firstItemCard).getByRole("button", { name: "읽음으로 확인" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "읽음으로 확인" }),
    );
    expect(await screen.findByText("김학생 학생의 연락을 읽음으로 확인했어요.")).toBeVisible();
    expect(screen.queryByText("김학생")).not.toBeInTheDocument();
    expect(screen.getByText("이학생")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => {
      expect(secondPageCalls).toBe(2);
      expect(screen.queryByText("김학생")).not.toBeInTheDocument();
      expect(screen.getByText("이학생")).toBeVisible();
    });
  });

  it("keeps teacher acknowledgement over a late refresh and guards repeated confirmation", async () => {
    const lateRefresh = deferred<Response>();
    const acknowledgePending = deferred<Response>();
    let listCalls = 0;
    let acknowledgeCalls = 0;
    let acknowledged = false;
    const fetchMock = mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.endsWith("?status=pending&type=all")) {
        listCalls += 1;
        if (acknowledged) return Promise.resolve(jsonResponse(teacherToday([], null)));
        // The page and its shared navigation badge each read the initial count.
        return listCalls <= 2
          ? Promise.resolve(jsonResponse(teacherToday([teacherItem], null)))
          : lateRefresh.promise;
      }
      if (url === "/api/v1/attendance-notifications/17/acknowledge") {
        acknowledgeCalls += 1;
        return acknowledgePending.promise.then((response) => {
          acknowledged = true;
          return response;
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance("/attendance?status=pending");
    expect(await screen.findByText("김학생")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(listCalls).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: "읽음으로 확인" }));
    const dialog = screen.getByRole("dialog", { name: "김학생 학생 연락을 확인할까요?" });
    expect(dialog).toHaveTextContent("공식 출결을 확정하는 것이 아니라");
    expect(dialog).toHaveTextContent("되돌릴 수 없습니다");
    const confirmAcknowledge = within(dialog).getByRole("button", { name: "읽음으로 확인" });
    act(() => {
      confirmAcknowledge.click();
      confirmAcknowledge.click();
    });
    expect(acknowledgeCalls).toBe(1);
    expect(screen.getByRole("heading", { name: "학생별 접수 현황" })).toHaveFocus();
    acknowledgePending.resolve(
      jsonResponse(
        {
          ...studentItem,
          acknowledged_at: "2026-07-18T01:10:00.000Z",
          row_version: "5",
          status: "acknowledged",
        },
        200,
        { ETag: '"5"' },
      ),
    );

    expect(await screen.findByText("김학생 학생의 연락을 읽음으로 확인했어요.")).toBeVisible();
    expect(screen.getByText("확인 대기인 출결 연락이 없어요.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "학생별 접수 현황" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await act(async () => {
      lateRefresh.resolve(jsonResponse(teacherToday([teacherItem], null)));
    });
    expect(screen.getByText("확인 대기인 출결 연락이 없어요.")).toBeVisible();
    expect(screen.queryByText("김학생")).not.toBeInTheDocument();
    const acknowledgeCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === "/api/v1/attendance-notifications/17/acknowledge",
    );
    expect(new Headers(acknowledgeCall?.[1]?.headers).get("If-Match")).toBe('"4"');
    expect(new Headers(acknowledgeCall?.[1]?.headers).get("X-Server-Today")).toBe("2026-07-18");
  });

  it("keeps teacher data when refresh fails and offers a retry", async () => {
    let listCalls = 0;
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.endsWith("?status=all&type=all")) {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? jsonResponse(teacherToday())
            : errorResponse("ATTENDANCE_QUERY_FAILED", "출결 조회가 지연되고 있습니다.", 503),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderAttendance();
    expect(await screen.findByText("김학생")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("기존 목록은 그대로 두었습니다.");
    expect(alert).toHaveClass("border-danger", "bg-danger-surface", "text-danger");
    expect(screen.getByText("김학생")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toHaveClass("min-h-11");
  });
});

describe("교사 빈 목록 문구", () => {
  it("하루 전체 0건은 실제 접수 없음으로 안내한다", async () => {
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.startsWith("/api/v1/attendance-notifications/today")) {
        return Promise.resolve(
          jsonResponse(
            teacherToday([], null, {
              absent: 0,
              acknowledged: 0,
              early: 0,
              late: 0,
              pending: 0,
              total: 0,
            }),
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    renderAttendance();
    expect(await screen.findByText("오늘 접수된 출결 연락이 없어요.")).toBeVisible();
    expect(screen.getByText("학생이 연락을 보내면 여기에 보여요.")).toBeVisible();
  });
  it("전체 접수가 있어도 필터 결과만 0건이면 접수 없음으로 단정하지 않는다", async () => {
    mockFeatureFetch().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url.startsWith("/api/v1/attendance-notifications/today"))
        return Promise.resolve(jsonResponse(teacherToday([], null)));
      throw new Error(`Unexpected URL: ${url}`);
    });
    renderAttendance("/attendance?type=absent&status=acknowledged");
    expect(await screen.findByText("선택한 조건의 출결 연락이 없어요.")).toBeVisible();
    expect(screen.queryByText("오늘 접수된 출결 연락이 없어요.")).not.toBeInTheDocument();
    expect(screen.getByText("종류나 확인 상태를 바꾸면 다른 연락을 볼 수 있어요.")).toBeVisible();
  });
});

it("공개 점검 상태 fixture는 일회성 화면 API 응답을 소비하지 않는다", async () => {
  const featureFetch = mockFeatureFetch().mockResolvedValueOnce(jsonResponse(teacherBootstrap));
  expect(await (await fetch("/api/v1/public/system-state")).json()).toEqual({
    maintenance: false,
    announcement: null,
  });
  expect(featureFetch).not.toHaveBeenCalled();
  expect(await (await fetch("/api/v1/bootstrap")).json()).toEqual(teacherBootstrap);
  expect(featureFetch).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});

it("교사 폰 집계는 전체6항목과 큰 숫자 원문을 보존하고 768px부터기존한줄로복구한다", async () => {
  const largeCounts = {
    absent: 10,
    acknowledged: 10000,
    early: 20,
    late: 30,
    pending: 999,
    total: Number.MAX_SAFE_INTEGER,
  };
  mockFeatureFetch().mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
    if (url.startsWith("/api/v1/attendance-notifications/today"))
      return Promise.resolve(jsonResponse(teacherToday([], null, largeCounts)));
    throw new Error(`Unexpected URL: ${url}`);
  });
  renderAttendance();
  await screen.findByText("선택한 조건의 출결 연락이 없어요.");
  const summary = document.querySelector(
    '[data-attendance-surface="teacher-summary"]',
  ) as HTMLElement;
  const list = summary.querySelector("dl")!;
  expect(list).toHaveClass(
    "grid-cols-3",
    "max-md:order-3",
    "max-md:col-span-2",
    "md:flex",
    "md:overflow-x-auto",
  );
  const cells = Array.from(list.children);
  expect(cells.map((cell) => cell.querySelector("dt")!.textContent)).toEqual([
    "전체",
    "지각",
    "결석",
    "조퇴",
    "확인 대기",
    "확인 완료",
  ]);
  expect(cells.map((cell) => cell.querySelector("dd")!.textContent)).toEqual([
    String(Number.MAX_SAFE_INTEGER),
    "30",
    "10",
    "20",
    "999",
    "10000",
  ]);
  for (const cell of cells) {
    expect(cell).toHaveClass("flex", "flex-wrap", "gap-x-1", "md:flex-nowrap");
    expect(cell.querySelector("dd")).toHaveClass(
      "break-all",
      "leading-5",
      "[overflow-wrap:anywhere]",
      "md:leading-normal",
      "md:[overflow-wrap:normal]",
    );
  }
  expect(within(summary).getByRole("button", { name: "새로고침" })).toBeEnabled();
  expect(within(summary).getByRole("button", { name: "새로고침" })).toHaveClass("max-md:min-h-11");
});
