import { describe, expect, it, vi } from "vitest";

import type { DB } from "../generated/database.js";
import type { TransactionLockManager } from "../transaction-lock.js";
import { IdempotencyService } from "./idempotency.service.js";

const IDEMPOTENCY_KEY = "A236B10B-9D13-4A61-9F54-AD14C113D335";

function fluentQuery<T extends object>(
  terminal: T,
): T & {
  select: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
} {
  const query = {
    ...terminal,
    select: vi.fn(),
    where: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

describe("IdempotencyService database platform seam", () => {
  it("uses injected lock and error adapters while preserving the existing lock identity", async () => {
    const driverError = new Error("private driver detail");
    const transactionLockManager = {
      acquire: vi.fn().mockRejectedValueOnce(driverError).mockResolvedValueOnce(undefined),
      tryAcquire: vi.fn(),
    } as unknown as TransactionLockManager<DB>;
    const errorClassifier = {
      classify: vi.fn((error: unknown) =>
        error === driverError
          ? { kind: "deadlock" as const, vendorCode: "ER_LOCK_DEADLOCK" }
          : { kind: "unknown" as const },
      ),
    };

    const requestHash = Buffer.alloc(32, 7);
    const deleteQuery = fluentQuery({ execute: vi.fn().mockResolvedValue(undefined) });
    const storedQuery = fluentQuery({
      executeTakeFirst: vi.fn().mockResolvedValue({
        request_hash: requestHash,
        response_body_json: { ok: true },
        response_status: 200,
      }),
    });
    const transaction = {
      deleteFrom: vi.fn(() => deleteQuery),
      selectFrom: vi.fn(() => storedQuery),
    };
    const executeTransaction = vi.fn(
      async (operation: (value: typeof transaction) => Promise<unknown>) => operation(transaction),
    );
    const database = {
      transaction: vi.fn(() => ({ execute: executeTransaction })),
    };
    const service = new IdempotencyService(database as never, {
      errorClassifier,
      transactionLockManager,
    });
    const operation = vi.fn();

    await expect(
      service.execute(
        {
          actorUserId: "user-1",
          idempotencyKey: IDEMPOTENCY_KEY,
          requestHash,
          routeKey: "POST /classes",
        },
        operation,
      ),
    ).resolves.toEqual({ body: { ok: true }, replayed: true, statusCode: 200 });

    expect(executeTransaction).toHaveBeenCalledTimes(2);
    expect(transactionLockManager.acquire).toHaveBeenNthCalledWith(
      1,
      transaction,
      '["user-1","POST /classes","a236b10b-9d13-4a61-9f54-ad14c113d335"]',
    );
    expect(errorClassifier.classify).toHaveBeenCalledWith(driverError);
    expect(operation).not.toHaveBeenCalled();
  });
});
