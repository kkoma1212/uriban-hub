import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

import {
  assertPostgresRuntimeRole,
  POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR,
  PostgresRuntimeRoleAttestationError,
} from "./postgres-runtime-role.js";

interface RuntimeRoleIdentity {
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

const options = {
  expectedRole: "classhub_worker",
  runtimeName: "worker",
} as const;

const safeIdentity: RuntimeRoleIdentity = {
  current_role_name: "classhub_worker",
  has_role_membership: false,
  is_bypass_rls_role: false,
  is_create_database_role: false,
  is_create_role_role: false,
  is_inherit_role: false,
  is_replication_role: false,
  is_superuser: false,
  session_role_name: "classhub_worker",
};

function databaseWithResult(result: unknown): Kysely<object> {
  return {
    selectNoFrom: vi.fn(() => ({
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue(result),
    })),
  } as unknown as Kysely<object>;
}

function databaseWithIdentity(overrides: Partial<RuntimeRoleIdentity> = {}): Kysely<object> {
  return databaseWithResult({ ...safeIdentity, ...overrides });
}

function databaseWithFailure(error: Error): Kysely<object> {
  return {
    selectNoFrom: vi.fn(() => ({
      executeTakeFirstOrThrow: vi.fn().mockRejectedValue(error),
    })),
  } as unknown as Kysely<object>;
}

describe("PostgreSQL runtime role attestation", () => {
  it("accepts only the exact least-privilege runtime identity", async () => {
    await expect(
      assertPostgresRuntimeRole(databaseWithIdentity(), options),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["current_user", { current_role_name: "classhub_migrator" }],
    ["session_user", { session_role_name: "classhub_bootstrap" }],
  ] satisfies [string, Partial<RuntimeRoleIdentity>][])(
    "rejects a mismatched %s",
    async (_label, overrides) => {
      await expect(
        assertPostgresRuntimeRole(databaseWithIdentity(overrides), options),
      ).rejects.toMatchObject({
        code: POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR,
        reason: "identity_rejected",
      });
    },
  );

  it.each([
    ["superuser", { is_superuser: true }],
    ["createdb", { is_create_database_role: true }],
    ["createrole", { is_create_role_role: true }],
    ["replication", { is_replication_role: true }],
    ["bypassrls", { is_bypass_rls_role: true }],
    ["inherit", { is_inherit_role: true }],
    ["role membership", { has_role_membership: true }],
  ] satisfies [string, Partial<RuntimeRoleIdentity>][])(
    "rejects the %s privilege or role escalation path",
    async (_label, overrides) => {
      await expect(
        assertPostgresRuntimeRole(databaseWithIdentity(overrides), options),
      ).rejects.toThrow("classhub_worker 최소 권한 role");
    },
  );

  it.each([
    ["a missing catalog role", { ...safeIdentity, is_superuser: undefined }],
    ["a malformed membership result", { ...safeIdentity, has_role_membership: null }],
  ])("fails closed for %s", async (_label, identity) => {
    await expect(
      assertPostgresRuntimeRole(databaseWithResult(identity), options),
    ).rejects.toMatchObject({ reason: "identity_rejected" });
  });

  it("converts database errors to a safe attestation failure without retaining the cause", async () => {
    const leakedDetail =
      "connection failed for postgresql://classhub_worker:synthetic-password@private-db/classhub";

    let failure: unknown;
    try {
      await assertPostgresRuntimeRole(databaseWithFailure(new Error(leakedDetail)), options);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PostgresRuntimeRoleAttestationError);
    expect(failure).toMatchObject({
      code: POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR,
      reason: "query_failed",
    });
    expect((failure as Error).message).toBe("worker DB 역할 검증을 완료하지 못했습니다.");
    expect((failure as Error).message).not.toContain("synthetic-password");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
