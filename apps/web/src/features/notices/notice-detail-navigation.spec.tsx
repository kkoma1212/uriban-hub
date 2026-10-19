import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoticeDetailPage } from "./notice-detail-page";

vi.mock("./notice-confirmations-panel", () => ({
  NoticeConfirmationsPanel: () => <p>확인 현황</p>,
}));
const bootstrap = {
  account: { display_name: "시험 교사", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "시험 반", status: "active" },
  current_membership: { id: "1", class_id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  teacher_profile: { status: "active", temporary_password_must_change: false },
  server_today: "2026-10-11",
  last_membership_status: null,
  last_status_reason: null,
};
const item = (id: string) => ({
  id,
  title: `공지 ${id}`,
  content: `본문 ${id}`,
  content_revision: "1",
  row_version: "1",
  category: "general",
  is_important: false,
  published_at: "2026-10-11T03:00:00Z",
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ETag: '"1"' },
  });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function show() {
  const router = createMemoryRouter(
    [
      { path: "/notices/:noticeId", element: <NoticeDetailPage /> },
      { path: "/login", element: <p>로그인 화면</p> },
    ],
    { initialEntries: ["/notices/A"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("notice detail route ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hides the previous notice and its edit actions while the next notice loads", async () => {
    const next = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        input === "/api/v1/bootstrap"
          ? response(bootstrap)
          : input === "/api/v1/notices/A"
            ? response(item("A"))
            : input === "/api/v1/notices/B"
              ? next.promise
              : response({}),
      ),
    );
    const router = show();
    await screen.findByRole("heading", { name: "공지 A", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
    await act(async () => {
      await router.navigate("/notices/B");
    });
    expect(screen.queryByText("본문 A")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "수정 저장" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("공지 내용을 불러오고 있어요.");
    await act(async () => {
      next.resolve(response(item("B")));
    });
    expect(await screen.findByRole("heading", { name: "공지 B", level: 1 })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "공지 제목" })).not.toBeInTheDocument();
    router.dispose();
  });

  it.each([200, 401])(
    "ignores an old update response with status %s after navigation",
    async (status) => {
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=test-csrf",
      );
      const update = deferred();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        if (init?.method === "PATCH") return update.promise;
        return Promise.resolve(
          response(
            input === "/api/v1/bootstrap"
              ? bootstrap
              : item(String(input).endsWith("/A") ? "A" : "B"),
          ),
        );
      });
      const router = show();
      await screen.findByRole("heading", { name: "공지 A", level: 1 });
      fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
      fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
        target: { value: "수정한 A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true),
      );
      await act(async () => {
        await router.navigate("/notices/B");
      });
      await screen.findByRole("heading", { name: "공지 B", level: 1 });
      await act(async () => {
        update.resolve(
          response(
            status === 200
              ? { ...item("A"), title: "수정한 A", row_version: "2" }
              : { error: { code: "UNAUTHENTICATED", message: "expired" } },
            status,
          ),
        );
      });
      expect(screen.getByRole("heading", { name: "공지 B", level: 1 })).toBeVisible();
      expect(screen.queryByText("수정한 A")).not.toBeInTheDocument();
      expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
      expect(screen.queryByText(/공지 내용을 수정했습니다/u)).not.toBeInTheDocument();
      router.dispose();
    },
  );

  it("ignores an old initial load after the next notice is ready", async () => {
    const previous = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      input === "/api/v1/notices/A"
        ? previous.promise
        : Promise.resolve(response(input === "/api/v1/bootstrap" ? bootstrap : item("B"))),
    );
    const router = show();
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/notices/A", expect.anything()),
    );
    await act(async () => {
      await router.navigate("/notices/B");
    });
    await screen.findByRole("heading", { name: "공지 B", level: 1 });
    await act(async () => {
      previous.resolve(response(item("A")));
    });
    expect(screen.getByRole("heading", { name: "공지 B", level: 1 })).toBeVisible();
    router.dispose();
  });

  it("ignores an old retry failure after the next notice is ready", async () => {
    const retry = deferred();
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/api/v1/notices/A") {
        attempts += 1;
        return attempts === 1
          ? Promise.resolve(
              response({ error: { code: "INTERNAL_ERROR", message: "try again" } }, 500),
            )
          : retry.promise;
      }
      return Promise.resolve(response(input === "/api/v1/bootstrap" ? bootstrap : item("B")));
    });
    const router = show();
    fireEvent.click(await screen.findByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect(attempts).toBe(2));
    await act(async () => {
      await router.navigate("/notices/B");
    });
    await screen.findByRole("heading", { name: "공지 B", level: 1 });
    await act(async () => {
      retry.resolve(response({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401));
    });
    expect(screen.getByRole("heading", { name: "공지 B", level: 1 })).toBeVisible();
    expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    router.dispose();
  });

  it.each([false, true])(
    "does not send a scheduled delete after navigation (return to A: %s)",
    async (returnToA) => {
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=test-csrf",
      );
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((input) =>
          Promise.resolve(
            response(
              input === "/api/v1/bootstrap"
                ? bootstrap
                : item(String(input).endsWith("/A") ? "A" : "B"),
            ),
          ),
        );
      const router = show();
      await screen.findByRole("heading", { name: "공지 A", level: 1 });
      fireEvent.click(screen.getByRole("button", { name: "공지 삭제 옵션" }));
      fireEvent.click(screen.getByRole("button", { name: "공지 삭제" }));
      const dialog = screen.getByRole("dialog");
      const scheduled: Array<() => void> = [];
      const timerSpy = vi
        .spyOn(window, "setTimeout")
        .mockImplementation((handler, delay, ...args) => {
          if (delay !== 0 || typeof handler !== "function")
            throw new Error("Unexpected deletion scheduling.");
          scheduled.push(() => handler(...args));
          return scheduled.length as unknown as ReturnType<typeof window.setTimeout>;
        });
      fireEvent.click(within(dialog).getByRole("button", { name: "공지 삭제" }));
      timerSpy.mockRestore();
      expect(scheduled.length).toBeGreaterThan(0);
      await act(async () => {
        await router.navigate("/notices/B");
      });
      await screen.findByRole("heading", { name: "공지 B", level: 1 });
      if (returnToA) {
        await act(async () => {
          await router.navigate("/notices/A");
        });
        await screen.findByRole("heading", { name: "공지 A", level: 1 });
      }
      await act(async () => {
        scheduled.forEach((run) => run());
      });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
      expect(
        screen.getByRole("heading", { name: returnToA ? "공지 A" : "공지 B", level: 1 }),
      ).toBeVisible();
      router.dispose();
    },
  );
});
