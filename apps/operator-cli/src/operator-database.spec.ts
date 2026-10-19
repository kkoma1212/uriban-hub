import { type DB } from "@classhub/db";
import { type Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { assertOperatorDatabaseRole, requireOperatorDatabaseUrl } from "./operator-database.js";

const VALID_PRODUCTION_OPERATOR_URL =
  "postgresql://classhub_operator:synthetic-password@db.internal:5432/classhub?sslmode=verify-full";

interface OperatorRoleIdentity {
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

function databaseWithRoles(
  currentRoleName: string,
  sessionRoleName = currentRoleName,
  overrides: Partial<OperatorRoleIdentity> = {},
): Kysely<DB> {
  return {
    selectNoFrom: vi.fn(() => ({
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue({
        current_role_name: currentRoleName,
        has_role_membership: false,
        is_bypass_rls_role: false,
        is_create_database_role: false,
        is_create_role_role: false,
        is_inherit_role: false,
        is_replication_role: false,
        is_superuser: false,
        session_role_name: sessionRoleName,
        ...overrides,
      }),
    })),
  } as unknown as Kysely<DB>;
}

describe("operator database boundary", () => {
  it("requires the MariaDB operator identity and never falls back to PostgreSQL", () => {
    const url = "mysql://classhub_operator:synthetic-password@localhost:13307/classhub_qa";
    const context = { environment: { DATABASE_ENGINE: "mariadb" } };
    expect(requireOperatorDatabaseUrl(url, context)).toBe(url);
    expect(() => requireOperatorDatabaseUrl(VALID_PRODUCTION_OPERATOR_URL, context)).toThrow();
    expect(() =>
      requireOperatorDatabaseUrl(url.replace("classhub_operator", "classhub_app"), context),
    ).toThrow();
    expect(() =>
      requireOperatorDatabaseUrl(url, { environment: { DATABASE_ENGINE: "postgres" } }),
    ).toThrow();
    expect(() =>
      requireOperatorDatabaseUrl(url, { environment: { DATABASE_ENGINE: "sqlite" } }),
    ).toThrow();
  });
  it("requires the dedicated operator connection string", () => {
    expect(() => requireOperatorDatabaseUrl(undefined)).toThrow("OPERATOR_DATABASE_URL");
    expect(() => requireOperatorDatabaseUrl("   ")).toThrow("OPERATOR_DATABASE_URL");
    expect(requireOperatorDatabaseUrl("postgresql://operator@example/classhub")).toBe(
      "postgresql://operator@example/classhub",
    );
  });

  it("allows the local plaintext URL outside production", () => {
    const localUrl = "postgresql://classhub_operator:password@127.0.0.1:5432/classhub_dev";

    expect(
      requireOperatorDatabaseUrl(localUrl, {
        environment: {},
        nodeEnvironment: "development",
      }),
    ).toBe(localUrl);
  });

  it("accepts only the exact operator role and verify-full in production", () => {
    expect(
      requireOperatorDatabaseUrl(VALID_PRODUCTION_OPERATOR_URL, {
        environment: {},
        nodeEnvironment: "production",
      }),
    ).toBe(VALID_PRODUCTION_OPERATOR_URL);

    expect(() =>
      requireOperatorDatabaseUrl(
        "postgresql://classhub_migrator:password@db.internal/classhub?sslmode=verify-full",
        { environment: {}, nodeEnvironment: "production" },
      ),
    ).toThrow("classhub_operator database role");
  });

  it.each([
    "postgresql://classhub_operator:password@db.internal/classhub?sslmode=disable",
    "postgresql://classhub_operator:password@db.internal/classhub?sslmode=require&uselibpqcompat=true",
    "postgresql://classhub_operator:password@db.internal/classhub?sslmode=verify-full&ssl=0",
    "postgresql://classhub_operator:password@db.internal/classhub?sslmode=verify-full&service=privileged-service",
  ])("rejects a production TLS downgrade or connection override query", (databaseUrl) => {
    expect(() =>
      requireOperatorDatabaseUrl(databaseUrl, {
        environment: {},
        nodeEnvironment: "production",
      }),
    ).toThrow("canonical sslmode=verify-full");
  });

  it.each([
    "postgresql://classhub_operator:password@127.0.0.1/classhub?sslmode=verify-full",
    "postgresql://classhub_operator@db.internal/classhub?sslmode=verify-full",
  ])("rejects an incomplete or local production authority", (databaseUrl) => {
    expect(() =>
      requireOperatorDatabaseUrl(databaseUrl, {
        environment: {},
        nodeEnvironment: "production",
      }),
    ).toThrow("explicit remote hostname, nonblank password, and database name");
  });

  it("rejects process-wide TLS verification overrides in production", () => {
    expect(() =>
      requireOperatorDatabaseUrl(VALID_PRODUCTION_OPERATOR_URL, {
        environment: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        nodeEnvironment: "production",
      }),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(() =>
      requireOperatorDatabaseUrl(VALID_PRODUCTION_OPERATOR_URL, {
        environment: { PGSSLMODE: "disable" },
        nodeEnvironment: "production",
      }),
    ).toThrow("PGSSL*");
  });

  it("accepts only matching PostgreSQL current_user and session_user roles", async () => {
    await expect(assertOperatorDatabaseRole(databaseWithRoles("classhub_operator"))).resolves.toBe(
      undefined,
    );
    await expect(
      assertOperatorDatabaseRole(databaseWithRoles("classhub_migrator")),
    ).rejects.toThrow("classhub_operator");
    await expect(
      assertOperatorDatabaseRole(databaseWithRoles("classhub_operator", "classhub_migrator")),
    ).rejects.toThrow("classhub_operator");
  });

  it.each([
    ["superuser", { is_superuser: true }],
    ["createdb", { is_create_database_role: true }],
    ["createrole", { is_create_role_role: true }],
    ["replication", { is_replication_role: true }],
    ["bypassrls", { is_bypass_rls_role: true }],
    ["inherit", { is_inherit_role: true }],
    ["role membership", { has_role_membership: true }],
  ] satisfies [string, Partial<OperatorRoleIdentity>][])(
    "rejects the %s privilege or role escalation path",
    async (_label, overrides) => {
      await expect(
        assertOperatorDatabaseRole(databaseWithRoles("classhub_operator", undefined, overrides)),
      ).rejects.toThrow("최소 권한");
    },
  );
});
