import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

export interface DatabaseConnectionOptions extends Omit<PoolConfig, "connectionString"> {
  /** Called without the raw pg error so callers cannot accidentally log a DSN or query detail. */
  onUnexpectedPoolError?: () => void;
}

export function createDatabase<TDatabase extends object>(
  connectionString: string,
  options: DatabaseConnectionOptions = {},
): Kysely<TDatabase> {
  const { onUnexpectedPoolError, ...poolOptions } = options;
  const pool = new Pool({ connectionString, ...poolOptions });
  const reportedErrors = new WeakSet<object>();

  const reportUnexpectedPoolError = (error: unknown): void => {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }

    try {
      onUnexpectedPoolError?.();
    } catch {
      // An observability callback must never become a second process crash path.
    }
  };

  // pg-pool removes its idle error listener while a client is checked out by
  // pool.connect(), which Kysely transactions use. Keep a privacy-safe listener
  // on every physical client so a hard socket loss rejects work instead of
  // becoming an unhandled EventEmitter error that terminates the process.
  pool.on("connect", (client) => {
    client.on("error", reportUnexpectedPoolError);
  });

  // Idle clients are surfaced through Pool#error. The WeakSet prevents the same
  // Error object from notifying observers twice through Client and Pool paths.
  pool.on("error", reportUnexpectedPoolError);

  return new Kysely<TDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}
