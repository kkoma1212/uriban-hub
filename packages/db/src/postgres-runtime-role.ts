import { sql, type Kysely } from "kysely";

export const POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR = "POSTGRES_RUNTIME_ROLE_ATTESTATION_FAILED";

export type PostgresRuntimeRoleAttestationFailureReason = "identity_rejected" | "query_failed";

export interface PostgresRuntimeRoleAttestationOptions {
  expectedRole: string;
  runtimeName: string;
}

interface PostgresRuntimeRoleIdentity {
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

export class PostgresRuntimeRoleAttestationError extends Error {
  readonly code = POSTGRES_RUNTIME_ROLE_ATTESTATION_ERROR;

  constructor(
    readonly reason: PostgresRuntimeRoleAttestationFailureReason,
    options: PostgresRuntimeRoleAttestationOptions,
  ) {
    super(
      reason === "query_failed"
        ? `${options.runtimeName} DB 역할 검증을 완료하지 못했습니다.`
        : `${options.runtimeName} DB 연결은 ${options.expectedRole} 최소 권한 role이어야 합니다.`,
    );
    this.name = "PostgresRuntimeRoleAttestationError";
  }
}

function isExactLeastPrivilegeIdentity(
  identity: PostgresRuntimeRoleIdentity,
  expectedRole: string,
): boolean {
  return (
    identity.current_role_name === expectedRole &&
    identity.session_role_name === expectedRole &&
    identity.has_role_membership === false &&
    identity.is_superuser === false &&
    identity.is_create_database_role === false &&
    identity.is_create_role_role === false &&
    identity.is_inherit_role === false &&
    identity.is_replication_role === false &&
    identity.is_bypass_rls_role === false
  );
}

export async function assertPostgresRuntimeRole<TDatabase extends object>(
  database: Kysely<TDatabase>,
  options: PostgresRuntimeRoleAttestationOptions,
): Promise<void> {
  let identity: PostgresRuntimeRoleIdentity;

  try {
    identity = (await database
      .selectNoFrom([
        sql<string>`current_user`.as("current_role_name"),
        sql<string>`session_user`.as("session_role_name"),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS memberships
          INNER JOIN pg_catalog.pg_roles AS member_role
            ON member_role.oid = memberships.member
          WHERE member_role.rolname = current_user
        )`.as("has_role_membership"),
        sql<boolean>`COALESCE(
          (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_superuser"),
        sql<boolean>`COALESCE(
          (SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_create_database_role"),
        sql<boolean>`COALESCE(
          (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_create_role_role"),
        sql<boolean>`COALESCE(
          (SELECT rolinherit FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_inherit_role"),
        sql<boolean>`COALESCE(
          (SELECT rolreplication FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_replication_role"),
        sql<boolean>`COALESCE(
          (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user),
          TRUE
        )`.as("is_bypass_rls_role"),
      ])
      .executeTakeFirstOrThrow()) as PostgresRuntimeRoleIdentity;
  } catch {
    throw new PostgresRuntimeRoleAttestationError("query_failed", options);
  }

  if (!isExactLeastPrivilegeIdentity(identity, options.expectedRole)) {
    throw new PostgresRuntimeRoleAttestationError("identity_rejected", options);
  }
}
