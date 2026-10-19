import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { ApiRequestError } from "../api/auth";
import { useIdempotentContentCreate } from "./use-idempotent-content-create";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
it("최초 일정 등록의 401은 시도를 지우고 로그인 이동 콜백을 한 번 호출한다", async () => {
  const create = vi
      .fn()
      .mockRejectedValue(new ApiRequestError("UNAUTHENTICATED", "로그인이 필요합니다.", 401)),
    onUnauthorized = vi.fn(),
    onCreated = vi.fn(),
    isRequest = (x: unknown): x is { title: string } =>
      typeof x === "object" && x !== null && "title" in x;
  const { result } = renderHook(() =>
    useIdempotentContentCreate({
      actionLabel: "일정 추가 요청",
      create,
      isRequest,
      membershipId: "member-a",
      onUnauthorized,
      onCreated,
      readServerToday: async () => "2026-10-11",
      resource: "schedules",
      serverToday: "2026-10-11",
    }),
  );
  await act(async () => {
    await result.current.submit({ title: "일정 검수" });
  });
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(onCreated).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);
  expect(result.current.outcomeUnknown).toBe(false);
  expect(sessionStorage.length).toBe(0);
});

it("결과불명 실패의 재시도는 같은 키를 사용하고 날짜 재검증 401은 쓰기를 막는다", async () => {
  const create = vi.fn().mockRejectedValue(new Error("connection lost"));
  const readServerToday = vi.fn().mockResolvedValue("2026-10-11");
  const onUnauthorized = vi.fn();
  const isRequest = (x: unknown): x is string => typeof x === "string";
  const { result } = renderHook(() =>
    useIdempotentContentCreate({
      actionLabel: "일정 추가 요청",
      create,
      isRequest,
      membershipId: "member-a",
      onUnauthorized,
      onCreated: vi.fn(),
      readServerToday,
      resource: "schedules",
      serverToday: "2026-10-11",
    }),
  );
  await act(async () => {
    await result.current.submit("일정");
  });
  expect(result.current.outcomeUnknown).toBe(true);
  await act(async () => {
    await result.current.submit("일정");
  });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]?.[1]).toEqual(expect.any(String));
  expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
  readServerToday.mockRejectedValue(
    new ApiRequestError("UNAUTHENTICATED", "로그인이 필요합니다.", 401),
  );
  await act(async () => {
    await result.current.submit("일정");
  });
  expect(create).toHaveBeenCalledTimes(2);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(result.current.busy).toBe(false);
  expect(result.current.outcomeUnknown).toBe(false);
});
