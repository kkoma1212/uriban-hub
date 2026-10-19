import { parseMariaDbTlsMode, parseMariaDbUrl, type MariaDbTlsMode } from "@classhub/db";

export interface WorkerMariaDbEnvironment {
  /** tls가 "disabled"면 없다. */
  tlsCaFile?: string;
  tls: MariaDbTlsMode;
  accountHost: string;
  connectionLimit: number;
}

export function loadWorkerMariaDbEnvironment(
  input: NodeJS.ProcessEnv,
  connectionUrl: string,
): WorkerMariaDbEnvironment {
  try {
    parseMariaDbUrl(connectionUrl, "classhub_worker");
  } catch {
    throw new Error(
      "WORKER_DATABASE_URL requires a MariaDB DNS/TLS identity and classhub_worker account.",
    );
  }
  // 기본은 required. 같은 서버·내부망 DB라 운영자가 명시적으로 끈 경우에만 disabled(2026-10-07 사용자 승인).
  const tls = parseMariaDbTlsMode(input.WORKER_DATABASE_TLS_MODE, "WORKER_DATABASE_TLS_MODE");
  const tlsCaFile = input.WORKER_DATABASE_TLS_CA_FILE;
  const accountHost = input.WORKER_DATABASE_ACCOUNT_HOST;
  if (tls === "required" && !tlsCaFile?.trim()) {
    throw new Error("WORKER_DATABASE_TLS_CA_FILE is required for MariaDB.");
  }
  if (tls === "disabled" && tlsCaFile?.trim()) {
    throw new Error(
      "WORKER_DATABASE_TLS_CA_FILE must be removed when WORKER_DATABASE_TLS_MODE=disabled.",
    );
  }
  if (!accountHost || !/^[A-Za-z0-9_.:%/-]+$/u.test(accountHost)) {
    throw new Error("WORKER_DATABASE_ACCOUNT_HOST is required for MariaDB.");
  }
  const rawLimit = input.WORKER_DATABASE_POOL_MAX ?? "10";
  const connectionLimit = Number(rawLimit);
  if (
    !/^[1-9]\d*$/u.test(rawLimit) ||
    !Number.isSafeInteger(connectionLimit) ||
    connectionLimit > 1000
  ) {
    throw new Error("WORKER_DATABASE_POOL_MAX must be an integer from 1 through 1000.");
  }
  return {
    ...(tls === "required" && tlsCaFile ? { tlsCaFile } : {}),
    tls,
    accountHost,
    connectionLimit,
  };
}
