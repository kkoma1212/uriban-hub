import type {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  QueryResult,
  TransactionSettings,
} from "kysely";
import { attestMariaDbRuntimeConnection, type MariaDbRuntimeIdentity } from "./runtime-role.js";

import {
  MARIADB_RUNTIME_OBSERVATION_SQL,
  MariaDbRuntimeObservationError,
  requireRuntimeObservationTls,
  runtimeObservationFromRows,
  type MariaDbRuntimeObservationSink,
  type MariaDbRuntimeTlsState,
} from "./runtime-observation.js";

export type MariaDbRawConnection = {
  readRuntimeTls?(): MariaDbRuntimeTlsState;
  query(
    sql: string,
    parameters: readonly unknown[],
    callback: (error: unknown, result: unknown) => void,
  ): unknown;
  release(): void;
  destroy(): void;
};

export type MariaDbPool = {
  getConnection(callback: (error: unknown, connection: MariaDbRawConnection) => void): void;
  end(callback: (error: unknown) => void): void;
};

type GuardCode =
  | "connection_closed"
  | "driver_closed"
  | "foreign_connection"
  | "transaction_state"
  | "sql_not_allowed"
  | "transaction_settings"
  | "unsupported_operation"
  | "unsafe_integer"
  | "rollback_only";

/** Messages intentionally contain no SQL, parameters, connection strings or database errors. */
export class MariaDbGuardError extends Error {
  constructor(readonly code: GuardCode) {
    super(`MariaDB guarded driver rejected operation: ${code}`);
    this.name = "MariaDbGuardError";
  }
}

export class MariaDbRollbackOnlyError extends MariaDbGuardError {
  constructor() {
    super("rollback_only");
    this.name = "MariaDbRollbackOnlyError";
  }
}

type Lease = {
  raw: MariaDbRawConnection;
  state: "ready" | "transaction" | "closing" | "finished" | "released" | "destroyed";
  rollbackOnly: boolean;
  pending: Set<Promise<unknown>>;
};

const initialization = [
  "ROLLBACK",
  "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
  "SET SESSION time_zone = '+00:00'",
  "SET NAMES utf8mb4 COLLATE utf8mb4_bin",
  "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY,TIME_ROUND_FRACTIONAL'",
  "SET SESSION autocommit = 1",
];

function integer(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  throw new MariaDbGuardError("unsafe_integer");
}

function queryResult<R>(value: unknown): QueryResult<R> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("affectedRows" in value) ||
    !("insertId" in value)
  )
    return { rows: Array.isArray(value) ? (value as R[]) : [] };
  const insertId = value.insertId == null ? 0n : integer(value.insertId);
  return {
    rows: [],
    ...(insertId === 0n ? {} : { insertId }),
    ...(value.affectedRows == null ? {} : { numAffectedRows: integer(value.affectedRows) }),
    ...("changedRows" in value && value.changedRows != null
      ? { numChangedRows: integer(value.changedRows) }
      : {}),
  };
}

/** Owns a private callback pool. Factory configuration must disable multiple statements. */
export class MariaDbDriver implements Driver {
  readonly #pool: MariaDbPool;
  readonly #leases = new WeakMap<DatabaseConnection, Lease>();
  readonly #active = new Set<Lease>();
  #closed = false;
  #end: Promise<void> | undefined;

  constructor(
    pool: MariaDbPool,
    private readonly runtimeIdentity?: MariaDbRuntimeIdentity,
    private readonly onRuntimeObservation?: MariaDbRuntimeObservationSink,
  ) {
    this.#pool = pool;
  }

  async init(): Promise<void> {
    this.#assertOpen();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    this.#assertOpen();
    const raw = await new Promise<MariaDbRawConnection>((resolve, reject) => {
      this.#pool.getConnection((error, connection) => {
        if (error) {
          if (this.onRuntimeObservation && connection) {
            try {
              connection.destroy();
            } catch {
              /* Discard uncertain acquisition without diagnostics. */
            }
          }
          reject(error);
        } else resolve(connection);
      });
    }).catch((error) => {
      if (this.onRuntimeObservation) throw new MariaDbRuntimeObservationError();
      throw error;
    });
    const lease: Lease = { raw, state: "ready", rollbackOnly: false, pending: new Set() };
    this.#active.add(lease);
    try {
      this.#assertOpen();
      for (const statement of initialization) await this.#query(lease, statement);
      if (this.runtimeIdentity)
        await attestMariaDbRuntimeConnection(
          (statement) => this.#query(lease, statement),
          this.runtimeIdentity,
        );
      if (this.onRuntimeObservation) {
        try {
          if (
            !this.runtimeIdentity ||
            this.runtimeIdentity.tls === "disabled" ||
            typeof raw.readRuntimeTls !== "function"
          )
            throw new MariaDbRuntimeObservationError();
          requireRuntimeObservationTls(raw.readRuntimeTls());
          const rows = await this.#query(lease, MARIADB_RUNTIME_OBSERVATION_SQL);
          requireRuntimeObservationTls(raw.readRuntimeTls());
          this.#assertOpen();
          const observation = runtimeObservationFromRows(rows, this.runtimeIdentity);
          const returned: unknown = this.onRuntimeObservation(observation);
          // Observe a genuine rejected Promise without consulting a hostile then getter.
          if (returned && (typeof returned === "object" || typeof returned === "function")) {
            try {
              void Promise.prototype.then.call(
                returned,
                () => undefined,
                () => undefined,
              );
            } catch {
              /* Non-Promise return values have no native rejection to observe. */
            }
          }
          if (returned !== undefined) {
            if (returned && (typeof returned === "object" || typeof returned === "function"))
              void Promise.resolve(returned).catch(() => {});
            throw new MariaDbRuntimeObservationError();
          }
        } catch {
          throw new MariaDbRuntimeObservationError();
        }
      }
      this.#assertOpen();
    } catch (error) {
      this.#discard(lease);
      if (this.onRuntimeObservation) throw new MariaDbRuntimeObservationError();
      throw error;
    }
    // A fresh wrapper prevents old references from reviving when the physical socket is reused.
    const connection: DatabaseConnection = {
      executeQuery: <R>(query: CompiledQuery) => this.#execute<R>(lease, query),
      streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> =>
        this.#deny(lease, "unsupported_operation"),
    };
    this.#leases.set(connection, lease);
    return connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const lease = this.#owned(connection);
    if (lease.state !== "ready" || lease.pending.size) this.#deny(lease, "transaction_state");
    if (
      (settings.isolationLevel && settings.isolationLevel !== "read committed") ||
      (settings.accessMode && settings.accessMode !== "read write")
    )
      this.#deny(lease, "transaction_settings");
    lease.state = "closing";
    try {
      // Never use SET TRANSACTION: its one-shot isolation would evade session attestation.
      await this.#query(lease, "START TRANSACTION READ WRITE");
      lease.state = "transaction";
    } catch (error) {
      this.#discard(lease);
      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const lease = this.#owned(connection);
    if (lease.state !== "transaction") this.#deny(lease, "transaction_state");
    const mustRollback = lease.rollbackOnly || lease.pending.size > 0;
    lease.state = "closing";
    // Close admission before awaiting: Kysely may still have work queued above this driver.
    await this.#settle(lease);
    if (mustRollback || lease.rollbackOnly) {
      await this.#finish(lease, "ROLLBACK");
      throw new MariaDbRollbackOnlyError();
    }
    await this.#finish(lease, "COMMIT");
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const lease = this.#owned(connection);
    // Kysely invokes rollback again after commit rejection. Do not mask the original failure.
    if (lease.state === "finished" || lease.state === "destroyed") return;
    if (lease.state !== "transaction") this.#deny(lease, "transaction_state");
    lease.state = "closing";
    await this.#settle(lease);
    await this.#finish(lease, "ROLLBACK");
  }

  async savepoint(connection: DatabaseConnection): Promise<void> {
    this.#deny(this.#owned(connection), "unsupported_operation");
  }
  async rollbackToSavepoint(connection: DatabaseConnection): Promise<void> {
    this.#deny(this.#owned(connection), "unsupported_operation");
  }
  async releaseSavepoint(connection: DatabaseConnection): Promise<void> {
    this.#deny(this.#owned(connection), "unsupported_operation");
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const lease = this.#owned(connection);
    if (lease.state === "released" || lease.state === "destroyed") return;
    if (lease.state === "closing") {
      this.#discard(lease);
      throw new MariaDbGuardError("transaction_state");
    }
    lease.state = "closing";
    await this.#settle(lease);
    try {
      // Also cleans up transactions opened inside a permitted CALL or interrupted callback.
      await this.#query(lease, "ROLLBACK");
      lease.raw.release();
      lease.state = "released";
      this.#active.delete(lease);
    } catch (error) {
      this.#discard(lease);
      throw error;
    }
  }

  async destroy(): Promise<void> {
    this.#closed = true;
    for (const lease of this.#active) this.#discard(lease);
    this.#end ??= new Promise<void>((resolve, reject) => {
      this.#pool.end((error) => (error ? reject(error) : resolve()));
    });
    await this.#end;
  }

  async #execute<R>(lease: Lease, query: CompiledQuery): Promise<QueryResult<R>> {
    try {
      if (lease.state !== "ready" && lease.state !== "transaction")
        this.#deny(lease, "connection_closed");
      if (lease.rollbackOnly) throw new MariaDbRollbackOnlyError();
      // SQL grammar beyond the first token is the server's responsibility. No comment-prefixed controls.
      // The one read-only definition lets retention inspect shell CHECKs without
      // granting ALTER or broad UPDATE. All other SHOW remains rejected.
      const retentionSchemaRead =
        (this.runtimeIdentity === undefined || this.runtimeIdentity.role === "retention") &&
        /^\s*SHOW CREATE TABLE (?:classes|`classes`)\s*$/iu.test(query.sql);
      if (
        !retentionSchemaRead &&
        !/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CALL|WITH)\b/iu.test(query.sql)
      )
        this.#deny(lease, "sql_not_allowed");
      const pending = this.#query(lease, query.sql, query.parameters);
      lease.pending.add(pending);
      try {
        return queryResult<R>(await pending);
      } finally {
        lease.pending.delete(pending);
      }
    } catch (error) {
      if (lease.state === "transaction" || lease.state === "closing") lease.rollbackOnly = true;
      throw error;
    }
  }

  #query(lease: Lease, sql: string, parameters: readonly unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (lease.state === "destroyed" || lease.state === "released") {
        reject(new MariaDbGuardError("connection_closed"));
        return;
      }
      lease.raw.query(sql, parameters, (error, result) => {
        if (error) reject(error);
        else if (lease.state === "destroyed") reject(new MariaDbGuardError("connection_closed"));
        else resolve(result);
      });
    });
  }

  async #settle(lease: Lease): Promise<void> {
    while (lease.pending.size) await Promise.allSettled([...lease.pending]);
  }

  async #finish(lease: Lease, statement: "COMMIT" | "ROLLBACK"): Promise<void> {
    try {
      await this.#query(lease, statement);
      lease.state = "finished";
    } catch (error) {
      this.#discard(lease);
      throw error;
    }
  }

  #deny(lease: Lease, code: GuardCode): never {
    if (lease.state === "transaction" || lease.state === "closing") lease.rollbackOnly = true;
    throw new MariaDbGuardError(code);
  }

  #owned(connection: DatabaseConnection): Lease {
    const lease = this.#leases.get(connection);
    if (!lease) throw new MariaDbGuardError("foreign_connection");
    return lease;
  }

  #assertOpen(): void {
    if (this.#closed) throw new MariaDbGuardError("driver_closed");
  }

  #discard(lease: Lease): void {
    if (lease.state === "destroyed" || lease.state === "released") return;
    lease.state = "destroyed";
    this.#active.delete(lease);
    try {
      lease.raw.destroy();
    } catch {
      /* Never return an uncertain connection to the pool. */
    }
  }
}
