import { readFile } from "node:fs/promises";
import {
  createMysql2MariaDbPool,
  parseMariaDbUrl,
  createConfiguredRuntimeObservation,
} from "@classhub/db";
import {
  openWorkerDatabase,
  probeWorkerDatabaseReadiness,
  type WorkerDatabase,
} from "./database.js";
import type { WorkerEnvironment } from "./environment.js";
import { openWorkerMariaDbDatabase, probeWorkerMariaDbReadiness } from "./mariadb/database.js";
import { MariaDbSecurityAuditStore } from "./security-audit/mariadb-security-audit-store.js";
import { PostgresSecurityAuditStore } from "./security-audit/postgres-security-audit-store.js";
import type { SecurityAuditStore } from "./security-audit/security-audit-store.js";

export async function openConfiguredWorkerDatabase(
  environment: WorkerEnvironment,
  onUnexpectedPoolError?: () => void,
  observationEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<WorkerDatabase> {
  const observation = createConfiguredRuntimeObservation("worker", observationEnvironment);
  if (environment.databaseEngine === "postgres") {
    if (observation) throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    return openWorkerDatabase(environment.workerDatabaseUrl, onUnexpectedPoolError);
  }
  const options = environment.mariaDb;
  if (!options) throw new Error("Worker MariaDB environment is missing.");
  if (observation && options.tls !== "required")
    throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  let sslCa: string | undefined;
  if (options.tls === "required") {
    if (!options.tlsCaFile) throw new Error("Worker MariaDB trusted CA file could not be read.");
    try {
      sslCa = await readFile(options.tlsCaFile, "utf8");
    } catch {
      throw new Error("Worker MariaDB trusted CA file could not be read.");
    }
  }
  const database = await openWorkerMariaDbDatabase(
    createMysql2MariaDbPool,
    {
      ...parseMariaDbUrl(environment.workerDatabaseUrl, "classhub_worker"),
      accountHost: options.accountHost,
      connectionLimit: options.connectionLimit,
      tls: options.tls,
      ...(sslCa === undefined ? {} : { sslCa }),
      runtimeGrantProfile: "worker_security_audit_v1",
      ...(observation ? { onRuntimeObservation: observation.sink } : {}),
    },
    onUnexpectedPoolError,
  );
  try {
    observation?.assertCaptured();
    return database;
  } catch {
    try {
      await database.destroy();
    } catch {}
    throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  }
}

export function probeConfiguredWorkerDatabaseReadiness(
  database: WorkerDatabase,
  environment: WorkerEnvironment,
): Promise<void> {
  return environment.databaseEngine === "mariadb"
    ? probeWorkerMariaDbReadiness(database)
    : probeWorkerDatabaseReadiness(database);
}

export function createConfiguredSecurityAuditStore(
  database: WorkerDatabase,
  environment: WorkerEnvironment,
): SecurityAuditStore {
  return environment.databaseEngine === "mariadb"
    ? new MariaDbSecurityAuditStore(database)
    : new PostgresSecurityAuditStore(database);
}
