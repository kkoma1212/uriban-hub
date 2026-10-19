import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../../api/admin-request";
import {
  ADMIN_SESSION_CLEAR_SIGNAL,
  ADMIN_SESSION_EXPIRED_EVENT,
  notifyAdminSessionEnded,
} from "../../lib/admin-session-privacy";
import { ClassesPanel } from "./admin-console-classes-panel";
import { PeoplePanel } from "./admin-console-people-panel";

// Keep the real directory API and response parser: a stale 401 must not expire
// the current administrator even when response.json is already in flight.
vi.mock("../../api/admin-request", () => ({ adminFetch: vi.fn() }));
const fetch = vi.mocked(adminFetch);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const failure = { error: { code: "ADMIN_SESSION_REQUIRED", message: "만료된 이전 요청" } };
const cases = [
  {
    label: "반 목록",
    Panel: ClassesPanel,
    filter: "상태",
    a: "active",
    b: "archived",
    body: (name: string) => ({
      page: 1,
      page_size: 20,
      total: 1,
      classes: [
        {
          id: "1",
          name,
          school_name: "검수학교",
          region_name: "검수지역",
          academic_year: 2026,
          grade: 1,
          teacher_name: "합성교사",
          students: 1,
          pending_members: 0,
          status: "active",
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
    }),
  },
  {
    label: "사용자 목록",
    Panel: PeoplePanel,
    filter: "구분",
    a: "teacher",
    b: "student",
    body: (name: string) => ({
      page: 1,
      page_size: 20,
      total: 1,
      people: [
        {
          id: "1",
          display_name: name,
          email_masked: "s***@example.invalid",
          role: "student",
          class_name: null,
          school_name: null,
          status: "active",
          created_at: "2026-10-01T00:00:00Z",
          last_login_at: null,
        },
      ],
    }),
  },
];
beforeEach(() => {
  fetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
for (const { label, Panel, filter, a, b, body } of cases)
  describe(`${label} administrator request context`, () => {
    const change = (value: string) =>
      fireEvent.change(screen.getByLabelText(filter), { target: { value } });
    const initial = async () => {
      fetch.mockResolvedValueOnce(response(body("기존 결과")));
      render(<Panel />);
      await screen.findByText("기존 결과");
    };
    for (const status of [200, 401, 500])
      it(`ignores stale A headers (${status}) while B remains loading`, async () => {
        await initial();
        const slowA = deferred<Response>(),
          slowB = deferred<Response>();
        fetch.mockReturnValueOnce(slowA.promise).mockReturnValueOnce(slowB.promise);
        const expired = vi.fn();
        window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
        try {
          change(a);
          change(b);
          expect(screen.queryByText("기존 결과")).not.toBeInTheDocument();
          expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true);
          await act(async () => {
            slowA.resolve(response(status === 200 ? body("이전 결과") : failure, status));
          });
          expect(screen.getByRole("status")).toHaveTextContent("불러오고");
          expect(screen.queryByText("이전 결과")).not.toBeInTheDocument();
          expect(screen.queryByRole("alert")).not.toBeInTheDocument();
          expect(expired).not.toHaveBeenCalled();
          await act(async () => {
            slowB.resolve(response(body("최신 결과")));
          });
          expect(screen.getByText("최신 결과")).toBeVisible();
        } finally {
          window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
        }
      });
    it("ignores stale A body 401 after B succeeds", async () => {
      await initial();
      const held = deferred<unknown>(),
        oldResponse = response(failure, 401);
      vi.spyOn(oldResponse, "json").mockReturnValue(held.promise);
      fetch
        .mockResolvedValueOnce(oldResponse)
        .mockResolvedValueOnce(response(body("최신 답변 결과")));
      const expired = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
      try {
        change(a);
        await waitFor(() => expect(oldResponse.json).toHaveBeenCalled());
        change(b);
        await screen.findByText("최신 답변 결과");
        await act(async () => {
          held.resolve(failure);
        });
        expect(screen.getByText("최신 답변 결과")).toBeVisible();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(expired).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
      }
    });
    it("keeps the third result when A→B→A completes in reverse order", async () => {
      await initial();
      const first = deferred<Response>(),
        second = deferred<Response>();
      fetch
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockResolvedValueOnce(response(body("세 번째 결과")));
      change(a);
      change(b);
      change(a);
      await screen.findByText("세 번째 결과");
      await act(async () => {
        second.resolve(response(body("두 번째 결과")));
        first.resolve(response(body("첫 번째 결과")));
      });
      expect(screen.getByText("세 번째 결과")).toBeVisible();
      expect(screen.queryByText("첫 번째 결과")).not.toBeInTheDocument();
    });
    for (const phase of ["headers", "body"] as const)
      for (const status of [200, 401])
        for (const clear of ["unmount", "local", "storage"] as const)
          it(`ignores initial ${phase} ${status} after ${clear}`, async () => {
            const held = deferred<Response>(),
              heldBody = deferred<unknown>();
            const old = response(status === 200 ? body("늦은 비공개 결과") : failure, status);
            if (phase === "body") vi.spyOn(old, "json").mockReturnValue(heldBody.promise);
            fetch.mockReturnValueOnce(phase === "body" ? Promise.resolve(old) : held.promise);
            const expired = vi.fn();
            window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
            const view = render(<Panel />);
            try {
              if (phase === "body") await waitFor(() => expect(old.json).toHaveBeenCalled());
              else await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
              if (clear === "unmount") {
                view.unmount();
                fetch.mockResolvedValueOnce(response(body("새 화면 결과")));
                render(<Panel />);
                await screen.findByText("새 화면 결과");
              } else if (clear === "local") act(() => notifyAdminSessionEnded());
              else
                act(() =>
                  window.dispatchEvent(
                    new StorageEvent("storage", {
                      key: ADMIN_SESSION_CLEAR_SIGNAL,
                      newValue: "different-session",
                    }),
                  ),
                );
              expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
              await act(async () => {
                if (phase === "body")
                  heldBody.resolve(status === 200 ? body("늦은 비공개 결과") : failure);
                else held.resolve(old);
              });
              expect(screen.queryByText("늦은 비공개 결과")).not.toBeInTheDocument();
              expect(screen.queryByRole("alert")).not.toBeInTheDocument();
              expect(expired).toHaveBeenCalledTimes(clear === "local" ? 1 : 0);
              if (clear === "unmount") expect(screen.getByText("새 화면 결과")).toBeVisible();
            } finally {
              window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
            }
          });
    it("still expires the current administrator on current 401", async () => {
      fetch.mockResolvedValueOnce(response(failure, 401));
      const expired = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
      try {
        render(<Panel />);
        await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
      } finally {
        window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, expired);
      }
    });
  });
