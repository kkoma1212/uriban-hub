import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  sqlTag: vi.fn(),
}));

vi.mock("kysely", () => ({
  sql: (fragments: TemplateStringsArray, ...parameters: unknown[]) => {
    mocks.sqlTag(fragments, parameters);
    return { execute: mocks.execute };
  },
}));

import { createPostgresTransactionLockManager } from "./transaction-lock.js";

const transaction = {} as never;
const postgresTransactionLockManager = createPostgresTransactionLockManager();

function latestSqlText(): string {
  const call = mocks.sqlTag.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call?.[0] as TemplateStringsArray).join("?").replaceAll(/\s+/gu, " ").trim();
}

describe("postgresTransactionLockManager", () => {
  beforeEach(() => {
    mocks.execute.mockReset();
    mocks.sqlTag.mockReset();
  });

  it("acquires an exclusive transaction lock without changing the caller identity", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    const identity = '["user-1","route","key"]';

    await postgresTransactionLockManager.acquire(transaction, identity);

    expect(latestSqlText()).toContain("pg_advisory_xact_lock(hashtextextended(?, 0))");
    expect(mocks.sqlTag.mock.calls.at(-1)?.[1]).toEqual([identity]);
    expect(mocks.execute).toHaveBeenCalledWith(transaction);
  });

  it("uses the shared transaction-scoped primitive only when requested", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await postgresTransactionLockManager.acquire(transaction, "class:7", "shared");

    expect(latestSqlText()).toContain("pg_advisory_xact_lock_shared");
  });

  it.each([true, false])("returns a try-lock result of %s", async (acquired) => {
    mocks.execute.mockResolvedValue({ rows: [{ acquired }] });

    await expect(
      postgresTransactionLockManager.tryAcquire(transaction, "job:retention"),
    ).resolves.toBe(acquired);
    expect(latestSqlText()).toContain("pg_try_advisory_xact_lock");
  });

  it("supports a non-blocking shared lock", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ acquired: true }] });

    await postgresTransactionLockManager.tryAcquire(transaction, "job:reader", "shared");

    expect(latestSqlText()).toContain("pg_try_advisory_xact_lock_shared");
  });

  it("rejects an empty identity before executing SQL", async () => {
    await expect(postgresTransactionLockManager.acquire(transaction, "")).rejects.toThrow(
      "Transaction lock identity must not be empty.",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the driver does not return a boolean try-lock result", async () => {
    mocks.execute.mockResolvedValue({ rows: [{}] });

    await expect(
      postgresTransactionLockManager.tryAcquire(transaction, "job:retention"),
    ).rejects.toThrow("Database transaction lock result is invalid.");
  });

  it("preserves the original database failure", async () => {
    const databaseError = new Error("connection lost");
    mocks.execute.mockRejectedValue(databaseError);

    await expect(postgresTransactionLockManager.acquire(transaction, "job:retention")).rejects.toBe(
      databaseError,
    );
  });
});
