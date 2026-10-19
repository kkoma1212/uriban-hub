import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api/student-assessments";
import { ApiRequestError } from "../../api/auth";
import { StudentAssessmentEditor } from "./student-assessment-editor";

const item: api.StudentAssessmentItem = {
  academic_year: 2026,
  assessment_date: null,
  assessment_type: "performance",
  connection_scope: "current_class",
  class_id: "1",
  class_name: "현재 반",
  created_at: "2026-10-10T00:00:00Z",
  expires_at: "2026-10-30T00:00:00Z",
  id: "31",
  max_score_hundredths: null,
  memo: null,
  recorded_at: null,
  row_version: "1",
  score_hundredths: null,
  semester: 2,
  status: "draft",
  subject: null,
  title: "평가",
  updated_at: "2026-10-10T00:00:00Z",
  weight_basis_points: null,
};
function renderEditor(
  initialItem?: api.StudentAssessmentItem,
  onUnauthorized = vi.fn(),
  onClose = vi.fn(),
) {
  return render(
    <MemoryRouter>
      <StudentAssessmentEditor
        {...(initialItem ? { initialItem } : {})}
        onClose={onClose}
        onDeleted={vi.fn()}
        onRecord={vi.fn()}
        onUnauthorized={onUnauthorized}
        serverToday="2026-10-10"
      />
    </MemoryRouter>,
  );
}
describe("assessment creation connection choice", () => {
  afterEach(() => vi.restoreAllMocks());
  it("waits for context and an explicit storage confirmation before the first autosave", async () => {
    let finish!: (context: api.StudentAssessmentCreationContext) => void;
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const create = vi
      .spyOn(api, "createStudentAssessment")
      .mockResolvedValue({ etag: '\"1\"', item });
    renderEditor();
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "입력 보존" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(create).not.toHaveBeenCalled();
    await act(async () =>
      finish({ class_connection_available: true, current_class: { id: "1", name: "현재 반" } }),
    );
    expect(screen.getByLabelText("평가명")).toHaveValue("입력 보존");
    fireEvent.change(screen.getByLabelText("기록 보관 방식"), {
      target: { value: "current_class" },
    });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({ title: "입력 보존", expected_class_id: "1" });
  });

  it("preserves unconfirmed input on close and complete without saving or looping", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    const create = vi.spyOn(api, "createStudentAssessment");
    const complete = vi.spyOn(api, "completeStudentAssessment");
    renderEditor();
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "확정 전 입력" } });
    fireEvent.click(screen.getByRole("button", { name: "닫기 · 초안 유지" }));
    await screen.findByText("입력은 그대로 있어요. 보관 방식을 확인하고 저장 시작을 눌러 주세요.");
    expect(screen.getByLabelText("기록 보관 방식")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "저장 다시 시도" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기록 완료" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "기록 완료" })).toBeEnabled());
    expect(screen.getByLabelText("평가명")).toHaveValue("확정 전 입력");
    expect(create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("retries failed context without silently creating personal records", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue({
        class_connection_available: true,
        current_class: { id: "1", name: "현재 반" },
      });
    const create = vi
      .spyOn(api, "createStudentAssessment")
      .mockResolvedValue({ etag: '\"1\"', item });
    renderEditor();
    await screen.findByRole("button", { name: "보관 방식 다시 확인" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "재시도 입력" } });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "보관 방식 다시 확인" }));
    await screen.findByRole("option", { name: "현재 반에 연결 · 현재 반" });
    fireEvent.change(screen.getByLabelText("기록 보관 방식"), {
      target: { value: "current_class" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      title: "재시도 입력",
      expected_class_id: "1",
    });
  });

  it("keeps the first confirmed request and key across an uncertain create retry", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    const create = vi
      .spyOn(api, "createStudentAssessment")
      .mockRejectedValueOnce(new ApiRequestError("NETWORK_ERROR", "저장 결과 불명", 0))
      .mockResolvedValue({
        etag: '\"1\"',
        item: { ...item, connection_scope: "personal", class_id: null, class_name: null },
      });
    renderEditor();
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "원본 입력" } });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await screen.findByText("저장 결과 불명");
    expect(screen.getByLabelText("기록 보관 방식")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "저장 다시 시도" }));
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "새 입력" } });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });

  it("does not publish a late unauthorized context after the editor unmounts", async () => {
    let reject!: (error: unknown) => void;
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const ended = vi.fn();
    const view = renderEditor(undefined, ended);
    view.unmount();
    await act(async () => reject(new ApiRequestError("UNAUTHENTICATED", "로그인 필요", 401)));
    expect(ended).not.toHaveBeenCalled();
  });

  it("does not create on selection alone, sends scope only at first save, and locks later changes", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: true,
      current_class: { id: "1", name: "현재 반" },
    });
    const create = vi
      .spyOn(api, "createStudentAssessment")
      .mockResolvedValue({ etag: '"1"', item });
    const update = vi
      .spyOn(api, "updateStudentAssessment")
      .mockResolvedValue({ etag: '"2"', item: { ...item, row_version: "2" } });
    renderEditor();
    await screen.findByRole("option", { name: "현재 반에 연결 · 현재 반" });
    fireEvent.change(screen.getByLabelText("기록 보관 방식"), {
      target: { value: "current_class" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "평가" } });
    await waitFor(() => expect(create).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      connection_scope: "current_class",
      expected_class_id: "1",
      title: "평가",
    });
    await screen.findByText("반 연결 기록 · 현재 반 · 보관 방식은 바꿀 수 없어요.");
    expect(screen.queryByLabelText("기록 보관 방식")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("과목"), { target: { value: "수학" } });
    await waitFor(() => expect(update).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("connection_scope");
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("class_id");
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("expected_class_id");
  });
  it("keeps personal creation available when context is unavailable and omits the new field", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockRejectedValue(
      new Error("not installed"),
    );
    const create = vi.spyOn(api, "createStudentAssessment").mockResolvedValue({
      etag: '"1"',
      item: { ...item, connection_scope: "personal", class_id: null, class_name: null },
    });
    renderEditor();
    expect(screen.getByLabelText("기록 보관 방식")).toHaveValue("personal");
    expect(screen.queryByRole("option", { name: /현재 반에 연결/ })).not.toBeInTheDocument();
    await screen.findByText("반 연결 가능 여부를 확인하지 못했어요. 입력은 그대로 있어요.");
    fireEvent.click(screen.getByRole("button", { name: "개인 기록으로 저장 시작" }));
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "개인 평가" } });
    await waitFor(() => expect(create).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("connection_scope");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("expected_class_id");
  });
  it("requires an explicit storage choice after a class-change rejection and preserves edits", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext")
      .mockResolvedValueOnce({
        class_connection_available: true,
        current_class: { id: "1", name: "현재 반" },
      })
      .mockResolvedValue({
        class_connection_available: true,
        current_class: { id: "2", name: "새 반" },
      });
    const create = vi
      .spyOn(api, "createStudentAssessment")
      .mockRejectedValue(
        new ApiRequestError(
          "ASSESSMENT_CLASS_CONTEXT_CHANGED",
          "현재 반이 바뀌었어요. 새 기록 화면을 다시 열어 주세요.",
          409,
        ),
      );
    renderEditor();
    await screen.findByRole("option", { name: "현재 반에 연결 · 현재 반" });
    fireEvent.change(screen.getByLabelText("기록 보관 방식"), {
      target: { value: "current_class" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "평가" } });
    await screen.findByText(
      "현재 반이 바뀌었어요. 입력은 보존했어요. 보관 방식을 확인하고 다시 저장해 주세요.",
    );
    expect(screen.queryByText("서버에 저장됐어요")).not.toBeInTheDocument();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      connection_scope: "current_class",
      expected_class_id: "1",
    });
    await screen.findByRole("option", { name: "현재 반에 연결 · 새 반" });
    expect(screen.getByLabelText("기록 보관 방식")).toHaveValue("personal");
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "수정한 평가" } });
    fireEvent.click(screen.getByRole("button", { name: "닫기 · 초안 유지" }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(create).toHaveBeenCalledOnce();
    create.mockResolvedValue({
      etag: '"1"',
      item: { ...item, connection_scope: "personal", class_id: null, class_name: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "선택한 보관 방식으로 다시 저장" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty("expected_class_id");
    expect(create.mock.calls[1]?.[0].title).toBe("수정한 평가");
    expect(screen.queryByText(/반 연결 기록/)).not.toBeInTheDocument();
    expect(screen.getByText("서버에 저장됐어요")).toBeVisible();
  });
  it("shows an existing unknown-scope record without claiming it is personal or allowing connection changes", () => {
    const context = vi.spyOn(api, "getStudentAssessmentCreationContext");
    const {
      connection_scope: _scope,
      class_id: _classId,
      class_name: _className,
      ...legacyItem
    } = item;
    renderEditor(legacyItem);
    expect(context).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("기록 보관 방식")).not.toBeInTheDocument();
    expect(screen.getByText("평가 기록 · 보관 방식은 바꿀 수 없어요.")).toBeVisible();
    expect(screen.queryByText("개인 기록")).not.toBeInTheDocument();
    expect(screen.getByText(/현재 보관 만료: 2026/)).toBeVisible();
  });
});

describe("assessment editor workflow hierarchy", () => {
  afterEach(() => vi.restoreAllMocks());
  it("separates plans and results while keeping incomplete drafts and server completion distinct", () => {
    const complete = vi.spyOn(api, "completeStudentAssessment");
    renderEditor(item);
    expect(screen.getByRole("heading", { name: "1. 평가 계획" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2. 결과 기록" })).toBeInTheDocument();
    expect(
      screen.getByText("아직 초안이에요. 자동 저장과 기록 완료는 별개예요."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기록 완료" })).toBeEnabled();
    expect(screen.getByText(/학년도·학기·평가 구분·과목·평가명·평가일/)).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "닫기 · 초안 유지" }).closest("[data-assessment-toolbar]"),
    ).not.toBeNull();
  });
  it("keeps recorded edits distinct from finalization and does not claim a new save", () => {
    renderEditor({ ...item, status: "recorded" });
    expect(screen.queryByRole("button", { name: "기록 완료" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "닫기 · 기록 유지" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "닫기 · 초안 유지" })).not.toBeInTheDocument();
    expect(
      screen.getByText("이미 완료한 기록이에요. 수정한 내용은 자동 저장돼요."),
    ).toBeInTheDocument();
    expect(screen.queryByText("서버에 저장됐어요")).not.toBeInTheDocument();
    expect(screen.getByText("수정하면 서버에 자동 저장돼요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기록 삭제" })).toBeEnabled();
  });
});

import { createMemoryRouter, RouterProvider, Link, useNavigate, useLocation } from "react-router";

function renderGuardedEditor(
  initialItem?: api.StudentAssessmentItem,
  initialEntries = ["/assessments?edit=31"],
) {
  function Harness() {
    const navigate = useNavigate();
    const location = useLocation();
    return (
      <>
        <Link to="/other">다른 메뉴</Link>
        <button onClick={() => void navigate(-1)}>뒤로 가기</button>
        <StudentAssessmentEditor
          {...(initialItem ? { initialItem } : {})}
          onClose={() => void navigate("/other")}
          onDeleted={vi.fn()}
          onRecord={(saved) => {
            if (new URLSearchParams(location.search).get("new") === "1")
              void navigate(`/assessments?edit=${saved.id}`, { replace: true });
          }}
          onUnauthorized={() => void navigate("/login", { replace: true })}
          serverToday="2026-10-10"
        />
      </>
    );
  }
  const router = createMemoryRouter(
    [
      { path: "/assessments", element: <Harness /> },
      { path: "/other", element: <p>다른 메뉴 도착</p> },
      { path: "/login", element: <p>세션 종료 도착</p> },
    ],
    { initialEntries },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("assessment navigation protection with data router", () => {
  afterEach(() => vi.restoreAllMocks());
  it("flushes a pending autosave before a menu transition", async () => {
    let finish!: (value: api.StudentAssessmentEntityResponse) => void;
    const update = vi.spyOn(api, "updateStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const router = renderGuardedEditor(item);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "이동 직전 입력" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(router.state.location.pathname).toBe("/assessments");
    expect(screen.getByLabelText("평가명")).toHaveValue("이동 직전 입력");
    await act(async () =>
      finish({ etag: '"2"', item: { ...item, title: "이동 직전 입력", row_version: "2" } }),
    );
    await screen.findByText("다른 메뉴 도착");
    expect(update.mock.calls[0]?.[1].title).toBe("이동 직전 입력");
  });
  it("preserves unconfirmed input and restores storage-choice focus when going back", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    const create = vi.spyOn(api, "createStudentAssessment");
    const router = renderGuardedEditor(undefined, ["/other", "/assessments?new=1"]);
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "아직 확인 전" } });
    fireEvent.click(screen.getByRole("button", { name: "뒤로 가기" }));
    await waitFor(() => expect(screen.getByLabelText("기록 보관 방식")).toHaveFocus());
    expect(router.state.location.pathname).toBe("/assessments");
    expect(router.state.blockers.size).toBe(1);
    expect(screen.getByLabelText("평가명")).toHaveValue("아직 확인 전");
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps the editor when save fails, then permits a successful retry", async () => {
    const update = vi
      .spyOn(api, "updateStudentAssessment")
      .mockRejectedValueOnce(new Error("일시 저장 실패"))
      .mockResolvedValue({
        etag: '"2"',
        item: { ...item, title: "보존할 제목", row_version: "2" },
      });
    const router = renderGuardedEditor(item);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "보존할 제목" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("일시 저장 실패");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(router.state.location.pathname).toBe("/assessments");
    expect(screen.getByLabelText("평가명")).toHaveValue("보존할 제목");
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("다른 메뉴 도착");
    expect(update).toHaveBeenCalledTimes(2);
  });
  it("warns on unload only while input is unsaved and removes its listener on unmount", async () => {
    let finish!: (value: api.StudentAssessmentEntityResponse) => void;
    vi.spyOn(api, "updateStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderGuardedEditor(item);
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "보호할 제목" } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await waitFor(() => expect(screen.getByLabelText("평가명")).toBeDisabled());
    await act(async () => finish({ etag: '"2"', item: { ...item, row_version: "2" } }));
    await screen.findByText("다른 메뉴 도착");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it("allows an immediate login redirect when flushing discovers an expired session", async () => {
    vi.spyOn(api, "updateStudentAssessment").mockRejectedValue(
      new ApiRequestError("UNAUTHENTICATED", "세션 종료", 401),
    );
    const router = renderGuardedEditor(item);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "세션 종료 직전" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("세션 종료 도착");
    expect(router.state.location.pathname).toBe("/login");
  });
  it("permits first-save URL replacement while newer input is waiting and saves the latest revision", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: true,
      current_class: { id: "1", name: "현재 반" },
    });
    let finish!: (value: api.StudentAssessmentEntityResponse) => void;
    const create = vi.spyOn(api, "createStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const update = vi.spyOn(api, "updateStudentAssessment").mockResolvedValue({
      etag: '"2"',
      item: { ...item, title: "더 최신 제목", row_version: "2" },
    });
    const router = renderGuardedEditor(undefined, ["/assessments?new=1"]);
    await screen.findByRole("option", { name: "현재 반에 연결 · 현재 반" });
    fireEvent.change(screen.getByLabelText("기록 보관 방식"), {
      target: { value: "current_class" },
    });
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "최초 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "더 최신 제목" } });
    await act(async () => finish({ etag: '"1"', item: { ...item, title: "최초 제목" } }));
    await waitFor(() => expect(router.state.location.search).toBe("?edit=31"));
    expect(screen.getByLabelText("평가명")).toHaveValue("더 최신 제목");
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("다른 메뉴 도착");
    expect(update.mock.calls.at(-1)?.[1].title).toBe("더 최신 제목");
    expect(create.mock.calls[0]?.[0].expected_class_id).toBe("1");
    expect(update).toHaveBeenCalledOnce();
  });
  it("does not publish an old completion callback after another editor has replaced it", async () => {
    let finish!: (value: api.StudentAssessmentEntityResponse) => void;
    const complete = vi.spyOn(api, "completeStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onRecord = vi.fn();
    const view = render(
      <MemoryRouter>
        <StudentAssessmentEditor
          initialItem={item}
          onClose={vi.fn()}
          onDeleted={vi.fn()}
          onRecord={onRecord}
          onUnauthorized={vi.fn()}
          serverToday="2026-10-10"
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "기록 완료" }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    view.rerender(
      <MemoryRouter>
        <StudentAssessmentEditor
          key="next-record"
          initialItem={{ ...item, id: "32", title: "다음 기록" }}
          onClose={vi.fn()}
          onDeleted={vi.fn()}
          onRecord={onRecord}
          onUnauthorized={vi.fn()}
          serverToday="2026-10-10"
        />
      </MemoryRouter>,
    );
    await act(async () =>
      finish({ etag: '"2"', item: { ...item, status: "recorded", row_version: "2" } }),
    );
    expect(onRecord).not.toHaveBeenCalled();
    expect(screen.getByLabelText("평가명")).toHaveValue("다음 기록");
  });
  it("keeps the conflict recovery action after a blocked route and retries with the latest version", async () => {
    const update = vi
      .spyOn(api, "updateStudentAssessment")
      .mockRejectedValueOnce(
        new ApiRequestError("RESOURCE_VERSION_CHANGED", "다른 화면에서 수정했어요.", 412),
      )
      .mockResolvedValue({
        etag: '"8"',
        item: { ...item, title: "내가 입력한 제목", row_version: "8" },
      });
    const latest = vi.spyOn(api, "getStudentAssessment").mockResolvedValue({
      etag: '"7"',
      item: { ...item, title: "서버의 다른 제목", row_version: "7" },
    });
    const router = renderGuardedEditor(item);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "내가 입력한 제목" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    const recover = await screen.findByRole("button", { name: "최신 버전 위에 내 입력 다시 저장" });
    expect(router.state.location.pathname).toBe("/assessments");
    expect(screen.getByLabelText("평가명")).toHaveValue("내가 입력한 제목");
    expect(screen.queryByRole("button", { name: "저장 다시 시도" })).not.toBeInTheDocument();
    fireEvent.click(recover);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(latest).toHaveBeenCalledWith("31");
    expect(update.mock.calls[1]).toEqual([
      "31",
      expect.objectContaining({ title: "내가 입력한 제목" }),
      '"7"',
    ]);
    await screen.findByText("서버에 저장됐어요");
    expect(screen.getByLabelText("평가명")).toHaveValue("내가 입력한 제목");
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("다른 메뉴 도착");
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe("assessment numeric validation and explicit error focus", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      label: "받은 점수",
      invalid: "101",
      corrected: "90",
      field: "score_hundredths",
      saved: 9000,
      error: "받은 점수는 만점보다 클 수 없어요.",
    },
    {
      label: "받은 점수",
      invalid: "1001",
      corrected: "90",
      field: "score_hundredths",
      saved: 9000,
      error: "받은 점수는 1,000점 이하로 입력해 주세요.",
    },
    {
      label: "만점",
      invalid: "0",
      corrected: "100",
      field: "max_score_hundredths",
      saved: 10000,
      error: "만점은 0보다 크고 1,000점 이하여야 해요.",
    },
    {
      label: "만점",
      invalid: "1001",
      corrected: "100",
      field: "max_score_hundredths",
      saved: 10000,
      error: "만점은 0보다 크고 1,000점 이하여야 해요.",
    },
    {
      label: "반영 비율",
      invalid: "0",
      corrected: "30",
      field: "weight_basis_points",
      saved: 3000,
      error: "반영 비율은 0보다 크고 100% 이하여야 해요.",
    },
    {
      label: "반영 비율",
      invalid: "100.01",
      corrected: "30",
      field: "weight_basis_points",
      saved: 3000,
      error: "반영 비율은 0보다 크고 100% 이하여야 해요.",
    },
    {
      label: "학년도",
      invalid: "2019",
      corrected: "2026",
      field: "academic_year",
      saved: 2026,
      error: "학년도는 2020년부터 2100년 사이로 입력해 주세요.",
    },
  ])(
    "rejects $label=$invalid without an API write, preserves focus, and saves corrected input",
    async ({ label, invalid, corrected, field, saved, error }) => {
      vi.useFakeTimers();
      const update = vi
        .spyOn(api, "updateStudentAssessment")
        .mockImplementation(async (_id, request) => ({
          etag: '\"2\"',
          item: { ...item, ...request, row_version: "2" },
        }));
      const create = vi.spyOn(api, "createStudentAssessment");
      const complete = vi.spyOn(api, "completeStudentAssessment");
      renderEditor({ ...item, max_score_hundredths: 10000 });
      const input = screen.getByLabelText(label === "반영 비율" ? /반영 비율/u : label);
      input.focus();
      fireEvent.change(input, { target: { value: invalid } });
      await act(async () => vi.advanceTimersByTimeAsync(850));
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      expect(screen.getByText("저장하지 못했어요")).toBeVisible();
      expect(input).toHaveValue(invalid);
      expect(input).toHaveFocus();
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "저장 다시 시도" }));
      await act(async () => {});
      expect(update).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: corrected } });
      await act(async () => vi.advanceTimersByTimeAsync(850));
      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0]?.[1]).toMatchObject({ [field]: saved });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("서버에 저장됐어요")).toBeVisible();
    },
  );

  it.each(["닫기 · 초안 유지", "기록 완료"])(
    "focuses the error after explicit %s and retains invalid input without calling either API",
    async (action) => {
      const update = vi.spyOn(api, "updateStudentAssessment");
      const complete = vi.spyOn(api, "completeStudentAssessment");
      const closed = vi.fn();
      renderEditor({ ...item, max_score_hundredths: 10000 }, vi.fn(), closed);
      fireEvent.change(screen.getByLabelText("받은 점수"), {
        target: { value: "101" },
      });
      fireEvent.click(screen.getByRole("button", { name: action }));
      await screen.findByText("받은 점수는 만점보다 클 수 없어요.");
      await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
      expect(screen.getByLabelText("받은 점수")).toHaveValue("101");
      expect(screen.getByRole("button", { name: action })).toBeEnabled();
      expect(closed).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("does not create an invalid new draft and allows correction with the same storage choice", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    const create = vi.spyOn(api, "createStudentAssessment").mockImplementation(async (request) => ({
      etag: '\"1\"',
      item: {
        ...item,
        ...request,
        connection_scope: "personal",
        class_id: null,
        class_name: null,
      },
    }));
    const update = vi.spyOn(api, "updateStudentAssessment");
    renderEditor();
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("만점"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await screen.findByText("만점은 0보다 크고 1,000점 이하여야 해요.");
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByLabelText("기록 보관 방식")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "저장 다시 시도" }));
    await act(async () => {});
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("만점"), {
      target: { value: "100" },
    });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      max_score_hundredths: 10000,
    });
    expect(screen.getByText("서버에 저장됐어요")).toBeVisible();
  });
});

describe("assessment validation and navigation integration", () => {
  afterEach(() => vi.restoreAllMocks());
  it("retains invalid values and focuses the explicit menu failure before saving a correction and leaving", async () => {
    const update = vi
      .spyOn(api, "updateStudentAssessment")
      .mockImplementation(async (_id, request) => ({
        etag: '\"2\"',
        item: { ...item, ...request, row_version: "2" },
      }));
    const create = vi.spyOn(api, "createStudentAssessment");
    const complete = vi.spyOn(api, "completeStudentAssessment");
    const router = renderGuardedEditor(item);
    fireEvent.change(screen.getByLabelText("만점"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("만점은 0보다 크고 1,000점 이하여야 해요.");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(router.state.location.pathname).toBe("/assessments");
    expect(screen.getByLabelText("만점")).toHaveValue("0");
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("만점"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("link", { name: "다른 메뉴" }));
    await screen.findByText("다른 메뉴 도착");
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ max_score_hundredths: 10000 });
    expect(router.state.location.pathname).toBe("/other");
  });
});

describe("assessment stale authentication and first-save callbacks", () => {
  afterEach(() => vi.restoreAllMocks());
  it("does not publish a first create while the parent has forced logout but the editor is still mounted", async () => {
    vi.spyOn(api, "getStudentAssessmentCreationContext").mockResolvedValue({
      class_connection_available: false,
      current_class: null,
    });
    let finish!: (value: api.StudentAssessmentEntityResponse) => void;
    const create = vi.spyOn(api, "createStudentAssessment").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const recorded = vi.fn();
    const unauthorized = vi.fn();
    let forced = false;
    render(
      <MemoryRouter>
        <StudentAssessmentEditor
          onClose={vi.fn()}
          onDeleted={vi.fn()}
          onRecord={recorded}
          onUnauthorized={unauthorized}
          isForcedExit={() => forced}
          serverToday="2026-10-10"
        />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "이 보관 방식으로 저장 시작" });
    fireEvent.change(screen.getByLabelText("평가명"), {
      target: { value: "로그아웃 직전 새 기록" },
    });
    fireEvent.click(screen.getByRole("button", { name: "이 보관 방식으로 저장 시작" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    forced = true;
    await act(async () =>
      finish({
        etag: '\"1\"',
        item: {
          ...item,
          title: "로그아웃 직전 새 기록",
          connection_scope: "personal",
          class_id: null,
          class_name: null,
        },
      }),
    );
    expect(recorded).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
    expect(screen.getByLabelText("평가명")).toHaveValue("로그아웃 직전 새 기록");
    expect(screen.queryByText("서버에 저장됐어요")).not.toBeInTheDocument();
  });
  it("does not trigger an old unauthorized callback when a pending update rejects after unmount", async () => {
    let reject!: (error: unknown) => void;
    const update = vi.spyOn(api, "updateStudentAssessment").mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const unauthorized = vi.fn();
    const view = renderEditor(item, unauthorized);
    fireEvent.change(screen.getByLabelText("평가명"), { target: { value: "이전 화면 입력" } });
    fireEvent.click(screen.getByRole("button", { name: "닫기 · 초안 유지" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () =>
      reject(new ApiRequestError("UNAUTHENTICATED", "이전 요청의 세션 종료", 401)),
    );
    expect(unauthorized).not.toHaveBeenCalled();
  });
});

describe("assessment toolbar access and writing space", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps named save actions and live status in the toolbar while explanatory text scrolls with the form", () => {
    renderEditor(item);
    const close = screen.getByRole("button", { name: "닫기 · 초안 유지" });
    const complete = screen.getByRole("button", { name: "기록 완료" });
    const toolbar = close.closest("[data-assessment-toolbar]")!;
    const status = screen.getByText("수정하면 서버에 자동 저장돼요");
    expect(toolbar).toContainElement(complete);
    expect(toolbar).toContainElement(status);
    expect(status).toHaveAttribute("aria-live", "polite");
    const help = screen.getByText(
      "목록으로 돌아갈 때도 입력을 먼저 저장해요. 완료 여부는 서버에서 확인해요.",
    );
    expect(toolbar).not.toContainElement(help);
    expect(toolbar.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(close).toHaveClass("min-h-12");
    expect(complete).toHaveClass("min-h-12");
    expect(close).toHaveAccessibleName("닫기 · 초안 유지");
    expect(complete).toHaveAccessibleName("기록 완료");
  });
  it("keeps the existing recorded-close name when the mobile visible label is shortened", () => {
    renderEditor({ ...item, status: "recorded" });
    const close = screen.getByRole("button", { name: "닫기 · 기록 유지" });
    expect(close).toHaveAccessibleName("닫기 · 기록 유지");
    expect(close).toHaveClass("min-h-12");
    expect(screen.queryByRole("button", { name: "기록 완료" })).not.toBeInTheDocument();
    expect(close).toContainElement(screen.getByText("닫기"));
  });
});
