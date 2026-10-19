import { assertPostgresRuntimeRole, createDatabase, type DB } from "@classhub/db";
import { sql, type Kysely } from "kysely";

const WORKER_DATABASE_ROLE = "classhub_worker";
const WORKER_DATABASE_TIMEOUT_MS = 5_000;
const WORKER_READINESS_STATEMENT_TIMEOUT_MS = 1_000;
const WORKER_READINESS_IDLE_TRANSACTION_TIMEOUT_MS = 1_500;

export type WorkerDatabase = Kysely<DB>;

export async function assertWorkerDatabaseRole(database: WorkerDatabase): Promise<void> {
  await assertPostgresRuntimeRole(database, {
    expectedRole: WORKER_DATABASE_ROLE,
    runtimeName: "worker",
  });
}

export async function probeWorkerDatabaseReadiness(database: WorkerDatabase): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      SELECT
        set_config(
          'statement_timeout',
          ${`${WORKER_READINESS_STATEMENT_TIMEOUT_MS}ms`},
          TRUE
        ),
        set_config(
          'idle_in_transaction_session_timeout',
          ${`${WORKER_READINESS_IDLE_TRANSACTION_TIMEOUT_MS}ms`},
          TRUE
        )
    `.execute(transaction);

    const result = await sql<{ ready: number }>`SELECT 1::integer AS ready`.execute(transaction);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) {
      throw new Error("Worker PostgreSQL readiness probe returned an unexpected result.");
    }
  });
}

export async function openWorkerDatabase(
  connectionString: string,
  onUnexpectedPoolError?: () => void,
): Promise<WorkerDatabase> {
  const database = createDatabase<DB>(connectionString, {
    connectionTimeoutMillis: WORKER_DATABASE_TIMEOUT_MS,
    ...(onUnexpectedPoolError === undefined ? {} : { onUnexpectedPoolError }),
    query_timeout: WORKER_DATABASE_TIMEOUT_MS,
    statement_timeout: WORKER_DATABASE_TIMEOUT_MS,
  });

  try {
    await assertWorkerDatabaseRole(database);
    return database;
  } catch (attestationError) {
    try {
      await database.destroy();
    } catch {
      throw new Error("worker DB 역할 검증 실패 후 연결 정리에도 실패했습니다.");
    }

    throw attestationError;
  }
}
