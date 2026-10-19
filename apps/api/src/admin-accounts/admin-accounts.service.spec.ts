import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";

import { AdminAccountsService } from "./admin-accounts.service.js";

vi.mock("@classhub/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@classhub/db")>();
  return {
    ...actual,
    hashPassword: vi.fn(async () => "test-password-hash"),
  };
});

vi.mock("kysely", () => ({
  sql: () => ({ execute: vi.fn(async () => undefined) }),
}));

function suspendedAccountDatabase() {
  const select = {
    executeTakeFirst: vi.fn(async () => ({ id: "18", status: "suspended" })),
    forUpdate: vi.fn(() => select),
    select: vi.fn(() => select),
    where: vi.fn(() => select),
  };
  const transaction = {
    selectFrom: vi.fn(() => select),
    updateTable: vi.fn(),
  };
  const database = {
    transaction: vi.fn(() => ({
      execute: (work: (value: typeof transaction) => unknown) => work(transaction),
    })),
  };
  return { database: database as never, transaction };
}

describe("AdminAccountsService recovery status contract", () => {
  it("requires explicit activation before resetting suspended credentials", async () => {
    const { database, transaction } = suspendedAccountDatabase();
    const service = new AdminAccountsService(database, new ConfigService());

    await expect(
      service.resetCredentials("18", "분실 신고", "17", "00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({ message: "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID" });
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });

  it("requires explicit activation before resetting suspended MFA", async () => {
    const { database, transaction } = suspendedAccountDatabase();
    const service = new AdminAccountsService(database, new ConfigService());

    await expect(
      service.resetMfa("18", "기기 분실", "17", "00000000-0000-4000-8000-000000000002"),
    ).rejects.toMatchObject({ message: "ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID" });
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });
});
