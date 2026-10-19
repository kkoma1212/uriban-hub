import { Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from "kysely";
import { MariaDbDriver, type MariaDbPool } from "./guarded-driver.js";
import type { MariaDbRuntimeObservationSink } from "./runtime-observation.js";
import type { MariaDbRuntimeGrantProfile } from "./runtime-grant-extensions.js";
import {
  MariaDbRuntimeRoleError,
  validateMariaDbRuntimeIdentity,
  type MariaDbRuntimeRole,
} from "./runtime-role.js";

export interface MariaDbConnectionOptions {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  /** Trusted CA contents, never a request-supplied path or an unverified TLS override. */
  sslCa?: string | undefined;
  /**
   * 기본은 "required"(TLS·CA·호스트 이름 검증). "disabled"는 DB가 같은 서버·같은 내부망에 있어
   * 운영자가 환경값으로 명시해 끈 경우에만 쓴다(2026-10-07 사용자 승인). 계정·권한 대조는 그대로 한다.
   */
  tls?: MariaDbTlsMode | undefined;
  connectionLimit?: number;
  /** Opt-in reviewed privilege candidate. Required by the MariaDB operator opener. */
  runtimeRole?: MariaDbRuntimeRole;
  /** Exact reviewed worker or retention extension; undefined preserves the baseline. */
  runtimeGrantProfile?: MariaDbRuntimeGrantProfile | undefined;
  /** The account host in CURRENT_USER(), e.g. a reviewed host/CIDR or isolated-QA %. */
  accountHost?: string;
  /** Opt-in same-lease observation after successful role attestation; synchronous only. */
  onRuntimeObservation?: MariaDbRuntimeObservationSink;
}

export interface MariaDbPoolConfiguration {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
  connectTimeout: number;
  /** The bounded adapter owns admission; queueLimit:0 alone means unlimited in mysql2. */
  waitForConnections?: false;
  queueLimit?: 0;
  resetOnRelease?: false;
  charset: "utf8mb4_bin";
  timezone: "Z";
  dateStrings: true;
  supportBigNumbers: true;
  bigNumberStrings: true;
  decimalNumbers: false;
  jsonStrings: true;
  multipleStatements: false;
  /** TLS를 명시적으로 끈 경우에만 빠진다. */
  ssl?: { ca: string; rejectUnauthorized: true; verifyIdentity: true };
}

export type MariaDbTlsMode = "required" | "disabled";

/** 환경값 하나를 TLS 모드로 읽는다. 비어 있으면 required, 그 밖의 값은 거절한다. */
export function parseMariaDbTlsMode(
  value: string | undefined,
  variableName: string,
): MariaDbTlsMode {
  if (value === undefined || value === "" || value === "required") return "required";
  if (value === "disabled") return "disabled";
  throw new Error(`${variableName} must be required or disabled.`);
}

export type MariaDbPoolFactory = (configuration: MariaDbPoolConfiguration) => MariaDbPool;

/**
 * Explicit MariaDB candidate. Existing createDatabase callers keep PostgreSQL.
 * The caller supplies mysql2's callback createPool, keeping client installation
 * separate from activation. Do not share the returned pool with another driver.
 * SQL dialect conversion, complete role attestation and deployment remain gates.
 */
export function createMariaDbDatabase<TDatabase extends object>(
  createPool: MariaDbPoolFactory,
  options: MariaDbConnectionOptions,
): Kysely<TDatabase> {
  for (const value of [options.host, options.database, options.user]) {
    if (value.trim() === "") throw new Error("MariaDB connection identity is required.");
  }
  const tls = options.tls ?? "required";
  if (tls !== "required" && tls !== "disabled") throw new Error("MariaDB TLS mode is invalid.");
  if (tls === "required") {
    // mysql2 3.24.3 only performs its explicit identity check for DNS hosts.
    if (isIP(options.host) !== 0) throw new Error("MariaDB TLS requires a DNS host name.");
    if (!options.sslCa?.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("MariaDB requires an explicit trusted CA certificate.");
    }
  } else if (options.sslCa !== undefined) {
    // 끈 채로 CA를 함께 주면 어느 쪽이 의도인지 알 수 없다. 조용히 무시하지 않는다.
    throw new Error("MariaDB CA certificate must not be supplied when TLS is disabled.");
  }
  const port = options.port ?? 3306;
  const connectionLimit = options.connectionLimit ?? 10;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("MariaDB port is invalid.");
  }
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
    throw new RangeError("MariaDB connection limit is invalid.");
  }
  const runtimeIdentity =
    options.runtimeRole === undefined
      ? undefined
      : {
          role: options.runtimeRole,
          user: options.user,
          database: options.database,
          accountHost: options.accountHost ?? "",
          runtimeGrantProfile: options.runtimeGrantProfile,
          tls,
        };
  if (runtimeIdentity) validateMariaDbRuntimeIdentity(runtimeIdentity);
  else if (options.runtimeGrantProfile !== undefined)
    throw new MariaDbRuntimeRoleError("configuration_rejected");
  else if (options.accountHost !== undefined)
    throw new Error("MariaDB runtime role is required with an account host.");
  if (
    options.onRuntimeObservation !== undefined &&
    (typeof options.onRuntimeObservation !== "function" || !runtimeIdentity || tls !== "required")
  )
    throw new MariaDbRuntimeRoleError("configuration_rejected");
  const pool = createPool({
    host: options.host,
    port,
    database: options.database,
    user: options.user,
    password: options.password,
    connectionLimit,
    connectTimeout: 5000,
    charset: "utf8mb4_bin",
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    multipleStatements: false,
    ...(tls === "required" && options.sslCa !== undefined
      ? { ssl: { ca: options.sslCa, rejectUnauthorized: true, verifyIdentity: true } }
      : {}),
  });
  return new Kysely<TDatabase>({
    dialect: {
      createDriver: () => new MariaDbDriver(pool, runtimeIdentity, options.onRuntimeObservation),
      createAdapter: () => new MysqlAdapter(),
      createQueryCompiler: () => new MysqlQueryCompiler(),
      createIntrospector: (database) => new MysqlIntrospector(database),
    },
  });
}
import { isIP } from "node:net";
