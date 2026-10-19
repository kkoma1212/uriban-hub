import { assertProductionDatabaseUrl } from "@classhub/db";
import {
  loadWorkerMariaDbEnvironment,
  type WorkerMariaDbEnvironment,
} from "./mariadb/runtime-environment.js";

export interface WorkerEnvironment {
  databaseEngine: "postgres" | "mariadb";
  mariaDb?: WorkerMariaDbEnvironment;
  healthHost: "0.0.0.0" | "127.0.0.1" | "::" | "::1";
  healthPort: number;
  logLevel: "debug" | "error" | "fatal" | "info" | "trace" | "warn";
  nodeEnvironment: "development" | "production" | "test";
  redisUrl: string;
  workerDatabaseUrl: string;
}

const WORKER_HEALTH_HOSTS = ["0.0.0.0", "127.0.0.1", "::", "::1"] as const;

function requireUrl(value: string | undefined, name: string, protocols: string[]): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} uses an unsupported protocol.`);
  }
  return value;
}

function loadNodeEnvironment(value: string | undefined): WorkerEnvironment["nodeEnvironment"] {
  const nodeEnvironment = value ?? "development";
  if (!["development", "production", "test"].includes(nodeEnvironment)) {
    throw new Error("NODE_ENV is invalid.");
  }
  return nodeEnvironment as WorkerEnvironment["nodeEnvironment"];
}

function loadHealthHost(
  value: string | undefined,
  nodeEnvironment: WorkerEnvironment["nodeEnvironment"],
): WorkerEnvironment["healthHost"] {
  const healthHost = value ?? (nodeEnvironment === "production" ? "0.0.0.0" : "127.0.0.1");
  if (!WORKER_HEALTH_HOSTS.some((candidate) => candidate === healthHost)) {
    throw new Error(`WORKER_HEALTH_HOST must be one of ${WORKER_HEALTH_HOSTS.join(", ")}.`);
  }
  return healthHost as WorkerEnvironment["healthHost"];
}

function loadHealthPort(value: string | undefined): number {
  const rawPort = value ?? "3001";
  if (!/^[1-9]\d*$/u.test(rawPort)) {
    throw new Error("WORKER_HEALTH_PORT must be an integer from 1 through 65535.");
  }

  const healthPort = Number(rawPort);
  if (!Number.isSafeInteger(healthPort) || healthPort > 65_535) {
    throw new Error("WORKER_HEALTH_PORT must be an integer from 1 through 65535.");
  }
  return healthPort;
}

export function loadWorkerEnvironment(input: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
  const databaseEngine = input.DATABASE_ENGINE ?? "postgres";
  if (databaseEngine !== "postgres" && databaseEngine !== "mariadb") {
    throw new Error("DATABASE_ENGINE must be postgres or mariadb.");
  }
  const nodeEnvironment = loadNodeEnvironment(input.NODE_ENV);
  const healthHost = loadHealthHost(input.WORKER_HEALTH_HOST, nodeEnvironment);
  const healthPort = loadHealthPort(input.WORKER_HEALTH_PORT);
  const workerDatabaseUrl = requireUrl(
    input.WORKER_DATABASE_URL,
    "WORKER_DATABASE_URL",
    databaseEngine === "mariadb" ? ["mariadb:", "mysql:"] : ["postgres:", "postgresql:"],
  );
  const mariaDb =
    databaseEngine === "mariadb"
      ? loadWorkerMariaDbEnvironment(input, workerDatabaseUrl)
      : undefined;
  const parsedDatabaseUrl = new URL(workerDatabaseUrl);
  if (databaseEngine === "postgres" && parsedDatabaseUrl.username !== "classhub_worker") {
    throw new Error("WORKER_DATABASE_URL must use the classhub_worker role.");
  }

  const redisUrl = requireUrl(input.REDIS_URL, "REDIS_URL", ["redis:", "rediss:"]);
  if (nodeEnvironment === "production") {
    if (databaseEngine === "postgres") {
      assertProductionDatabaseUrl(workerDatabaseUrl, {
        environment: input,
        expectedUsername: "classhub_worker",
        variableName: "WORKER_DATABASE_URL",
      });
    }

    // 기본은 rediss:// 강제. 같은 서버·내부망 Redis라 운영자가 명시적으로 끈 경우에만 redis://를 받는다.
    const redisTlsMode = input.REDIS_TLS_MODE ?? "required";
    if (redisTlsMode !== "required" && redisTlsMode !== "disabled") {
      throw new Error("REDIS_TLS_MODE must be required or disabled.");
    }
    if (redisTlsMode === "required" && new URL(redisUrl).protocol !== "rediss:") {
      throw new Error("production REDIS_URL must use rediss://.");
    }
  }

  const logLevel = input.LOG_LEVEL ?? "info";
  if (!["debug", "error", "fatal", "info", "trace", "warn"].includes(logLevel)) {
    throw new Error("LOG_LEVEL is invalid.");
  }

  return {
    databaseEngine,
    ...(mariaDb === undefined ? {} : { mariaDb }),
    healthHost,
    healthPort,
    logLevel: logLevel as WorkerEnvironment["logLevel"],
    nodeEnvironment,
    redisUrl,
    workerDatabaseUrl,
  };
}
