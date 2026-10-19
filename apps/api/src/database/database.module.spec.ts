import type { DB } from "@classhub/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createDatabaseMock } = vi.hoisted(() => ({
  createDatabaseMock: vi.fn(),
}));

vi.mock("@classhub/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@classhub/db")>();
  return { ...actual, createDatabase: createDatabaseMock };
});

import { assertApplicationDatabaseRole, openApplicationDatabase } from "./database.module.js";

interface ApplicationDatabaseIdentity {
  current_role_name: string;
  has_role_membership: boolean;
  is_bypass_rls_role: boolean;
  is_create_database_role: boolean;
  is_create_role_role: boolean;
  is_inherit_role: boolean;
  is_replication_role: boolean;
  is_superuser: boolean;
  session_role_name: string;
}

const safeIdentity: ApplicationDatabaseIdentity = {
  current_role_name: "classhub_app",
  has_role_membership: false,
  is_bypass_rls_role: false,
  is_create_database_role: false,
  is_create_role_role: false,
  is_inherit_role: false,
  is_replication_role: false,
  is_superuser: false,
  session_role_name: "classhub_app",
};

function databaseWithIdentity(overrides: Partial<ApplicationDatabaseIdentity> = {}): Kysely<DB> {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    selectNoFrom: vi.fn(() => ({
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue({ ...safeIdentity, ...overrides }),
    })),
  } as unknown as Kysely<DB>;
}

describe("application database boundary", () => {
  beforeEach(() => {
    createDatabaseMock.mockReset();
  });

  it("opens the runtime pool with bounded connection and query deadlines", async () => {
    const database = databaseWithIdentity();
    createDatabaseMock.mockReturnValue(database);

    await expect(
      openApplicationDatabase("postgresql://classhub_app:secret@database/classhub"),
    ).resolves.toBe(database);
    expect(createDatabaseMock).toHaveBeenCalledWith(
      "postgresql://classhub_app:secret@database/classhub",
      {
        connectionTimeoutMillis: 5_000,
        onUnexpectedPoolError: expect.any(Function),
        query_timeout: 5_000,
        statement_timeout: 5_000,
      },
    );
    expect(database.destroy).not.toHaveBeenCalled();
  });

  it("destroys the bounded pool when the startup role assertion fails", async () => {
    const database = databaseWithIdentity({ current_role_name: "classhub_migrator" });
    createDatabaseMock.mockReturnValue(database);

    await expect(
      openApplicationDatabase("postgresql://classhub_app:secret@database/classhub"),
    ).rejects.toThrow("classhub_app");
    expect(database.destroy).toHaveBeenCalledOnce();
  });

  it("does not retain a cleanup error or connection secret after attestation fails", async () => {
    const database = databaseWithIdentity({ current_role_name: "classhub_migrator" });
    vi.mocked(database.destroy).mockRejectedValue(
      new Error("postgresql://classhub_app:synthetic-secret@private-db/classhub"),
    );
    createDatabaseMock.mockReturnValue(database);

    let failure: unknown;
    try {
      await openApplicationDatabase(
        "postgresql://classhub_app:synthetic-secret@private-db/classhub",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("API DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    expect((failure as Error).message).not.toContain("private-db");
    expect((failure as Error).message).not.toContain("synthetic-secret");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("accepts only the exact unprivileged application role", async () => {
    await expect(assertApplicationDatabaseRole(databaseWithIdentity())).resolves.toBeUndefined();
  });

  it.each([
    ["current_user", { current_role_name: "classhub_migrator" }],
    ["session_user", { session_role_name: "classhub_bootstrap" }],
  ])("rejects a mismatched %s", async (_label, overrides) => {
    await expect(assertApplicationDatabaseRole(databaseWithIdentity(overrides))).rejects.toThrow(
      "classhub_app",
    );
  });

  it.each([
    ["superuser", { is_superuser: true }],
    ["role membership", { has_role_membership: true }],
    ["createdb", { is_create_database_role: true }],
    ["createrole", { is_create_role_role: true }],
    ["inherit", { is_inherit_role: true }],
    ["replication", { is_replication_role: true }],
    ["bypassrls", { is_bypass_rls_role: true }],
  ])("rejects the %s privilege", async (_label, overrides) => {
    await expect(assertApplicationDatabaseRole(databaseWithIdentity(overrides))).rejects.toThrow(
      "최소 권한",
    );
  });
});
