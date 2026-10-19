import { createHash } from "node:crypto";
import {
  isSupportedMariaDbServerVersion,
  type MariaDbRuntimeIdentity,
  type MariaDbRuntimeRole,
} from "./runtime-role.js";

export interface MariaDbRuntimeTlsState {
  readonly encrypted: boolean;
  readonly authorized: boolean;
  readonly rejectUnauthorized: boolean;
  readonly verifyIdentity: boolean;
}
export interface MariaDbRuntimeObservation {
  readonly schemaVersion: 1;
  readonly role: MariaDbRuntimeRole;
  readonly serverVersion: string;
  readonly tlsVersion: "TLSv1.2" | "TLSv1.3";
  readonly verifiedTls: true;
  readonly accountIdentitySha256: string;
  readonly databaseIdentitySha256: string;
  readonly sessionIdentitySha256: string;
  readonly observedAt: string;
}
/** Synchronous sink. Async/thenable sinks are rejected; no process/image provenance is claimed. */
export type MariaDbRuntimeObservationSink = (
  observation: Readonly<MariaDbRuntimeObservation>,
) => void;
export const MARIADB_RUNTIME_OBSERVATION_SQL =
  "SELECT DATABASE() AS database_name,CURRENT_USER() AS account,VERSION() AS server_version,(SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME='SSL_CIPHER') AS ssl_cipher,(SELECT VARIABLE_VALUE FROM information_schema.SESSION_STATUS WHERE VARIABLE_NAME='SSL_VERSION') AS ssl_version,@@hostname AS server_hostname,CAST(@@server_id AS CHAR) AS server_id,CAST(@@port AS CHAR) AS server_port,CAST(CONNECTION_ID() AS CHAR) AS connection_id";
export class MariaDbRuntimeObservationError extends Error {
  readonly code = "MARIADB_RUNTIME_OBSERVATION_FAILED";
  constructor() {
    super("MariaDB runtime observation failed.");
    this.name = "MariaDbRuntimeObservationError";
  }
}
const fail = (): never => {
  throw new MariaDbRuntimeObservationError();
};
const hash = (values: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
export function requireRuntimeObservationTls(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const state = value as Record<string, unknown>;
  const keys = ["encrypted", "authorized", "rejectUnauthorized", "verifyIdentity"];
  if (Reflect.ownKeys(state).length !== keys.length || keys.some((key) => state[key] !== true))
    fail();
}
export function runtimeObservationFromRows(
  rows: unknown,
  identity: MariaDbRuntimeIdentity,
): Readonly<MariaDbRuntimeObservation> {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== "object" ||
    Array.isArray(rows[0])
  )
    fail();
  const row = (rows as unknown[])[0] as Record<string, unknown>;
  const keys = [
    "database_name",
    "account",
    "server_version",
    "ssl_cipher",
    "ssl_version",
    "server_hostname",
    "server_id",
    "server_port",
    "connection_id",
  ];
  if (Reflect.ownKeys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    fail();
  if (
    identity.tls === "disabled" ||
    row.database_name !== identity.database ||
    row.account !== identity.user + "@" + identity.accountHost ||
    !isSupportedMariaDbServerVersion(row.server_version) ||
    typeof row.ssl_cipher !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.ssl_cipher) ||
    !["TLSv1.2", "TLSv1.3"].includes(row.ssl_version as string) ||
    typeof row.server_hostname !== "string" ||
    !row.server_hostname.trim() ||
    row.server_hostname.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(row.server_hostname)
  )
    fail();
  for (const key of ["server_id", "server_port", "connection_id"]) {
    if (
      typeof row[key] !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(row[key] as string) ||
      (row[key] as string).length > 20
    )
      fail();
  }
  if (
    BigInt(row.server_id as string) > 4294967295n ||
    BigInt(row.server_port as string) < 1n ||
    BigInt(row.server_port as string) > 65535n ||
    BigInt(row.connection_id as string) < 1n ||
    BigInt(row.connection_id as string) > 18446744073709551615n
  )
    fail();
  const databaseIdentitySha256 = hash([row.server_hostname, row.server_id, row.server_port]);
  return Object.freeze({
    schemaVersion: 1,
    role: identity.role,
    serverVersion: row.server_version as string,
    tlsVersion: row.ssl_version as "TLSv1.2" | "TLSv1.3",
    verifiedTls: true,
    accountIdentitySha256: hash([row.account, row.database_name]),
    databaseIdentitySha256,
    sessionIdentitySha256: hash([databaseIdentitySha256, row.connection_id]),
    observedAt: new Date().toISOString(),
  });
}
