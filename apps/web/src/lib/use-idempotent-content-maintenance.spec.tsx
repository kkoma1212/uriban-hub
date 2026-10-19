import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api/auth";
import { clearAuthenticatedClientState } from "./authenticated-client-state";
import { idempotentCreateStorageKey } from "./idempotent-create";
import { useIdempotentContentCreate } from "./use-idempotent-content-create";

const isRequest = (value: unknown): value is string => typeof value === "string";
const storageKey = idempotentCreateStorageKey("schedules", "member-a");
const blocked = (code = "MAINTENANCE_MODE") =>
  new ApiRequestError(code, "점검 중이라 입력을 보관해 주세요.", 503);
const options = (
  create: (request: string, key: string) => Promise<{ item: { id: string } }>,
  readServerToday = async () => "2026-10-11",
) => ({
  actionLabel: "일정 등록",
  create,
  isRequest,
  membershipId: "member-a",
  onCreated: vi.fn(),
  onUnauthorized: vi.fn(),
  readServerToday,
  resource: "schedules",
  serverToday: "2026-10-11",
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("precise pre-admission refusals", () => {
  it("keeps editable form content after refusal and saves that content after OFF", async () => {
    let off = false;
    const create = vi.fn(async (_request: string, _key: string) => {
      if (!off) throw blocked();
      return { item: { id: "one" } };
    });
    const opts = options(create);
    function Form() {
      const [draft, setDraft] = useState("");
      const flow = useIdempotentContentCreate(opts);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void flow.submit(draft);
          }}
        >
          <input
            aria-label="일정 제목"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit">저장</button>
          {flow.error && <p role="alert">{flow.error}</p>}
        </form>
      );
    }
    render(<Form />);
    fireEvent.change(screen.getByLabelText("일정 제목"), {
      target: { value: "실제 입력한 초안" },
    });
    fireEvent.click(screen.getByText("저장"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(blocked().message));
    expect(screen.getByLabelText("일정 제목")).toHaveValue("실제 입력한 초안");
    off = true;
    fireEvent.click(screen.getByText("저장"));
    await waitFor(() => expect(opts.onCreated).toHaveBeenCalledExactlyOnceWith("one"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toBe("실제 입력한 초안");
  });
  it.each(["MAINTENANCE_MODE", "SYSTEM_STATE_UNAVAILABLE"])(
    "fresh %s preserves request caller input and clears only its attempt",
    async (code) => {
      const keys: string[] = [];
      let off = false;
      const create = vi.fn(async (_request: string, key: string) => {
        keys.push(key);
        if (!off) throw blocked(code);
        return { item: { id: "one" } };
      });
      const opts = options(create);
      const { result } = renderHook(() => useIdempotentContentCreate(opts));
      const input = "보존할 일정 초안";
      await act(async () => {
        await result.current.submit(input);
      });
      expect(input).toBe("보존할 일정 초안");
      expect(result.current.error).toBe(blocked(code).message);
      expect(result.current.outcomeUnknown).toBe(false);
      expect(result.current.pendingRequest).toBeUndefined();
      expect(sessionStorage.getItem(storageKey)).toBeNull();
      off = true;
      await act(async () => {
        await result.current.submit(input);
      });
      expect(keys[1]).not.toBe(keys[0]);
      expect(opts.onCreated).toHaveBeenCalledExactlyOnceWith("one");
    },
  );
  it.each([true, false])(
    "reused lost response with prior commit=%s keeps exact key/date/request and OFF replay creates one row",
    async (didCommit) => {
      const rows = new Map<string, string>();
      const keys: string[] = [];
      let step = 0;
      const create = vi.fn(async (_request: string, key: string) => {
        keys.push(key);
        ++step;
        if (step === 1) {
          if (didCommit) rows.set(key, "one");
          throw new Error("response lost");
        }
        if (step === 2) throw blocked();
        if (!rows.has(key)) rows.set(key, "one");
        return { item: { id: rows.get(key)! } };
      });
      const opts = options(create);
      const { result } = renderHook(() => useIdempotentContentCreate(opts));
      await act(async () => {
        await result.current.submit("초안");
      });
      const before = sessionStorage.getItem(storageKey);
      await act(async () => {
        await result.current.submit("초안");
      });
      expect(sessionStorage.getItem(storageKey)).toBe(before);
      expect(result.current.pendingRequest).toBe("초안");
      expect(result.current.outcomeUnknown).toBe(true);
      expect(result.current.error).toContain("이번 요청은 저장 전에 차단됐어요");
      expect(result.current.error).toContain("이전 저장 결과는 아직 확인되지 않았어요");
      await act(async () => {
        await result.current.submit("초안");
      });
      expect(new Set(keys).size).toBe(1);
      expect(rows.size).toBe(1);
      expect(opts.onCreated).toHaveBeenCalledExactlyOnceWith("one");
    },
  );
  it.each([
    new ApiRequestError("UPSTREAM", "장애", 503),
    new ApiRequestError("MAINTENANCE_MODE", "다른 상태", 500),
    new ApiRequestError("NETWORK_ERROR", "통신", 0),
    new ApiRequestError("REQUEST_TIMEOUT", "시간", 0),
    new ApiRequestError("REQUEST_ABORTED", "중단", 0),
    new ApiRequestError("UNEXPECTED_RESPONSE", "응답", 201),
  ])("keeps generic uncertain failures protected: %s", async (error) => {
    const { result } = renderHook(() =>
      useIdempotentContentCreate(
        options(async () => {
          throw error;
        }),
      ),
    );
    await act(async () => {
      await result.current.submit("초안");
    });
    expect(result.current.outcomeUnknown).toBe(true);
    expect(result.current.pendingRequest).toBe("초안");
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
  });
  it("rejects changed payload and stale TTL/date without resubmitting the original attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    let date = "2026-10-11";
    const create = vi.fn(async () => {
      throw new Error("lost");
    });
    const { result } = renderHook(() =>
      useIdempotentContentCreate(options(create, async () => date)),
    );
    await act(async () => {
      await result.current.submit("초안");
    });
    const before = sessionStorage.getItem(storageKey);
    await act(async () => {
      await result.current.submit("바꾼 초안");
    });
    expect(create).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(storageKey)).toBe(before);
    date = "2026-10-12";
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await act(async () => {
      await result.current.submit("초안");
    });
    expect(create).toHaveBeenCalledOnce();
    expect(result.current.outcomeUnknown).toBe(true);
    expect(sessionStorage.getItem(storageKey)).toBe(before);
  });
  it("does not reach create when durable draft storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const create = vi.fn(async () => ({ item: { id: "should-not-write" } }));
    const { result } = renderHook(() => useIdempotentContentCreate(options(create)));
    await act(async () => {
      await result.current.submit("초안");
    });
    expect(create).not.toHaveBeenCalled();
    expect(result.current.error).toBeDefined();
  });
  it.each([false, true])(
    "late refusal after unmount cleans fresh only; reused=%s",
    async (reused) => {
      let fail: (error: Error) => void = () => undefined;
      let call = 0;
      const create = vi.fn(async () => {
        if (reused && ++call === 1) throw new Error("lost");
        return await new Promise<{ item: { id: string } }>((_resolve, reject) => {
          fail = reject;
        });
      });
      const opts = options(create);
      const { result, unmount } = renderHook(() => useIdempotentContentCreate(opts));
      if (reused)
        await act(async () => {
          await result.current.submit("초안");
        });
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = result.current.submit("초안");
        await Promise.resolve();
      });
      const before = sessionStorage.getItem(storageKey);
      unmount();
      await act(async () => {
        fail(blocked());
        await pending;
      });
      expect(sessionStorage.getItem(storageKey)).toBe(reused ? before : null);
      expect(opts.onCreated).not.toHaveBeenCalled();
      expect(opts.onUnauthorized).not.toHaveBeenCalled();
    },
  );
  it("an auth replacement cannot expose a late maintenance error or clear a new draft", async () => {
    const failures: Array<(error: Error) => void> = [];
    const create = vi.fn(
      () =>
        new Promise<{ item: { id: string } }>((_resolve, reject) => {
          failures.push(reject);
        }),
    );
    const { result } = renderHook(() => useIdempotentContentCreate(options(create)));
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.submit("원 계정 초안");
    });
    act(() => {
      clearAuthenticatedClientState();
    });
    act(() => {
      second = result.current.submit("새 계정 초안");
    });
    const newDraft = sessionStorage.getItem(storageKey);
    await act(async () => {
      failures[0]!(blocked());
      await first;
    });
    expect(sessionStorage.getItem(storageKey)).toBe(newDraft);
    expect(result.current.error).toBeUndefined();
    await act(async () => {
      failures[1]!(new Error("new response lost"));
      await second;
    });
    expect(result.current.pendingRequest).toBe("새 계정 초안");
  });
});
