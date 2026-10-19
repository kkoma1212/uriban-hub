import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
import type { StudentAssessmentItem } from "../../api/student-assessments";
import { StudentAssessmentsPage } from "./student-assessments-page";

const deferredEditor = vi.hoisted(() => ({
  loads: 0,
  resolved: 0,
  paused: false,
  release: undefined as (() => void) | undefined,
}));
vi.mock("./student-assessment-editor", async (importOriginal) => {
  deferredEditor.loads += 1;
  if (deferredEditor.paused)
    await new Promise<void>((resolve) => {
      deferredEditor.release = resolve;
    });
  const module = await importOriginal();
  deferredEditor.resolved += 1;
  return module;
});

const studentBootstrap = {
  account: { display_name: "김학생", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "MANAGE_OWN_ASSESSMENTS", "LOGOUT"],
  current_class: {
    id: "1",
    name: "테스트 1반",
    school_address: null,
    school_homepage_url: null,
    school_name: "테스트 고등학교",
    school_phone_number: null,
    status: "active",
  },
  current_membership: {
    class_id: "1",
    display_name_in_class: "김학생",
    id: "2",
    role: "student",
    status: "approved",
    student_number: 7,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-08-01",
  teacher_profile: null,
} satisfies BootstrapResponse;

function assessmentItem(overrides: Partial<StudentAssessmentItem>): StudentAssessmentItem {
  return {
    academic_year: 2026,
    assessment_date: "2026-07-20",
    assessment_type: "performance",
    created_at: "2026-07-20T03:00:00.000Z",
    expires_at: "2027-03-01T00:00:00.000Z",
    id: "31",
    max_score_hundredths: 10_000,
    memo: null,
    recorded_at: null,
    row_version: "1",
    score_hundredths: 9_150,
    semester: 1,
    status: "draft",
    subject: "수학",
    title: "1학기 수행",
    updated_at: "2026-07-20T03:00:00.000Z",
    weight_basis_points: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function mockRoutes(options: {
  bootstrap?: unknown;
  bootstrapStatus?: number;
  csv?: string;
  items?: StudentAssessmentItem[];
  listStatus?: number;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(options.bootstrap ?? studentBootstrap, options.bootstrapStatus ?? 200),
      );
    }
    if (url === "/api/v1/my-assessments") {
      if (options.listStatus !== undefined) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "SERVICE_UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." } },
            options.listStatus,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({ items: options.items ?? [], server_today: "2026-08-01" }),
      );
    }
    if (url === "/api/v1/my-assessments/export.csv") {
      return Promise.resolve(new Response(options.csv ?? "id,title", { status: 200 }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function renderPage(initialEntry = "/assessments"): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<StudentAssessmentsPage />} path="/assessments" />
        <Route element={<p>학생 홈 화면</p>} path="/home" />
        <Route element={<p>로그인 화면</p>} path="/login" />
        <Route element={<p>계정 안내 화면</p>} path="/bootstrap" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("StudentAssessmentsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the editor unloaded on the list and cancels opening while its chunk is pending", async () => {
    const fetchMock = mockRoutes({ items: [assessmentItem({ id: "41", title: "작성 중 수행" })] });
    renderPage();
    await screen.findByRole("button", { name: "계속 작성" });
    expect(deferredEditor.loads).toBe(0);
    deferredEditor.paused = true;
    try {
      fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
      expect(await screen.findByText("평가 편집 화면을 준비하고 있어요.")).toBeVisible();
      expect(screen.getByRole("region", { name: "평가 편집 화면" })).toHaveAttribute(
        "aria-busy",
        "true",
      );
      expect(screen.getByRole("heading", { name: "작성 중 수행" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "목록으로 돌아가기" }));
      await waitFor(() =>
        expect(document.querySelector("[data-assessment-layout]")).toHaveAttribute(
          "data-assessment-layout",
          "list",
        ),
      );
    } finally {
      deferredEditor.paused = false;
      deferredEditor.release?.();
    }
    await waitFor(() => expect(deferredEditor.resolved).toBe(1));
    expect(
      screen.queryByRole("heading", { name: "내 점수를 차근차근 기록해요" }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(([input, init]: [RequestInfo | URL, RequestInit?]) => {
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        return (
          method.toUpperCase() === "GET" &&
          ["/api/v1/bootstrap", "/api/v1/my-assessments"].includes(requestUrl(input))
        );
      }),
    ).toBe(true);
  });

  it("uses a compact card date while preserving the full accessible date and score", async () => {
    mockRoutes({
      items: [assessmentItem({ assessment_date: "2026-10-11", score_hundredths: 9_200 })],
    });
    renderPage();
    const date = await screen.findByText("2026.10.11");
    expect(date.tagName).toBe("TIME");
    expect(date).toHaveAttribute("datetime", "2026-10-11");
    expect(date).toHaveAccessibleName("2026년 10월 11일");
    expect(screen.getByText("92 / 100점")).toBeVisible();
  });

  it("lists drafts before recorded items with KST dates and exact scores", async () => {
    mockRoutes({
      items: [
        assessmentItem({
          id: "40",
          recorded_at: "2026-07-22T03:00:00.000Z",
          status: "recorded",
          title: "기록된 지필",
          updated_at: "2026-07-22T03:00:00.000Z",
        }),
        assessmentItem({ id: "41", title: "작성 중 수행" }),
      ],
    });
    renderPage();

    await screen.findByRole("button", { name: "평가 기록 추가" });
    expect(screen.getByRole("heading", { level: 1, name: "평가 기록" })).toBeVisible();
    const cards = document.querySelectorAll("[data-assessment-card]");
    expect(cards).toHaveLength(2);
    // 초안이 기록 완료보다 먼저 온다.
    expect(cards[0]).toHaveAttribute("data-assessment-card", "draft");
    const draftCard = within(cards[0] as HTMLElement);
    expect(draftCard.getByText("작성 중 수행")).toBeVisible();
    expect(draftCard.getByText("2026.07.20")).toBeVisible();
    expect(draftCard.getByLabelText("2026년 7월 20일")).toHaveAttribute("datetime", "2026-07-20");
    expect(draftCard.getByText("91.5 / 100점")).toBeVisible();

    fireEvent.click(draftCard.getByRole("button", { name: "계속 작성" }));
    const editorHeading = await screen.findByRole("heading", {
      name: "내 점수를 차근차근 기록해요",
    });
    expect(editorHeading).toBeVisible();
    expect(editorHeading).toHaveFocus();
    const layout = document.querySelector('[data-assessment-layout="split"]');
    const list = document.querySelector("[data-assessment-list]");
    const editor = document.querySelector("[data-assessment-editor]");
    expect(layout).toHaveClass("grid", "lg:grid-cols-[minmax(0,1.28fr)_minmax(18rem,0.72fr)]");
    expect(editor?.compareDocumentPosition(list!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("sends non-students to home instead of loading private records", async () => {
    const fetchMock = mockRoutes({
      bootstrap: {
        ...studentBootstrap,
        current_membership: { ...studentBootstrap.current_membership, role: "teacher" },
      },
    });
    renderPage();

    expect(await screen.findByText("학생 홈 화면")).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([input]: [RequestInfo | URL, RequestInit?]) =>
        requestUrl(input).includes("my-assessments"),
      ),
    ).toBe(false);
  });

  it("keeps the student menu when the first list request fails", async () => {
    // 검수 F-02: 목록 첫 조회가 503이면 오류 화면에서 홈·다른 화면 이동 메뉴가 사라졌다.
    mockRoutes({ listStatus: 503 });
    renderPage();

    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("잠시 후 다시 시도해 주세요.");
    expect(screen.getAllByRole("link", { name: /소식/u }).length).toBeGreaterThan(0);
  });

  it("redirects to login when the session is gone", async () => {
    mockRoutes({
      bootstrap: { error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } },
      bootstrapStatus: 401,
    });
    renderPage();

    expect(await screen.findByText("로그인 화면")).toBeVisible();
  });

  it("downloads the CSV through an attached anchor and defers the URL revoke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const objectUrl = "blob:classhub/assessments-csv";
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // 다운로드 시작 시점에 anchor가 문서에 붙어 있어야 하는 브라우저가 있다.
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("나의-평가.csv");
      expect(this.href).toContain(objectUrl);
    });
    mockRoutes({
      csv: "id,title\n31,수행",
      items: [
        assessmentItem({
          recorded_at: "2026-07-22T03:00:00.000Z",
          status: "recorded",
        }),
      ],
    });
    renderPage();

    const exportButton = await screen.findByRole("button", { name: /완료 기록 CSV/u });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // 같은 tick에 revoke하면 비동기로 시작되는 다운로드가 취소될 수 있다.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
    vi.useRealTimers();
  });

  it("opens a deep-linked editor after lazy loading and returns to the unchanged list", async () => {
    mockRoutes({ items: [assessmentItem({ id: "41", title: "작성 중 수행" })] });
    renderPage("/assessments?edit=41");
    const heading = await screen.findByRole("heading", { name: "내 점수를 차근차근 기록해요" });
    expect(heading).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "닫기 · 초안 유지" }));
    await waitFor(() =>
      expect(document.querySelector("[data-assessment-layout]")).toHaveAttribute(
        "data-assessment-layout",
        "list",
      ),
    );
    expect(screen.getByRole("heading", { name: "작성 중 수행" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "내 점수를 차근차근 기록해요" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
    expect(
      await screen.findByRole("heading", { name: "내 점수를 차근차근 기록해요" }),
    ).toHaveFocus();
  });
});

import { act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import * as assessmentApi from "../../api/student-assessments";

describe("assessment page navigation saves before replacing editors", () => {
  afterEach(() => vi.restoreAllMocks());
  it("saves the old card first, then opens the requested record without stale callbacks", async () => {
    const old = assessmentItem({ id: "31", title: "첫 번째 평가" });
    const other = assessmentItem({ id: "32", title: "두 번째 평가" });
    mockRoutes({ items: [old, other] });
    let finish!: (value: assessmentApi.StudentAssessmentEntityResponse) => void;
    const update = vi.spyOn(assessmentApi, "updateStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const router = createMemoryRouter(
      [{ path: "/assessments", element: <StudentAssessmentsPage /> }],
      { initialEntries: ["/assessments?edit=31"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("평가명");
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "새로 입력한 첫 평가" } });
    const card = screen.getByRole("heading", { name: "두 번째 평가" }).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "계속 작성" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(router.state.location.search).toBe("?edit=31");
    expect(screen.getByLabelText("평가명")).toHaveValue("새로 입력한 첫 평가");
    await act(async () =>
      finish({ etag: '"2"', item: { ...old, title: "새로 입력한 첫 평가", row_version: "2" } }),
    );
    await waitFor(() => expect(screen.getByLabelText("평가명")).toHaveValue("두 번째 평가"));
    expect(router.state.location.search).toBe("?edit=32");
    expect(screen.getByRole("heading", { name: "새로 입력한 첫 평가" })).toBeInTheDocument();
    expect(update).toHaveBeenCalledOnce();
  });
  it("starts a fresh editor after the first newly-created record is saved", async () => {
    mockRoutes({ items: [] });
    vi.spyOn(assessmentApi, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    vi.spyOn(assessmentApi, "createStudentAssessment").mockResolvedValue({
      etag: '"1"',
      item: assessmentItem({ title: "첫 새 기록" }),
    });
    const router = createMemoryRouter(
      [{ path: "/assessments", element: <StudentAssessmentsPage /> }],
      { initialEntries: ["/assessments?new=1"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "첫 새 기록" } });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(router.state.location.search).toBe("?edit=31"));
    fireEvent.click(screen.getByRole("button", { name: "평가 기록 추가" }));
    await waitFor(() => expect(screen.getByLabelText("평가명")).toHaveValue(""));
    expect(router.state.location.search).toBe("?new=1");
    expect(screen.getByLabelText("기록 보관 방식")).toBeEnabled();
  });
  it("lets a CSV 401 redirect leave a dirty recorded editor without trying to save", async () => {
    mockRoutes({ items: [assessmentItem({ status: "recorded" })] });
    const update = vi.spyOn(assessmentApi, "updateStudentAssessment");
    vi.spyOn(assessmentApi, "exportStudentAssessmentsCsv").mockRejectedValue(
      new ApiRequestError("UNAUTHENTICATED", "세션 종료", 401),
    );
    const router = createMemoryRouter(
      [
        { path: "/assessments", element: <StudentAssessmentsPage /> },
        { path: "/login", element: <p>평가 세션 종료 도착</p> },
      ],
      { initialEntries: ["/assessments?edit=31"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("평가명");
    fireEvent.change(screen.getByLabelText("메모 (선택)"), { target: { value: "아직 저장 전" } });
    fireEvent.click(screen.getByRole("button", { name: "완료 기록 CSV" }));
    await screen.findByText("평가 세션 종료 도착");
    expect(router.state.location.pathname).toBe("/login");
    expect(update).not.toHaveBeenCalled();
  });
  it("does not return to assessments after close-save resolves later than a CSV 401", async () => {
    const old = assessmentItem({ status: "recorded" });
    mockRoutes({ items: [old] });
    let finish!: (value: assessmentApi.StudentAssessmentEntityResponse) => void;
    const update = vi.spyOn(assessmentApi, "updateStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.spyOn(assessmentApi, "exportStudentAssessmentsCsv").mockRejectedValue(
      new ApiRequestError("UNAUTHENTICATED", "세션 종료", 401),
    );
    const router = createMemoryRouter(
      [
        { path: "/assessments", element: <StudentAssessmentsPage /> },
        { path: "/login", element: <p>닫기 세션 종료 도착</p> },
      ],
      { initialEntries: ["/assessments?edit=31"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("평가명");
    fireEvent.change(screen.getByLabelText("메모 (선택)"), {
      target: { value: "늦게 저장될 메모" },
    });
    fireEvent.click(screen.getByRole("button", { name: "닫기 · 기록 유지" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "완료 기록 CSV" }));
    await screen.findByText("닫기 세션 종료 도착");
    await act(async () =>
      finish({ etag: '"2"', item: { ...old, memo: "늦게 저장될 메모", row_version: "2" } }),
    );
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByText("닫기 세션 종료 도착")).toBeInTheDocument();
    expect(screen.queryByLabelText("평가명")).not.toBeInTheDocument();
  });
  it("does not return to assessments after DELETE resolves later than a CSV 401", async () => {
    mockRoutes({ items: [assessmentItem({ status: "recorded" })] });
    let finish!: () => void;
    const remove = vi.spyOn(assessmentApi, "deleteStudentAssessment").mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    vi.spyOn(assessmentApi, "exportStudentAssessmentsCsv").mockRejectedValue(
      new ApiRequestError("UNAUTHENTICATED", "세션 종료", 401),
    );
    const router = createMemoryRouter(
      [
        { path: "/assessments", element: <StudentAssessmentsPage /> },
        { path: "/login", element: <p>삭제 세션 종료 도착</p> },
      ],
      { initialEntries: ["/assessments?edit=31"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByLabelText("평가명");
    fireEvent.click(screen.getByRole("button", { name: "기록 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: "평가 기록 삭제" }));
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "완료 기록 CSV" }));
    await screen.findByText("삭제 세션 종료 도착");
    await act(async () => finish());
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByText("삭제 세션 종료 도착")).toBeInTheDocument();
    expect(screen.queryByLabelText("평가명")).not.toBeInTheDocument();
  });
});
import { ApiRequestError } from "../../api/auth";

describe("assessment first-create and CSV session-expiry race", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps the login destination when first create resolves in the same batch after a CSV 401", async () => {
    mockRoutes({ items: [assessmentItem({ id: "32", status: "recorded" })] });
    vi.spyOn(assessmentApi, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    let finish!: (value: assessmentApi.StudentAssessmentEntityResponse) => void;
    const create = vi.spyOn(assessmentApi, "createStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let rejectCsv!: (error: unknown) => void;
    const csv = vi.spyOn(assessmentApi, "exportStudentAssessmentsCsv").mockReturnValue(
      new Promise((_resolve, fail) => {
        rejectCsv = fail;
      }),
    );
    const router = createMemoryRouter(
      [
        { path: "/assessments", element: <StudentAssessmentsPage /> },
        { path: "/login", element: <p>첫 저장 경합 세션 종료 도착</p> },
      ],
      { initialEntries: ["/assessments?new=1"] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "지연된 첫 기록" } });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "완료 기록 CSV" }));
    expect(csv).toHaveBeenCalledOnce();
    await act(async () => {
      rejectCsv(new ApiRequestError("UNAUTHENTICATED", "세션 종료", 401));
      await Promise.resolve();
      finish({
        etag: '\"1\"',
        item: assessmentItem({
          title: "지연된 첫 기록",
          connection_scope: "personal",
          class_id: null,
          class_name: null,
        }),
      });
      await Promise.resolve();
    });
    await screen.findByText("첫 저장 경합 세션 종료 도착");
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.queryByLabelText("평가명")).not.toBeInTheDocument();
  });
});

describe("assessment writing has priority over the record list", () => {
  afterEach(() => vi.restoreAllMocks());
  it("places a new editor before the empty list without removing record-list or add access", async () => {
    mockRoutes({ items: [] });
    vi.spyOn(assessmentApi, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    renderPage("/assessments?new=1");
    const title = await screen.findByRole("heading", { name: "내 점수를 차근차근 기록해요" });
    const editor = title.closest("[data-assessment-editor]")!;
    const list = screen.getByRole("region", { name: "내 평가 기록 목록" });
    expect(editor.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list).toContainElement(screen.getByText("아직 기록한 평가가 없어요."));
    expect(screen.getByRole("button", { name: "평가 기록 추가" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "완료 기록 CSV" })).toBeDisabled();
    expect(editor.querySelector("[tabindex='-1']")).toHaveFocus();
  });
  it("preserves complete list access next to an existing editor", async () => {
    mockRoutes({
      items: [
        assessmentItem({ id: "31" }),
        assessmentItem({ id: "32", title: "다른 완료 평가", status: "recorded" }),
      ],
    });
    renderPage("/assessments?edit=31");
    const title = await screen.findByRole("heading", { name: "내 점수를 차근차근 기록해요" });
    const editor = title.closest("[data-assessment-editor]")!;
    const list = screen.getByRole("region", { name: "내 평가 기록 목록" });
    expect(editor.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(list).getByRole("heading", { name: "다른 완료 평가" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "확인·수정" })).toBeEnabled();
    expect(within(list).getByRole("button", { name: "완료 기록 CSV" })).toBeEnabled();
  });
});

describe("assessment first-save URL transition", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["personal", "current_class"] as const)(
    "preserves the saved %s editor while its first edit URL is pending and updates the same record",
    async (scope) => {
      mockRoutes({ items: [] });
      vi.spyOn(assessmentApi, "getStudentAssessmentCreationContext").mockResolvedValue({
        class_connection_available: true,
        current_class: { id: "1", name: "테스트 1반" },
      });
      const create = vi
        .spyOn(assessmentApi, "createStudentAssessment")
        .mockImplementation(async (request) => ({
          etag: '\"1\"',
          item: assessmentItem({
            ...request,
            id: "31",
            connection_scope: scope,
            class_id: scope === "current_class" ? "1" : null,
            class_name: scope === "current_class" ? "테스트 1반" : null,
          }),
        }));
      const update = vi
        .spyOn(assessmentApi, "updateStudentAssessment")
        .mockImplementation(async (_id, request) => ({
          etag: '\"2\"',
          item: assessmentItem({
            ...request,
            id: "31",
            row_version: "2",
            connection_scope: scope,
            class_id: scope === "current_class" ? "1" : null,
            class_name: scope === "current_class" ? "테스트 1반" : null,
          }),
        }));
      let releaseEdit!: () => void;
      const editGate = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const editStarted = vi.fn();
      const router = createMemoryRouter(
        [
          {
            path: "/assessments",
            loader: async ({ request }) => {
              if (new URL(request.url).searchParams.get("edit") === "31") {
                editStarted();
                await editGate;
              }
              return null;
            },
            hydrateFallbackElement: <p>첫 저장 검수 준비</p>,
            element: <StudentAssessmentsPage />,
          },
        ],
        { initialEntries: ["/assessments?new=1"] },
      );
      render(<RouterProvider router={router} />);
      await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
      fireEvent.change(screen.getByLabelText("기록 보관 방식"), { target: { value: scope } });
      fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "첫 저장 유지 검수" } });
      fireEvent.change(screen.getByLabelText("과목"), { target: { value: "수학" } });
      fireEvent.change(screen.getByLabelText("받은 점수"), { target: { value: "92.5" } });
      fireEvent.change(screen.getByLabelText("만점"), { target: { value: "100" } });
      fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
      await waitFor(() => expect(editStarted).toHaveBeenCalledOnce());
      await screen.findByRole("heading", { name: "첫 저장 유지 검수" });
      expect(router.state.location.search).toBe("?new=1");
      expect(screen.getByLabelText("평가명")).toHaveValue("첫 저장 유지 검수");
      expect(screen.getByLabelText("과목")).toHaveValue("수학");
      expect(screen.getByLabelText("받은 점수")).toHaveValue("92.5");
      expect(screen.getByLabelText("만점")).toHaveValue("100");
      expect(screen.queryByLabelText("기록 보관 방식")).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "내 점수를 차근차근 기록해요" })).toHaveAttribute(
        "data-assessment-editor",
        "draft",
      );
      await act(async () => releaseEdit());
      await waitFor(() => expect(router.state.location.search).toBe("?edit=31"));
      expect(screen.getByLabelText("평가명")).toHaveValue("첫 저장 유지 검수");
      expect(screen.getByLabelText("받은 점수")).toHaveValue("92.5");
      fireEvent.change(screen.getByLabelText("메모 (선택)"), {
        target: { value: "같은 기록에 추가한 메모" },
      });
      fireEvent.click(screen.getByRole("button", { name: "닫기 · 초안 유지" }));
      await waitFor(() => expect(router.state.location.search).toBe(""));
      expect(create).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0]?.[0]).toBe("31");
      expect(update.mock.calls[0]?.[1]).toMatchObject({
        title: "첫 저장 유지 검수",
        subject: "수학",
        score_hundredths: 9250,
        max_score_hundredths: 10000,
        memo: "같은 기록에 추가한 메모",
      });
      fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
      await screen.findByLabelText("평가명");
      expect(screen.getByLabelText("평가명")).toHaveValue("첫 저장 유지 검수");
      expect(screen.getByLabelText("메모 (선택)")).toHaveValue("같은 기록에 추가한 메모");
      fireEvent.click(screen.getByRole("button", { name: "평가 기록 추가" }));
      await waitFor(() => expect(screen.getByLabelText("평가명")).toHaveValue(""));
      expect(screen.getByLabelText("기록 보관 방식")).toBeEnabled();
      expect(create).toHaveBeenCalledOnce();
    },
  );
});
