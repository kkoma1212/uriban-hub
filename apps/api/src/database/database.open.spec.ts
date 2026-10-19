import type { DB } from "@classhub/db";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
}));

vi.mock("@classhub/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@classhub/db")>()),
  createDatabase: databaseMocks.createDatabase,
}));

import { openApplicationDatabase } from "./database.module.js";

function databaseThatFailsIdentityCheck(
  identityError: Error,
  destroy: () => Promise<void>,
): Kysely<DB> {
  return {
    destroy,
    selectNoFrom: vi.fn(() => ({
      executeTakeFirstOrThrow: vi.fn().mockRejectedValue(identityError),
    })),
  } as unknown as Kysely<DB>;
}

describe("application database startup cleanup", () => {
  it("destroys the pool and returns a safe role-attestation failure", async () => {
    const identityError = new Error(
      "postgresql://classhub_app:synthetic-secret@private-db/classhub",
    );
    const destroy = vi.fn().mockResolvedValue(undefined);
    databaseMocks.createDatabase.mockReturnValueOnce(
      databaseThatFailsIdentityCheck(identityError, destroy),
    );

    let failure: unknown;
    try {
      await openApplicationDatabase("postgresql://classhub_migrator:test@db.internal/classhub");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "POSTGRES_RUNTIME_ROLE_ATTESTATION_FAILED",
      message: "API DB 역할 검증을 완료하지 못했습니다.",
      name: "PostgresRuntimeRoleAttestationError",
      reason: "query_failed",
    });
    expect(JSON.stringify(failure)).not.toContain("private-db");
    expect(JSON.stringify(failure)).not.toContain("synthetic-secret");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not retain a raw cleanup failure when pool destruction also fails", async () => {
    const identityError = new Error("simulated identity query failure");
    const cleanupError = new Error(
      "postgresql://classhub_app:synthetic-secret@private-db/classhub",
    );
    const destroy = vi.fn().mockRejectedValue(cleanupError);
    databaseMocks.createDatabase.mockReturnValueOnce(
      databaseThatFailsIdentityCheck(identityError, destroy),
    );

    let failure: unknown;
    try {
      await openApplicationDatabase("postgresql://classhub_migrator:test@db.internal/classhub");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("API DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    expect((failure as Error).message).not.toContain("private-db");
    expect((failure as Error).message).not.toContain("synthetic-secret");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
