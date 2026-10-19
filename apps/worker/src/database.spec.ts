import type { DB } from "@classhub/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertPostgresRuntimeRoleMock, createDatabaseMock } = vi.hoisted(() => ({
  assertPostgresRuntimeRoleMock: vi.fn(),
  createDatabaseMock: vi.fn(),
}));

vi.mock("@classhub/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@classhub/db")>();
  return {
    ...actual,
    assertPostgresRuntimeRole: assertPostgresRuntimeRoleMock,
    createDatabase: createDatabaseMock,
  };
});

import { assertWorkerDatabaseRole, openWorkerDatabase } from "./database.js";

function workerDatabase(): Kysely<DB> {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as Kysely<DB>;
}

describe("worker database boundary", () => {
  beforeEach(() => {
    assertPostgresRuntimeRoleMock.mockReset();
    createDatabaseMock.mockReset();
  });

  it("attests the dedicated worker role", async () => {
    const database = workerDatabase();
    assertPostgresRuntimeRoleMock.mockResolvedValue(undefined);

    await expect(assertWorkerDatabaseRole(database)).resolves.toBeUndefined();
    expect(assertPostgresRuntimeRoleMock).toHaveBeenCalledWith(database, {
      expectedRole: "classhub_worker",
      runtimeName: "worker",
    });
  });

  it("opens a bounded pool only after role attestation succeeds", async () => {
    const database = workerDatabase();
    createDatabaseMock.mockReturnValue(database);
    assertPostgresRuntimeRoleMock.mockResolvedValue(undefined);

    await expect(
      openWorkerDatabase(
        "postgresql://classhub_worker:synthetic-password@database.internal/classhub",
      ),
    ).resolves.toBe(database);
    expect(createDatabaseMock).toHaveBeenCalledWith(
      "postgresql://classhub_worker:synthetic-password@database.internal/classhub",
      {
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      },
    );
    expect(database.destroy).not.toHaveBeenCalled();
  });

  it("passes a privacy-safe unexpected Pool error observer", async () => {
    const database = workerDatabase();
    const onUnexpectedPoolError = vi.fn();
    createDatabaseMock.mockReturnValue(database);
    assertPostgresRuntimeRoleMock.mockResolvedValue(undefined);

    await expect(
      openWorkerDatabase(
        "postgresql://classhub_worker:synthetic-password@database.internal/classhub",
        onUnexpectedPoolError,
      ),
    ).resolves.toBe(database);
    expect(createDatabaseMock).toHaveBeenCalledWith(
      "postgresql://classhub_worker:synthetic-password@database.internal/classhub",
      {
        connectionTimeoutMillis: 5_000,
        onUnexpectedPoolError,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      },
    );
  });

  it("destroys the pool and preserves the safe failure when attestation rejects", async () => {
    const database = workerDatabase();
    const safeFailure = new Error("worker DB 역할 검증을 완료하지 못했습니다.");
    createDatabaseMock.mockReturnValue(database);
    assertPostgresRuntimeRoleMock.mockRejectedValue(safeFailure);

    await expect(
      openWorkerDatabase(
        "postgresql://classhub_worker:synthetic-password@database.internal/classhub",
      ),
    ).rejects.toBe(safeFailure);
    expect(database.destroy).toHaveBeenCalledOnce();
  });

  it("does not expose a cleanup error after an attestation failure", async () => {
    const database = workerDatabase();
    vi.mocked(database.destroy).mockRejectedValue(
      new Error("postgresql://classhub_worker:secret@private-db/classhub"),
    );
    createDatabaseMock.mockReturnValue(database);
    assertPostgresRuntimeRoleMock.mockRejectedValue(new Error("safe attestation failure"));

    let failure: unknown;
    try {
      await openWorkerDatabase("postgresql://classhub_worker:secret@private-db/classhub");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "worker DB 역할 검증 실패 후 연결 정리에도 실패했습니다.",
    );
    expect((failure as Error).message).not.toContain("private-db");
    expect((failure as Error).message).not.toContain("secret");
  });
});
