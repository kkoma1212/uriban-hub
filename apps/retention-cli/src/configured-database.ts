import { readFile } from "node:fs/promises";
import {
  createMysql2MariaDbPool,
  parseMariaDbUrl,
  createConfiguredRuntimeObservation,
} from "@classhub/db";
import { openRetentionDatabase, type RetentionDatabase } from "./database.js";
import type { RetentionEnvironment } from "./environment.js";
import { openRetentionMariaDbDatabase } from "./mariadb/database.js";
import { RetentionMariaDbError } from "./mariadb/errors.js";

export async function openConfiguredRetentionDatabase(
  environment: RetentionEnvironment,
  observationEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RetentionDatabase> {
  const observation = createConfiguredRuntimeObservation("retention", observationEnvironment);
  if (
    observation &&
    (environment.databaseEngine !== "mariadb" || environment.mariaDb?.tls !== "required")
  )
    throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  if (environment.databaseEngine === "postgres")
    return openRetentionDatabase(environment.databaseUrl);
  if (environment.databaseEngine !== "mariadb" || !environment.mariaDb)
    throw new RetentionMariaDbError("configuration");
  const options = environment.mariaDb;
  let connection;
  try {
    connection = parseMariaDbUrl(environment.databaseUrl, "classhub_retention");
  } catch {
    throw new RetentionMariaDbError("configuration");
  }
  let sslCa: string | undefined;
  if (options.tls === "required") {
    if (!options.tlsCaFile) throw new RetentionMariaDbError("trusted_ca");
    try {
      sslCa = await readFile(options.tlsCaFile, "utf8");
    } catch {
      throw new RetentionMariaDbError("trusted_ca");
    }
  }
  const database = await openRetentionMariaDbDatabase(createMysql2MariaDbPool, {
    ...connection,
    tls: options.tls,
    ...(sslCa === undefined ? {} : { sslCa }),
    ...(observation ? { onRuntimeObservation: observation.sink } : {}),
    accountHost: options.accountHost,
    connectionLimit: options.connectionLimit,
    mailLogsGrantInstalled: options.mailLogsGrantInstalled,
    auditConsentsGrantInstalled: options.auditConsentsGrantInstalled,
    adminRecordsGrantInstalled: options.adminRecordsGrantInstalled,
    ...(options.classArchivesGrantProfile === undefined
      ? {}
      : { classArchivesGrantProfile: options.classArchivesGrantProfile }),
  });
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
