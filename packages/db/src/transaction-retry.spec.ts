import { describe, expect, it, vi } from "vitest";

import type { DatabaseErrorClassifier } from "./database-error-classifier.js";
import { isRetryableSerializationError, withSerializationRetry } from "./transaction-retry.js";

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(`postgres ${code}`), { code });
}

// 교착 자체는 재현하기 어렵지만 재시도 규칙은 결정적으로 검증할 수 있다.
const noSleep = (): Promise<void> => Promise.resolve();

describe("isRetryableSerializationError", () => {
  it("accepts only deadlock and serialization failures", () => {
    expect(isRetryableSerializationError(postgresError("40P01"))).toBe(true);
    expect(isRetryableSerializationError(postgresError("40001"))).toBe(true);
    // 고유 제약 위반은 다시 시도해도 같은 결과다.
    expect(isRetryableSerializationError(postgresError("23505"))).toBe(false);
    expect(isRetryableSerializationError(new Error("boom"))).toBe(false);
    expect(isRetryableSerializationError(null)).toBe(false);
    expect(isRetryableSerializationError({ code: 40_001 })).toBe(false);
  });

  it("uses an injected database classifier without changing the PostgreSQL default", () => {
    const mariaDbClassifier: DatabaseErrorClassifier = {
      classify: () => ({ kind: "deadlock", vendorCode: "ER_LOCK_DEADLOCK" }),
    };

    expect(isRetryableSerializationError(new Error("driver detail"), mariaDbClassifier)).toBe(true);
    expect(isRetryableSerializationError(new Error("driver detail"))).toBe(false);
  });

  it("does not retry a lock timeout without proof that the whole transaction rolled back", () => {
    const mariaDbClassifier: DatabaseErrorClassifier = {
      classify: () => ({ kind: "lock_timeout", vendorCode: "ER_LOCK_WAIT_TIMEOUT" }),
    };

    expect(isRetryableSerializationError(new Error("driver detail"), mariaDbClassifier)).toBe(
      false,
    );
  });
});

describe("withSerializationRetry", () => {
  it("returns the first result without retrying when nothing fails", async () => {
    const operation = vi.fn(async () => "ok");
    await expect(withSerializationRetry(operation, { sleep: noSleep })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries a deadlock and returns the later success", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(postgresError("40P01"))
      .mockResolvedValueOnce("recovered");
    const onRetry = vi.fn();

    await expect(withSerializationRetry(operation, { onRetry, sleep: noSleep })).resolves.toBe(
      "recovered",
    );
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, "40P01");
  });

  it("gives up after the attempt limit and rethrows the original error", async () => {
    const deadlock = postgresError("40P01");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(deadlock);

    // 원래 오류를 그대로 올려야 상위의 도메인 처리가 유지된다.
    await expect(
      withSerializationRetry(operation, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toBe(deadlock);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error that a second attempt cannot fix", async () => {
    const conflict = postgresError("23505");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(conflict);

    await expect(withSerializationRetry(operation, { sleep: noSleep })).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("backs off for longer on each successive collision", async () => {
    const waited: number[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(postgresError("40001"))
      .mockRejectedValueOnce(postgresError("40001"))
      .mockResolvedValueOnce("done");

    await withSerializationRetry(operation, {
      baseDelayMs: 10,
      maxAttempts: 5,
      sleep: async (milliseconds) => {
        waited.push(milliseconds);
      },
    });

    expect(waited).toHaveLength(2);
    // 10~20 다음 20~30. 지터가 붙으므로 구간으로 확인한다 — 두 요청이 같은
    // 간격으로 재시도하면 다시 부딪히기 때문에 지터가 필요하다.
    expect(waited[0]).toBeGreaterThanOrEqual(10);
    expect(waited[0]).toBeLessThan(20);
    expect(waited[1]).toBeGreaterThanOrEqual(20);
    expect(waited[1]).toBeLessThan(30);
  });

  it("retries according to an injected adapter and reports only its safe vendor code", async () => {
    const driverError = new Error("private MariaDB driver detail");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(driverError)
      .mockResolvedValueOnce("recovered");
    const onRetry = vi.fn();
    const mariaDbClassifier: DatabaseErrorClassifier = {
      classify: (error) =>
        error === driverError
          ? { kind: "deadlock", vendorCode: "ER_LOCK_DEADLOCK" }
          : { kind: "unknown" },
    };

    await expect(
      withSerializationRetry(operation, {
        errorClassifier: mariaDbClassifier,
        onRetry,
        sleep: noSleep,
      }),
    ).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, "ER_LOCK_DEADLOCK");
    expect(onRetry).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("private"));
  });
});
