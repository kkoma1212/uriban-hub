import { AsyncLocalStorage } from "node:async_hooks";
import {
  boundedMariaDbPoolFactory,
  createMariaDbDatabase,
  type DB,
  type MariaDbConnectionOptions,
  type MariaDbPoolFactory,
  type MariaDbPoolFailureReason,
  selectAppRuntimeGrantProfile,
  type MariaDbAuthDatabaseExtensions,
} from "@classhub/db";
import { sql, type Kysely } from "kysely";

export type ApiMariaDbDatabase = Kysely<DB>;
export type ApiMariaDbOptions = Omit<
  MariaDbConnectionOptions,
  "runtimeRole" | "runtimeGrantProfile" | "accountHost"
> & { accountHost: string };

export class ApiMariaDbDatabaseError extends Error {
  readonly code = "API_MARIADB_DATABASE_FAILED";
  constructor(readonly reason: MariaDbPoolFailureReason) {
    super("API MariaDB 연결 작업을 완료하지 못했습니다.");
    this.name = "ApiMariaDbDatabaseError";
  }
}

const readiness = new AsyncLocalStorage<boolean>();
const owned = new WeakSet<ApiMariaDbDatabase>();

export async function assertApiMariaDbDatabaseRole(database: ApiMariaDbDatabase): Promise<void> {
  try {
    if (!owned.has(database)) throw new ApiMariaDbDatabaseError("configuration");
    // Every lease attests the app's exact mail-management, poll-close, push-subscription, push-delivery, schedule-link, help-request and help-chat ACL, TLS and account identity.
    await sql`SELECT 1 AS api_role_ready`.execute(database);
  } catch {
    throw new ApiMariaDbDatabaseError("role");
  }
}

/** 운영 DB에 설치된 선택 확장. 기능 켜기와 따로 두어, 기능을 꺼도 설치된 권한과 정확히 맞춘다. */
export interface ApiMariaDbInstalledExtensions {
  auth: MariaDbAuthDatabaseExtensions;
  classChat: boolean;
  profilePhotos?: boolean;
  birthDates?: boolean;
  adminAccessLogs?: boolean;
  pollEdit?: boolean;
  teacherLibrary?: boolean;
}
const HELP_CHAT_BASELINE: ApiMariaDbInstalledExtensions = { auth: "none", classChat: false };

/** Opens only the guarded application role. Caller configuration cannot select another role;
 * the grant profile is one of the fixed installed-extension combinations. */
export async function openApiMariaDbDatabase(
  createPool: MariaDbPoolFactory,
  options: ApiMariaDbOptions,
  onUnexpectedPoolError?: () => void,
  installed: ApiMariaDbInstalledExtensions = HELP_CHAT_BASELINE,
): Promise<ApiMariaDbDatabase> {
  let database: ApiMariaDbDatabase | undefined;
  try {
    if ("runtimeGrantProfile" in options) throw new ApiMariaDbDatabaseError("configuration");
    database = createMariaDbDatabase<DB>(
      boundedMariaDbPoolFactory(
        createPool,
        () => readiness.getStore() === true,
        onUnexpectedPoolError,
        (reason) => new ApiMariaDbDatabaseError(reason),
      ),
      {
        ...options,
        runtimeRole: "app",
        runtimeGrantProfile: selectAppRuntimeGrantProfile(installed),
      },
    );
    owned.add(database);
    await assertApiMariaDbDatabaseRole(database);
    return database;
  } catch {
    if (database) {
      owned.delete(database);
      try {
        await database.destroy();
      } catch {
        throw new ApiMariaDbDatabaseError("cleanup");
      }
    }
    throw new ApiMariaDbDatabaseError(database ? "role" : "configuration");
  }
}

/** SELECT-only readiness, one-second server statement cap and awaited COMMIT/rollback.
 * The guarded transaction remains READ WRITE, as in the reviewed worker adapter.
 * Five-second socket/lease watchdogs remain active. PostgreSQL's 1.5-second idle transaction
 * timeout has no verified exact MariaDB equivalent here; no rounded idle policy is installed.
 */
export async function probeApiMariaDbReadiness(database: ApiMariaDbDatabase): Promise<void> {
  try {
    if (!owned.has(database)) throw new ApiMariaDbDatabaseError("configuration");
    await readiness.run(true, () =>
      database.transaction().execute(async (transaction) => {
        const result = await sql<{ ready: number }>`SELECT 1 AS ready`.execute(transaction);
        if (result.rows.length !== 1 || result.rows[0]?.ready !== 1)
          throw new ApiMariaDbDatabaseError("readiness");
      }),
    );
  } catch {
    throw new ApiMariaDbDatabaseError("readiness");
  }
}
