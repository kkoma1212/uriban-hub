import catalog from "./runtime-grant-catalog.json" with { type: "json" };
import {
  requiredMariaDbRuntimeGrants,
  type MariaDbRuntimeGrantProfile,
} from "./runtime-grant-extensions.js";
import { parseMariaDbRuntimeGrants } from "./runtime-grants.js";

export type MariaDbRuntimeRole = keyof typeof catalog.roles;

/**
 * 지원 서버: MariaDB 11.4 LTS의 11.4.13 이상 패치(2026-10-03 총검수 D3-03). 같은 LTS 계열의 보안
 * 패치(11.4.14 등)를 적용해도 앱 접속이 막히지 않게 한다. 다른 계열(11.8 등)은 권한·PUBLIC 동작이
 * 달라질 수 있어 거절한다. 권한 목록 자체는 아래에서 그대로 정확히 대조한다.
 */
export function isSupportedMariaDbServerVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^11\.4\.(\d+)-MariaDB(?:-[0-9A-Za-z.~+-]+)?$/u.exec(value);
  return match !== null && Number(match[1]) >= 13;
}
export interface MariaDbRuntimeIdentity {
  role: MariaDbRuntimeRole;
  user: string;
  accountHost: string;
  database: string;
  runtimeGrantProfile?: MariaDbRuntimeGrantProfile | undefined;
  /** 기본 "required". "disabled"면 접속 암호화와 계정의 REQUIRE SSL만 검사에서 뺀다. */
  tls?: "required" | "disabled" | undefined;
}
type Reason =
  "configuration_rejected" | "identity_rejected" | "privileges_rejected" | "query_failed";

/** Never includes native diagnostics, GRANT statements, auth hashes or identity inputs. */
export class MariaDbRuntimeRoleError extends Error {
  readonly code = "MARIADB_RUNTIME_ROLE_ATTESTATION_FAILED";
  constructor(readonly reason: Reason) {
    super("MariaDB 연결 계정의 권한을 확인하지 못했습니다.");
    this.name = "MariaDbRuntimeRoleError";
  }
}

export function validateMariaDbRuntimeIdentity(identity: MariaDbRuntimeIdentity): void {
  if (
    !requiredMariaDbRuntimeGrants(identity.role, identity.runtimeGrantProfile) ||
    typeof identity.user !== "string" ||
    typeof identity.database !== "string" ||
    typeof identity.accountHost !== "string" ||
    ![undefined, "required", "disabled"].includes(identity.tls) ||
    !/^[A-Za-z0-9_]+$/u.test(identity.user) ||
    !/^[A-Za-z0-9_]+$/u.test(identity.database) ||
    !/^[A-Za-z0-9_.%:/-]+$/u.test(identity.accountHost)
  )
    throw new MariaDbRuntimeRoleError("configuration_rejected");
}

/** Invoked privately by the driver after reset, on the same lease as subsequent work.
 * Explicit grants/roles are checked. Server-wide anonymous grant absence is a deployment preflight.
 */
export async function attestMariaDbRuntimeConnection(
  query: (statement: string) => Promise<unknown>,
  expected: MariaDbRuntimeIdentity,
): Promise<void> {
  validateMariaDbRuntimeIdentity(expected);
  let identity: unknown;
  let grants: unknown;
  let publicGrants: unknown;
  try {
    identity =
      await query(`SELECT CURRENT_USER() AS account, USER() AS login_user, DATABASE() AS database_name,
      CURRENT_ROLE() AS active_role, VERSION() AS server_version,
      (SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME='SSL_CIPHER') AS ssl_cipher,
      (SELECT COUNT(*) FROM information_schema.APPLICABLE_ROLES) AS applicable_roles,
      (SELECT COUNT(ROLE_NAME) FROM information_schema.ENABLED_ROLES) AS enabled_roles`);
    grants = await query("SHOW GRANTS FOR CURRENT_USER");
    // On the pinned server, PUBLIC privileges can exist with both role counts
    // zero. Check them explicitly instead of assuming the own-account rows include them.
    publicGrants = await query("SHOW GRANTS FOR PUBLIC");
  } catch {
    throw new MariaDbRuntimeRoleError("query_failed");
  }
  const row =
    Array.isArray(identity) && identity.length === 1
      ? (identity[0] as Record<string, unknown>)
      : undefined;
  if (
    !row ||
    row.account !== `${expected.user}@${expected.accountHost}` ||
    row.database_name !== expected.database ||
    typeof row.login_user !== "string" ||
    !row.login_user.startsWith(`${expected.user}@`) ||
    row.login_user.length <= expected.user.length + 1 ||
    row.active_role !== null ||
    !isSupportedMariaDbServerVersion(row.server_version) ||
    (expected.tls !== "disabled" &&
      (typeof row.ssl_cipher !== "string" || row.ssl_cipher.length === 0)) ||
    ![0, "0"].includes(row.applicable_roles as string | number) ||
    ![0, "0"].includes(row.enabled_roles as string | number)
  )
    throw new MariaDbRuntimeRoleError("identity_rejected");
  try {
    if (!Array.isArray(publicGrants) || publicGrants.length !== 0)
      throw new Error("PUBLIC grants present");
    const actual = parseMariaDbRuntimeGrants(grants, expected);
    const required = requiredMariaDbRuntimeGrants(expected.role, expected.runtimeGrantProfile);
    if (
      !required ||
      actual.length !== required.length ||
      actual.some((entry, index) => entry !== required[index])
    )
      throw new Error("grant mismatch");
  } catch {
    throw new MariaDbRuntimeRoleError("privileges_rejected");
  }
}
