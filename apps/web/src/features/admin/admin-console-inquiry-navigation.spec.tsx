import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { AdminConsolePage } from "./admin-console-page";
import { getAdminSession, logoutAdmin, ADMIN_SESSION_EXPIRED_EVENT } from "../../api/admin-auth";
import {
  listAdminInquiries,
  updateAdminInquiry,
  type AdminInquiry,
} from "../../api/admin-management";
vi.mock("../../api/admin-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/admin-auth")>()),
  getAdminSession: vi.fn(),
  logoutAdmin: vi.fn(),
}));
vi.mock("../../api/admin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/admin-management")>()),
  listAdminInquiries: vi.fn(),
  updateAdminInquiry: vi.fn(),
}));
vi.mock("./admin-session-status", () => ({ AdminSessionStatus: () => null }));
vi.mock("./admin-step-up-dialog", () => ({ AdminStepUpDialog: () => null }));
const inquiry = (id: string): AdminInquiry => ({
  id,
  subject: "문의" + id,
  body: "본문",
  status: "open",
  assigned_admin_account_id: null,
  internal_note: null,
  response: null,
  created_at: "2026-10-10T00:00:00Z",
  updated_at: "2026-10-10T00:00:00Z",
  requester_user_id: "7",
  responded_at: null,
  responded_by_admin_account_id: null,
  resolved_at: null,
});
const a = inquiry("a"),
  b = inquiry("b");
const session = {
  account: {
    id: "17",
    display_name: "시험 관리자",
    email: "synthetic@example.invalid",
    roles: ["super_admin"],
  },
  session: {
    issued_at: "2026-10-10T00:00:00Z",
    absolute_expires_at: "2099-10-10T00:00:00Z",
    last_seen_at: "2026-10-10T00:00:00Z",
    reauthenticated_at: "2026-10-10T00:00:00Z",
    mfa_verified_at: "2026-10-10T00:00:00Z",
  },
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const response = () =>
  within(screen.getByRole("region", { name: "선택한 문의" })).getByRole("textbox", {
    name: "답변 기록 (관리자용)",
  });
async function setup(data = true) {
  const router = createMemoryRouter(
    [
      { path: "/admin", element: <AdminConsolePage /> },
      { path: "/admin/account", element: <p>계정 도착</p> },
      { path: "/admin/login", element: <p>로그인 도착</p> },
      { path: "/other", element: <p>외부 화면 도착</p> },
    ],
    { initialEntries: ["/other", "/admin?tab=inquiries"] },
  );
  render(
    data ? (
      <RouterProvider router={router} />
    ) : (
      <MemoryRouter initialEntries={["/admin?tab=inquiries"]}>
        <AdminConsolePage />
      </MemoryRouter>
    ),
  );
  await screen.findByRole("textbox", { name: "답변 기록 (관리자용)" });
  return router;
}
beforeEach(() => {
  vi.mocked(getAdminSession).mockResolvedValue(
    session as Awaited<ReturnType<typeof getAdminSession>>,
  );
  vi.mocked(listAdminInquiries).mockResolvedValue({ inquiries: [a, b] });
  vi.mocked(logoutAdmin).mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());
describe("inquiry unsaved navigation protection", () => {
  it("protects hidden drafts from tab and search, cancellation preserves original selection and text", async () => {
    await setup(false);
    fireEvent.change(response(), { target: { value: "원문 초안" } });
    fireEvent.click(screen.getByRole("button", { name: /^문의b/ }));
    fireEvent.click(screen.getByRole("tab", { name: "계정 관리" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
    expect(screen.getByRole("tab", { name: "문의" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByRole("searchbox", { name: "회원 검색" }), {
      target: { value: "test" },
    });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
    fireEvent.click(screen.getByRole("button", { name: /^문의a/ }));
    expect(response()).toHaveValue("원문 초안");
  });
  it("blocks account and history routes and proceeds only after explicit discard", async () => {
    const router = await setup();
    fireEvent.change(response(), { target: { value: "남길 초안" } });
    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "계속 작성" }));
    expect(response()).toHaveValue("남길 초안");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(response(), { target: { value: "취소 후 계속 작성" } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "계정·보안" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "저장하지 않고 이동" }));
    await screen.findByText("계정 도착");
  });
  it("pending save denies tab/logout/history and late new typing remains dirty", async () => {
    const router = await setup();
    const saving = deferred<{ inquiry: AdminInquiry }>();
    vi.mocked(updateAdminInquiry).mockReturnValue(saving.promise);
    fireEvent.change(response(), { target: { value: "보낸 답변" } });
    fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
    fireEvent.click(screen.getByRole("tab", { name: "계정 관리" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/저장이 끝난 뒤 다시 이동/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(logoutAdmin).not.toHaveBeenCalled();
    await act(async () => {
      await router.navigate("/other");
    });
    expect(screen.queryByText("외부 화면 도착")).not.toBeInTheDocument();
    fireEvent.change(response(), { target: { value: "새 답변" } });
    await act(async () => saving.resolve({ inquiry: { ...a, response: "보낸 답변" } }));
    expect(response()).toHaveValue("새 답변");
    fireEvent.click(screen.getByRole("tab", { name: "계정 관리" }));
    await screen.findByRole("dialog");
  });
  it("pending-only save blocks beforeunload and failure keeps the editor available", async () => {
    await setup();
    const saving = deferred<{ inquiry: AdminInquiry }>();
    vi.mocked(updateAdminInquiry).mockReturnValue(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "처리 내용 저장" }));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "계정·보안" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => saving.reject(Error("시험 실패")));
    expect(response()).toHaveValue("");
    expect(screen.queryByText("계정 도착")).not.toBeInTheDocument();
  });
  it("confirmed tab discards only after consent and removed drafts no longer block", async () => {
    await setup();
    fireEvent.change(response(), { target: { value: "초안" } });
    fireEvent.click(screen.getByRole("tab", { name: "한눈에 보기" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "저장하지 않고 이동" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "한눈에 보기" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.queryByRole("textbox", { name: "답변 기록 (관리자용)" })).not.toBeInTheDocument();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it("logout failure retains draft and asks again on the next attempt", async () => {
    await setup();
    vi.mocked(logoutAdmin).mockRejectedValue(Error("synthetic"));
    fireEvent.change(response(), { target: { value: "보존 초안" } });
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "저장하지 않고 이동" }));
    await screen.findByText("synthetic");
    expect(response()).toHaveValue("보존 초안");
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await screen.findByRole("dialog");
  });
  it("beforeunload warns only for unsaved work and expiry bypasses the route blocker", async () => {
    const router = await setup();
    let event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.change(response(), { target: { value: "민감 원문" } });
    event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
      await router.navigate("/admin/login");
    });
    await screen.findByText("로그인 도착");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
