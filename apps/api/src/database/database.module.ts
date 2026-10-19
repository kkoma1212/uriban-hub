import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  assertPostgresRuntimeRole,
  createDatabase,
  createMysql2MariaDbPool,
  createConfiguredRuntimeObservation,
  type DB,
} from "@classhub/db";
import type { Kysely } from "kysely";
import { readFile } from "node:fs/promises";

import type { AppEnvironment } from "../config/environment.js";
import { parseMariaDbUrl } from "../config/mariadb-environment.js";
import { openApiMariaDbDatabase } from "./mariadb-database.js";

export const DATABASE = Symbol("DATABASE");
const APPLICATION_DATABASE_ROLE = "classhub_app";
const APPLICATION_DATABASE_TIMEOUT_MS = 5_000;
const databasePoolLogger = new Logger("DatabasePool");

export type ClassHubDatabase = Kysely<DB>;

export async function assertApplicationDatabaseRole(database: ClassHubDatabase): Promise<void> {
  await assertPostgresRuntimeRole(database, {
    expectedRole: APPLICATION_DATABASE_ROLE,
    runtimeName: "API",
  });
}

export async function openApplicationDatabase(
  connectionString: string,
  poolMax?: number,
): Promise<ClassHubDatabase> {
  const database = createDatabase<DB>(connectionString, {
    connectionTimeoutMillis: APPLICATION_DATABASE_TIMEOUT_MS,
    // 미지정이면 pg 기본값(10)이 그대로 쓰인다 — 기존 동작과 같다.
    ...(poolMax === undefined ? {} : { max: poolMax }),
    onUnexpectedPoolError: () => {
      databasePoolLogger.error({ failure_code: "database_idle_client_error" });
    },
    query_timeout: APPLICATION_DATABASE_TIMEOUT_MS,
    statement_timeout: APPLICATION_DATABASE_TIMEOUT_MS,
  });

  try {
    await assertApplicationDatabaseRole(database);
    return database;
  } catch (identityError) {
    try {
      await database.destroy();
    } catch {
      throw new Error("API DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    }

    throw identityError;
  }
}

export async function openConfiguredApplicationDatabase(
  config: ConfigService<AppEnvironment, true>,
  observationEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ClassHubDatabase> {
  const optedIn =
    observationEnvironment.CLASSHUB_RUNTIME_OBSERVATION_DIRECTORY !== undefined ||
    observationEnvironment.CLASSHUB_RUNTIME_OBSERVATION_CHALLENGE !== undefined;
  const surface = config.get("API_SURFACE", { infer: true });
  if (optedIn && (surface === "all" || !["user", "admin"].includes(surface)))
    throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  const observation = createConfiguredRuntimeObservation(
    surface === "admin" ? "admin-api" : "user-api",
    observationEnvironment,
  );
  const connectionString = config.get("DATABASE_URL", { infer: true });
  const connectionLimit = config.get("DATABASE_POOL_MAX", { infer: true });
  if (config.get("DATABASE_ENGINE", { infer: true }) !== "mariadb") {
    if (observation) throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
    return openApplicationDatabase(connectionString, connectionLimit);
  }
  const caFile = config.get("DATABASE_TLS_CA_FILE", { infer: true });
  const accountHost = config.get("DATABASE_ACCOUNT_HOST", { infer: true });
  const tls = config.get("DATABASE_TLS_MODE", { infer: true });
  if (observation && tls !== "required") throw new Error("MARIADB_RUNTIME_OBSERVATION_FAILED");
  if (!accountHost || (tls === "required" && !caFile)) {
    throw new Error("MariaDB TLS CA and account host are required.");
  }
  let sslCa: string | undefined;
  if (tls === "required" && caFile) {
    try {
      sslCa = await readFile(caFile, "utf8");
    } catch {
      throw new Error("MariaDB trusted CA file could not be read.");
    }
  }
  const database = await openApiMariaDbDatabase(
    createMysql2MariaDbPool,
    {
      ...parseMariaDbUrl(connectionString),
      accountHost,
      connectionLimit,
      tls,
      ...(sslCa === undefined ? {} : { sslCa }),
      ...(observation ? { onRuntimeObservation: observation.sink } : {}),
    },
    () => databasePoolLogger.error({ failure_code: "database_idle_client_error" }),
    {
      auth: config.get("AUTH_DATABASE_EXTENSIONS", { infer: true }),
      classChat: config.get("CLASS_CHAT_DATABASE_INSTALLED", { infer: true }),
      profilePhotos: config.get("PROFILE_PHOTOS_DATABASE_INSTALLED", { infer: true }),
      birthDates: config.get("USER_BIRTH_DATES_DATABASE_INSTALLED", { infer: true }),
      adminAccessLogs: config.get("ADMIN_ACCESS_LOGS_DATABASE_INSTALLED", { infer: true }),
      pollEdit: config.get("POLL_EDIT_DATABASE_INSTALLED", { infer: true }),
      teacherLibrary: config.get("TEACHER_LIBRARY_DATABASE_INSTALLED", { infer: true }),
    },
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

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: ClassHubDatabase) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [ConfigService],
      useFactory: openConfiguredApplicationDatabase,
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
