import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAdminInquiries,
  updateAdminInquiry,
  type AdminInquiry,
} from "../../api/admin-management";
import { InquiriesPanel } from "./admin-console-inquiries-panel";
vi.mock("../../api/admin-management", () => ({
  listAdminInquiries: vi.fn(),
  updateAdminInquiry: vi.fn(),
}));
const item = (id: string, subject: string): AdminInquiry => ({
  id,
  subject,
  body: `${subject} 본문`,
  status: "open",
  assigned_admin_account_id: "17",
  internal_note: null,
  response: null,
  created_at: "2026-09-03T00:00:00.000Z",
  updated_at: "2026-09-03T00:00:00.000Z",
  requester_user_id: "user-1",
  responded_at: null,
  responded_by_admin_account_id: null,
  resolved_at: null,
});
const a = item("a", "첫 문의"),
  b = item("b", "다음 문의");
const list = vi.mocked(listAdminInquiries),
  update = vi.mocked(updateAdminInquiry);
const detail = () => within(screen.getByRole("region", { name: "선택한 문의" }));
const response = () => detail().getByRole("textbox", { name: "답변 기록 (관리자용)" });
const filter = () => document.getElementById("inquiry-status-filter")!;
const choose = (subject: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${subject}`) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("InquiriesPanel selected inquiry workflow", () => {
  beforeEach(() => {
    list.mockResolvedValue({ inquiries: [a, b] });
    update.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });
  it("preserves each ID draft across selection, filtering and refresh with hidden controls inaccessible", async () => {
    list.mockImplementation(async (status) => ({ inquiries: status === "closed" ? [b] : [a, b] }));
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    expect(screen.getAllByRole("button", { name: "처리 내용 저장" })).toHaveLength(1);
    fireEvent.change(response(), { target: { value: "첫 초안" } });
    choose("다음 문의");
    fireEvent.change(response(), { target: { value: "다음 초안" } });
    choose("첫 문의");
    expect(response()).toHaveValue("첫 초안");
    fireEvent.change(filter(), { target: { value: "closed" } });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^첫 문의/ })).not.toBeInTheDocument(),
    );
    expect(response()).toHaveValue("다음 초안");
    fireEvent.change(filter(), { target: { value: "" } });
    await screen.findByRole("button", { name: /^첫 문의/ });
    choose("첫 문의");
    fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(response()).toHaveValue("첫 초안");
    const hidden = document.querySelector("li[hidden]")!;
    expect(hidden).not.toBeVisible();
    expect(document.querySelectorAll("[data-selected-inquiry]")).toHaveLength(1);
    expect(document.querySelector("[data-selected-inquiry]")).toHaveAttribute(
      "data-selected-inquiry",
      "a",
    );
  });
  it("ignores older filter responses and does not auto-focus refreshed selection", async () => {
    const slow = deferred<{ inquiries: AdminInquiry[] }>();
    list.mockImplementation((status) =>
      status === "open"
        ? slow.promise
        : Promise.resolve({
            inquiries: status === "closed" ? [{ ...b, status: "closed" }] : [a, b],
          }),
    );
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    fireEvent.change(filter(), { target: { value: "open" } });
    fireEvent.change(filter(), { target: { value: "closed" } });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^첫 문의/ })).not.toBeInTheDocument(),
    );
    slow.resolve({ inquiries: [a] });
    await waitFor(() => expect(filter()).toHaveValue("closed"));
    expect(screen.getByRole("button", { name: /^다음 문의/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("heading", { name: "선택한 문의" })).not.toHaveFocus();
  });
  it("syncs untouched server data while retaining dirty fields on same-ID refresh", async () => {
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    list.mockResolvedValue({
      inquiries: [{ ...a, response: "서버 답변", status: "in_progress" }, b],
    });
    fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
    await waitFor(() => expect(response()).toHaveValue("서버 답변"));
    fireEvent.change(response(), { target: { value: "작성 중 답변" } });
    list.mockResolvedValue({
      inquiries: [{ ...a, response: "더 새 서버 답변", status: "resolved" }, b],
    });
    fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(response()).toHaveValue("작성 중 답변");
  });
  it("captures save ID and revision so a late save cannot overwrite newer typing or another inquiry", async () => {
    const saving = deferred<{ inquiry: AdminInquiry }>();
    update.mockReturnValue(saving.promise);
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    fireEvent.change(response(), { target: { value: "저장 요청 답변" } });
    fireEvent.click(detail().getByRole("button", { name: "처리 내용 저장" }));
    expect(detail().getByRole("button", { name: "처리 내용 저장" })).toBeDisabled();
    fireEvent.change(response(), { target: { value: "뒤이어 작성한 답변" } });
    choose("다음 문의");
    saving.resolve({ inquiry: { ...a, response: "저장 요청 답변" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("a", { response: "저장 요청 답변", status: "open" }),
    );
    expect(response()).toHaveValue("");
    choose("첫 문의");
    await waitFor(() => expect(response()).toHaveValue("뒤이어 작성한 답변"));
    expect(detail().queryByText("저장했습니다.")).not.toBeInTheDocument();
  });
  it("keeps payload semantics, unassignment and separate internal note without automatic delivery", async () => {
    list.mockResolvedValue({ inquiries: [{ ...a, response: "기존 답변" }] });
    update.mockResolvedValue({
      inquiry: {
        ...a,
        response: "기존 답변",
        assigned_admin_account_id: null,
        internal_note: "내부 확인",
      },
    });
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    fireEvent.change(detail().getByRole("textbox", { name: "담당 관리자 ID" }), {
      target: { value: "" },
    });
    fireEvent.change(
      detail().getByRole("textbox", { name: "내부 메모 · 사용자에게 보이지 않음" }),
      { target: { value: "내부 확인" } },
    );
    fireEvent.click(detail().getByRole("button", { name: "처리 내용 저장" }));
    await detail().findByText("저장했습니다.");
    expect(update).toHaveBeenCalledWith("a", {
      assigned_admin_account_id: null,
      internal_note: "내부 확인",
      status: "open",
    });
    expect(detail().getByText(/저장해도 사용자에게 자동 전달되지 않습니다/)).toBeVisible();
    fireEvent.change(response(), { target: { value: "새 초안" } });
    expect(detail().queryByText("저장했습니다.")).not.toBeInTheDocument();
  });
  it("retains failed-save input and focuses only an explicitly chosen detail", async () => {
    update.mockRejectedValue(Error("synthetic"));
    render(<InquiriesPanel />);
    await screen.findByRole("button", { name: /^첫 문의/ });
    choose("다음 문의");
    expect(screen.getByRole("heading", { name: "선택한 문의" })).toHaveFocus();
    fireEvent.change(response(), { target: { value: "실패한 초안" } });
    fireEvent.click(detail().getByRole("button", { name: "처리 내용 저장" }));
    await detail().findByRole("alert");
    expect(response()).toHaveValue("실패한 초안");
    choose("첫 문의");
    choose("다음 문의");
    expect(response()).toHaveValue("실패한 초안");
  });
});

it("reports only ID aggregates for hidden drafts and late typing during save", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  const report = vi.fn();
  const saving = deferred<{ inquiry: AdminInquiry }>();
  update.mockReturnValue(saving.promise);
  render(<InquiriesPanel onWorkState={report} />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  fireEvent.change(response(), { target: { value: "비밀 원문 저장 금지" } });
  fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
  choose("다음 문의");
  expect(report).toHaveBeenLastCalledWith({ dirtyIds: ["a"], pendingIds: ["a"] });
  choose("첫 문의");
  fireEvent.change(response(), { target: { value: "새 원문" } });
  await act(async () => saving.resolve({ inquiry: { ...a, response: "비밀 원문 저장 금지" } }));
  expect(report).toHaveBeenLastCalledWith({ dirtyIds: ["a"], pendingIds: [] });
  expect(JSON.stringify(report.mock.calls)).not.toContain("원문");
});

it("uses latest input and reports work synchronously when typing and save share one React batch", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  const report = vi.fn();
  update.mockResolvedValue({ inquiry: { ...a, response: "같은 작업의 답변" } });
  render(<InquiriesPanel onWorkState={report} />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  const original = response();
  act(() => {
    fireEvent.change(original, { target: { value: "같은 작업의 답변" } });
    expect(report).toHaveBeenLastCalledWith({ dirtyIds: ["a"], pendingIds: [] });
    fireEvent.click(detail().getByRole("button", { name: "처리 내용 저장" }));
    expect(report).toHaveBeenLastCalledWith({ dirtyIds: ["a"], pendingIds: ["a"] });
  });
  expect(update).toHaveBeenCalledWith("a", { response: "같은 작업의 답변", status: "open" });
  await screen.findByText("저장했습니다.");
  expect(response()).toBe(original);
});
it("does not let an incoming clean server revision replace input typed in its completion batch", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  render(<InquiriesPanel />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  const refresh = deferred<{ inquiries: AdminInquiry[] }>();
  list.mockReturnValueOnce(refresh.promise);
  fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  const original = response();
  await act(async () => {
    refresh.resolve({ inquiries: [{ ...a, response: "뒤늦은 서버 답변" }, b] });
    fireEvent.change(original, { target: { value: "즉시 작성한 초안" } });
  });
  expect(response()).toBe(original);
  expect(response()).toHaveValue("즉시 작성한 초안");
  choose("다음 문의");
  choose("첫 문의");
  expect(response()).toBe(original);
  expect(response()).toHaveValue("즉시 작성한 초안");
});

it("does not republish old dirty IDs after the panel unmounts during a forced session exit", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  const report = vi.fn();
  const saving = deferred<{ inquiry: AdminInquiry }>();
  update.mockReturnValue(saving.promise);
  const view = render(<InquiriesPanel onWorkState={report} />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  fireEvent.change(response(), { target: { value: "종료 전 초안" } });
  fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
  view.unmount();
  const count = report.mock.calls.length;
  expect(report).toHaveBeenLastCalledWith({ dirtyIds: [], pendingIds: [] });
  await act(async () => saving.resolve({ inquiry: { ...a, response: "종료 전 초안" } }));
  expect(report).toHaveBeenCalledTimes(count);
});

it("does not let a refresh started before a successful save restore the old reply", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  render(<InquiriesPanel />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  const refresh = deferred<{ inquiries: AdminInquiry[] }>();
  list.mockReturnValueOnce(refresh.promise);
  fireEvent.click(screen.getByRole("button", { name: "목록 새로고침" }));
  const original = response();
  fireEvent.change(original, { target: { value: "저장한 최신 답변" } });
  update.mockResolvedValue({ inquiry: { ...a, response: "저장한 최신 답변", status: "resolved" } });
  fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
  await screen.findByText("저장했습니다.");
  await act(async () => refresh.resolve({ inquiries: [a, b] }));
  expect(response()).toBe(original);
  expect(response()).toHaveValue("저장한 최신 답변");
  expect(detail().getByRole("combobox", { name: "처리 상태" })).toHaveValue("resolved");
  expect(screen.getByRole("button", { name: "목록 새로고침" })).toBeEnabled();
});

it("restarts a changed status filter after save while rejecting the older filter result", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  render(<InquiriesPanel />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  const saving = deferred<{ inquiry: AdminInquiry }>(),
    oldFilter = deferred<{ inquiries: AdminInquiry[] }>(),
    freshFilter = deferred<{ inquiries: AdminInquiry[] }>();
  update.mockReturnValue(saving.promise);
  fireEvent.change(response(), { target: { value: "새 저장 답변" } });
  fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
  list.mockReturnValueOnce(oldFilter.promise).mockReturnValueOnce(freshFilter.promise);
  fireEvent.change(filter(), { target: { value: "closed" } });
  await act(async () => saving.resolve({ inquiry: { ...a, response: "새 저장 답변" } }));
  expect(list).toHaveBeenLastCalledWith("closed");
  expect(list.mock.calls.slice(-2)).toEqual([["closed"], ["closed"]]);
  await act(async () => freshFilter.resolve({ inquiries: [{ ...b, status: "closed" }] }));
  await act(async () => oldFilter.resolve({ inquiries: [a, b] }));
  expect(screen.queryByRole("button", { name: /^첫 문의/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^다음 문의/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "목록 새로고침" })).toBeEnabled();
});

it("does not start another filter request when a save completes after forced unmount", async () => {
  list.mockResolvedValue({ inquiries: [a, b] });
  const view = render(<InquiriesPanel />);
  await screen.findByRole("button", { name: /^첫 문의/ });
  const saving = deferred<{ inquiry: AdminInquiry }>(),
    oldFilter = deferred<{ inquiries: AdminInquiry[] }>();
  update.mockReturnValue(saving.promise);
  fireEvent.change(response(), { target: { value: "종료 전에 저장" } });
  fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
  list.mockReturnValueOnce(oldFilter.promise);
  fireEvent.change(filter(), { target: { value: "closed" } });
  view.unmount();
  const calls = list.mock.calls.length;
  await act(async () => saving.resolve({ inquiry: { ...a, response: "종료 전에 저장" } }));
  expect(list).toHaveBeenCalledTimes(calls);
  await act(async () => oldFilter.resolve({ inquiries: [] }));
  expect(list).toHaveBeenCalledTimes(calls);
});
