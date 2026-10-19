import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../api/auth";
import {
  clearIdempotentCreateAttempt,
  idempotentCreateStorageKey,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareIdempotentCreateAttempt,
  prepareServerDatedIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unknownMutationResultMessage,
} from "./idempotent-create";

interface TestRequest {
  title: string;
}

function isTestRequest(value: unknown): value is TestRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TestRequest>).title === "string"
  );
}

describe("idempotent create attempt", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores the same request and key after a page remount", () => {
    const storageKey = idempotentCreateStorageKey("notices", "membership-1");
    const first = prepareIdempotentCreateAttempt(storageKey, { title: "가정통신문" });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") throw new Error("첫 요청을 준비하지 못했습니다.");
    expect(first.reused).toBe(false);

    const restored = readIdempotentCreateAttempt(storageKey, isTestRequest);
    expect(restored).toEqual(first.attempt);
    const retry = prepareIdempotentCreateAttempt(
      storageKey,
      { title: "가정통신문" },
      restored,
      first.attempt.startedAt + 1_000,
    );
    expect(retry).toMatchObject({ kind: "ready", reused: true });
    if (retry.kind !== "ready") throw new Error("재시도 요청을 준비하지 못했습니다.");
    expect(retry.attempt.idempotencyKey).toBe(first.attempt.idempotencyKey);
  });

  it("blocks a changed body and a retry outside the protected window", () => {
    const storageKey = idempotentCreateStorageKey("schedules", "membership-1");
    const randomUuid = vi.spyOn(crypto, "randomUUID");
    const first = prepareIdempotentCreateAttempt(
      storageKey,
      { title: "수학 시험" },
      undefined,
      1_000,
    );
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") throw new Error("첫 요청을 준비하지 못했습니다.");

    expect(
      prepareIdempotentCreateAttempt(storageKey, { title: "국어 시험" }, first.attempt, 2_000).kind,
    ).toBe("mismatch");
    expect(
      prepareIdempotentCreateAttempt(
        storageKey,
        first.attempt.request,
        first.attempt,
        1_000 + 23 * 60 * 60 * 1_000,
      ).kind,
    ).toBe("expired");
    expect(randomUuid).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the browser clock rolls back or the authoritative server date changes", () => {
    const storageKey = idempotentCreateStorageKey("notices", "membership-1");
    const first = prepareServerDatedIdempotentCreateAttempt(
      storageKey,
      { title: "시계 안전성" },
      "2026-07-20",
      undefined,
      1_000,
    );
    if (first.kind !== "ready") throw new Error("첫 요청을 준비하지 못했습니다.");

    expect(
      prepareServerDatedIdempotentCreateAttempt(
        storageKey,
        first.attempt.request,
        "2026-07-20",
        first.attempt,
        999,
      ).kind,
    ).toBe("expired");
    expect(
      prepareServerDatedIdempotentCreateAttempt(
        storageKey,
        first.attempt.request,
        "2026-07-21",
        first.attempt,
        1_000 + 22 * 60 * 60 * 1_000,
      ).kind,
    ).toBe("expired");
  });

  it("does not authorize a POST when the retry attempt cannot be persisted", () => {
    const storageKey = idempotentCreateStorageKey("notices", "membership-1");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage denied", "SecurityError");
    });

    expect(prepareIdempotentCreateAttempt(storageKey, { title: "저장 차단" })).toEqual({
      kind: "storage-unavailable",
    });
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("does not let an older completion clear or overwrite a newer attempt", () => {
    const storageKey = idempotentCreateStorageKey("notices", "membership-1");
    const first = prepareIdempotentCreateAttempt(storageKey, { title: "첫 시도" }, undefined, 1);
    if (first.kind !== "ready") throw new Error("첫 요청을 준비하지 못했습니다.");
    clearIdempotentCreateAttempt(storageKey, first.attempt.idempotencyKey);
    const second = prepareIdempotentCreateAttempt(storageKey, { title: "새 시도" }, undefined, 2);
    if (second.kind !== "ready") throw new Error("새 요청을 준비하지 못했습니다.");

    expect(persistIdempotentCreateAttempt(storageKey, first.attempt)).toBe(false);
    clearIdempotentCreateAttempt(storageKey, first.attempt.idempotencyKey);
    expect(readIdempotentCreateAttempt(storageKey, isTestRequest)).toEqual(second.attempt);
  });

  it("clears an attempt explicitly and classifies only ambiguous failures as unknown", () => {
    const storageKey = idempotentCreateStorageKey("supplies", "membership-1");
    prepareIdempotentCreateAttempt(storageKey, { title: "준비물" });
    clearIdempotentCreateAttempt(storageKey);
    expect(readIdempotentCreateAttempt(storageKey, isTestRequest)).toBeUndefined();

    expect(isMutationOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
    // apiFetch normalizes network failures into this ApiRequestError. The
    // request may have reached the server, so it must stay "unknown" or a
    // retry could create a duplicate.
    expect(isMutationOutcomeUnknown(new ApiRequestError("NETWORK_ERROR", "연결 실패", 0))).toBe(
      true,
    );
    expect(isMutationOutcomeUnknown(new ApiRequestError("REQUEST_TIMEOUT", "시간 초과", 0))).toBe(
      true,
    );
    expect(isMutationOutcomeUnknown(new ApiRequestError("REQUEST_ABORTED", "요청 취소", 0))).toBe(
      true,
    );
    expect(isMutationOutcomeUnknown(new ApiRequestError("UPSTREAM", "장애", 503))).toBe(true);
    expect(
      isMutationOutcomeUnknown(new ApiRequestError("UNEXPECTED_RESPONSE", "응답 오류", 201)),
    ).toBe(true);
    expect(isMutationOutcomeUnknown(new ApiRequestError("VALIDATION", "확인 필요", 422))).toBe(
      false,
    );
    expect(unknownMutationResultMessage("공지 등록 요청")).toContain("두 번 저장되지 않고");
  });
});
