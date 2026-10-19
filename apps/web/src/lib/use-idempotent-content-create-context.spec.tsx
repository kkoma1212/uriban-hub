import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { idempotentCreateStorageKey } from "./idempotent-create";
import { clearAuthenticatedClientState } from "./authenticated-client-state";
import { useIdempotentContentCreate } from "./use-idempotent-content-create";

const isRequest = (value: unknown): value is string => typeof value === "string";

afterEach(() => {
  sessionStorage.clear();
});

it("does not restore cleared private drafts after unmount and a late network failure", async () => {
  let fail!: (error: Error) => void;
  const create = vi.fn(
    () =>
      new Promise<{ item: { id: string } }>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const { result, unmount } = renderHook(() =>
    useIdempotentContentCreate({
      actionLabel: "일정 등록",
      create,
      isRequest,
      membershipId: "class-a-member",
      onCreated: vi.fn(),
      onUnauthorized: vi.fn(),
      readServerToday: async () => "2026-10-11",
      resource: "schedules",
      serverToday: "2026-10-11",
    }),
  );
  let submission!: Promise<void>;
  act(() => {
    submission = result.current.submit("로그아웃 전 비공개 일정");
  });
  expect(
    sessionStorage.getItem(idempotentCreateStorageKey("schedules", "class-a-member")),
  ).not.toBeNull();
  unmount();
  clearAuthenticatedClientState();
  await act(async () => {
    fail(new Error("connection lost"));
    await submission;
  });
  expect(
    sessionStorage.getItem(idempotentCreateStorageKey("schedules", "class-a-member")),
  ).toBeNull();
});

it("does not navigate to an old class item when creation finishes after membership changes", async () => {
  let finish!: (value: { item: { id: string } }) => void;
  const create = vi.fn(
    () =>
      new Promise<{ item: { id: string } }>((resolve) => {
        finish = resolve;
      }),
  );
  const onCreated = vi.fn();
  const { result, rerender } = renderHook(
    ({ membershipId }) =>
      useIdempotentContentCreate({
        actionLabel: "일정 등록",
        create,
        isRequest,
        membershipId,
        onCreated,
        onUnauthorized: vi.fn(),
        readServerToday: async () => "2026-10-11",
        resource: "schedules",
        serverToday: "2026-10-11",
      }),
    { initialProps: { membershipId: "class-a-member" } },
  );
  let submission!: Promise<void>;
  act(() => {
    submission = result.current.submit("이전 반 일정");
  });
  expect(create).toHaveBeenCalledTimes(1);
  rerender({ membershipId: "class-b-member" });
  await act(async () => {
    finish({ item: { id: "old-class-schedule" } });
    await submission;
  });
  expect(onCreated).not.toHaveBeenCalled();
  expect(result.current.pendingRequest).toBeUndefined();
  expect(
    sessionStorage.getItem(idempotentCreateStorageKey("schedules", "class-b-member")),
  ).toBeNull();
});

it("preserves an ambiguous old-class attempt without locking the new-class form", async () => {
  let fail!: (error: Error) => void;
  const create = vi.fn(
    () =>
      new Promise<{ item: { id: string } }>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const { result, rerender } = renderHook(
    ({ membershipId }) =>
      useIdempotentContentCreate({
        actionLabel: "일정 등록",
        create,
        isRequest,
        membershipId,
        onCreated: vi.fn(),
        onUnauthorized: vi.fn(),
        readServerToday: async () => "2026-10-11",
        resource: "schedules",
        serverToday: "2026-10-11",
      }),
    { initialProps: { membershipId: "class-a-member" } },
  );
  let submission!: Promise<void>;
  act(() => {
    submission = result.current.submit("이전 반 일정");
  });
  const originalAttempt = sessionStorage.getItem(
    idempotentCreateStorageKey("schedules", "class-a-member"),
  );
  expect(originalAttempt).not.toBeNull();
  rerender({ membershipId: "class-b-member" });
  await act(async () => {
    fail(new Error("connection lost"));
    await submission;
  });
  expect(result.current.outcomeUnknown).toBe(false);
  expect(result.current.pendingRequest).toBeUndefined();
  expect(result.current.error).toBeUndefined();
  expect(sessionStorage.getItem(idempotentCreateStorageKey("schedules", "class-a-member"))).toBe(
    originalAttempt,
  );
  expect(
    sessionStorage.getItem(idempotentCreateStorageKey("schedules", "class-b-member")),
  ).toBeNull();
});
