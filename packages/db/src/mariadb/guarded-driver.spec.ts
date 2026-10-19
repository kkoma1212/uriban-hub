import { CompiledQuery, Kysely, MysqlDialect, type DatabaseConnection, type Driver } from "kysely";
import { describe, expect, it } from "vitest";
import {
  MariaDbDriver,
  MariaDbGuardError,
  MariaDbRollbackOnlyError,
  type MariaDbPool,
  type MariaDbRawConnection,
} from "./guarded-driver.js";

const writeSql = "INSERT INTO sample(value) VALUES (?)";
const readSql = "SELECT value FROM sample";
const statement = (text = writeSql) => CompiledQuery.raw(text, text === writeSql ? ["value"] : []);
type Callback = (error: unknown, result: unknown) => void;

// A transactional fake tracks durable writes, rather than merely matching driver call order.
class RawConnection implements MariaDbRawConnection {
  readonly commands: string[] = [];
  readonly parameters: (readonly unknown[])[] = [];
  readonly failures = new Map<string, Error>();
  readonly held = new Map<string, Callback>();
  hold: string | undefined;
  releaseFailure: Error | undefined;
  commitAcknowledgementLost = false;
  nextResult: unknown;
  committed = 0;
  staged = 0;
  transaction = false;
  releases = 0;
  destroys = 0;

  query(sql: string, parameters: readonly unknown[], callback: Callback): void {
    this.commands.push(sql);
    this.parameters.push(parameters);
    if (sql === this.hold) {
      this.held.set(sql, callback);
      return;
    }
    queueMicrotask(() => this.complete(sql, callback));
  }

  finishHeld(sql: string): void {
    const callback = this.held.get(sql);
    if (!callback) throw new Error("test query was not pending");
    this.held.delete(sql);
    this.complete(sql, callback);
  }

  private complete(sql: string, callback: Callback): void {
    const failure = this.failures.get(sql);
    if (failure) {
      this.failures.delete(sql);
      callback(failure, undefined);
      return;
    }
    if (sql === "START TRANSACTION READ WRITE") {
      this.transaction = true;
      this.staged = 0;
    }
    if (sql === "ROLLBACK") {
      this.transaction = false;
      this.staged = 0;
    }
    if (sql === "COMMIT") {
      this.committed += this.staged;
      this.staged = 0;
      this.transaction = false;
      if (this.commitAcknowledgementLost) {
        callback(new Error("connection lost"), undefined);
        return;
      }
    }
    if (sql === writeSql) {
      if (this.transaction) this.staged++;
      else this.committed++;
    }
    const result =
      this.nextResult ??
      (sql === readSql
        ? [{ value: "row" }]
        : { affectedRows: sql === writeSql ? 1 : 0, insertId: 0 });
    this.nextResult = undefined;
    callback(null, result);
  }

  release(): void {
    if (this.releaseFailure) throw this.releaseFailure;
    this.releases++;
  }
  destroy(): void {
    this.destroys++;
    this.staged = 0;
    this.transaction = false;
  }
}

class Pool implements MariaDbPool {
  readonly raw = new RawConnection();
  ends = 0;
  endFailure: Error | undefined;
  getConnection(callback: (error: unknown, connection: MariaDbRawConnection) => void): void {
    callback(null, this.raw);
  }
  end(callback: (error: unknown) => void): void {
    this.ends++;
    callback(this.endFailure);
  }
}

class Dialect extends MysqlDialect {
  constructor(private readonly guarded: Driver) {
    super({
      pool: async () => {
        throw new Error("default MySQL driver must not be used");
      },
    });
  }
  override createDriver(): Driver {
    return this.guarded;
  }
}

function setup() {
  const pool = new Pool();
  const driver = new MariaDbDriver(pool);
  const db = new Kysely<{ sample: { value: string } }>({ dialect: new Dialect(driver) });
  return { pool, raw: pool.raw, driver, db };
}

describe("MariaDbDriver transaction boundary", () => {
  it("allows only the fixed shell definition read", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    await connection.executeQuery(statement("SHOW CREATE TABLE `classes`"));
    expect(raw.commands).toContain("SHOW CREATE TABLE `classes`");
    await driver.releaseConnection(connection);
    await driver.destroy();
  });
  it("commits a successful Kysely callback and preserves rows/parameters", async () => {
    const { db, raw } = setup();
    const result = await db.transaction().execute(async (trx) => {
      const affected = await trx.executeQuery(statement());
      expect(affected.numAffectedRows).toBe(1n);
      return trx.executeQuery<{ value: string }>(statement(readSql));
    });
    expect(result.rows).toEqual([{ value: "row" }]);
    expect(raw.parameters[raw.commands.indexOf(writeSql)]).toEqual(["value"]);
    expect(raw.committed).toBe(1);
    expect(raw.commands.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(raw.commands.at(-1)).toBe("ROLLBACK");
    expect(raw.releases).toBe(1);
    await db.destroy();
  });

  it("rolls back the entire transaction when the callback throws after a successful write", async () => {
    const { db, raw } = setup();
    const failure = new Error("callback failure");
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.executeQuery(statement());
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    expect(raw.commands).not.toContain("COMMIT");
    expect(raw.releases).toBe(1);
    await db.destroy();
  });

  it("rejects commit after a native error was caught and prevents subsequent writes", async () => {
    const { db, raw } = setup();
    const failure = new Error("native statement failure");
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.executeQuery(statement());
        raw.failures.set(readSql, failure);
        await expect(trx.executeQuery(statement(readSql))).rejects.toBe(failure);
        await expect(trx.executeQuery(statement())).rejects.toBeInstanceOf(
          MariaDbRollbackOnlyError,
        );
        return "caught and ignored";
      }),
    ).rejects.toBeInstanceOf(MariaDbRollbackOnlyError);
    expect(raw.commands.filter((sql) => sql === writeSql)).toHaveLength(1);
    expect(raw.commands).not.toContain("COMMIT");
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    expect(raw.releases).toBe(1);
    await db.destroy();
  });

  it("does not return a socket whose rollback failed, preserving the cleanup error", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await connection.executeQuery(statement());
    const failure = new Error("rollback failed");
    raw.failures.set("ROLLBACK", failure);
    await expect(driver.rollbackTransaction(connection)).rejects.toBe(failure);
    await driver.releaseConnection(connection);
    expect(raw.destroys).toBe(1);
    expect(raw.releases).toBe(0);
    expect(raw.committed).toBe(0);
    await expect(connection.executeQuery(statement())).rejects.toBeInstanceOf(MariaDbGuardError);
    await driver.destroy();
  });

  it("destroys an uncertain COMMIT connection without claiming that an acknowledged-lost commit rolled back", async () => {
    const { db, raw } = setup();
    raw.commitAcknowledgementLost = true;
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.executeQuery(statement());
      }),
    ).rejects.toThrow("connection lost");
    expect(raw.committed).toBe(1); // An ambiguous commit must never be advertised as safely retryable.
    expect(raw.destroys).toBe(1);
    expect(raw.releases).toBe(0);
    expect(raw.commands.at(-1)).toBe("COMMIT");
    await db.destroy();
  });

  it("waits for in-flight work, rejects commit, closes admission and then rolls back", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    raw.hold = writeSql;
    const writing = connection.executeQuery(statement());
    const committing = expect(driver.commitTransaction(connection)).rejects.toBeInstanceOf(
      MariaDbRollbackOnlyError,
    );
    await expect(connection.executeQuery(statement(readSql))).rejects.toBeInstanceOf(
      MariaDbGuardError,
    );
    expect(raw.commands.at(-1)).toBe(writeSql);
    raw.finishHeld(writeSql);
    await writing;
    await committing;
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    expect(raw.commands).not.toContain("COMMIT");
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  it("rolls back a Promise.all failure and denies queued work after callback completion", async () => {
    const { db, raw } = setup();
    raw.failures.set(readSql, new Error("first parallel query fails"));
    const writes: Promise<unknown>[] = [];
    await expect(
      db.transaction().execute(async (trx) => {
        const reading = trx.executeQuery(statement(readSql));
        const writing = trx.executeQuery(statement());
        writes.push(writing.catch(() => undefined));
        await Promise.all([reading, writing]).catch(() => undefined);
      }),
    ).rejects.toBeInstanceOf(MariaDbRollbackOnlyError);
    await Promise.all(writes);
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    expect(raw.commands).not.toContain("COMMIT");
    await db.destroy();
  });

  it("rejects a Kysely callback that leaves an already-started query unawaited", async () => {
    const { db, raw } = setup();
    raw.hold = writeSql;
    let pending: Promise<unknown> | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const transaction = db.transaction().execute(async (trx) => {
      pending = trx.executeQuery(statement());
      // Let Kysely's connection provider deliver the query before ending the callback.
      while (!raw.held.has(writeSql)) await Promise.resolve();
      signalStarted?.();
    });
    const rejected = expect(transaction).rejects.toBeInstanceOf(MariaDbRollbackOnlyError);
    await started;
    await Promise.resolve();
    raw.finishHeld(writeSql);
    await pending;
    await rejected;
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    await db.destroy();
  });
});

describe("MariaDbDriver reservation and control boundary", () => {
  it("resets every reservation and never revives a released wrapper on socket reuse", async () => {
    const { driver, raw } = setup();
    const first = await driver.acquireConnection();
    const initial = [...raw.commands];
    expect(initial).toHaveLength(6);
    expect(initial[0]).toBe("ROLLBACK");
    expect(initial[1]).toBe("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(initial[2]).toContain("'+00:00'");
    expect(initial[3]).toBe("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    expect(initial[4]).toContain("STRICT_ALL_TABLES");
    expect(initial[4]).toContain("TIME_ROUND_FRACTIONAL");
    expect(initial[5]).toBe("SET SESSION autocommit = 1");
    await driver.releaseConnection(first);
    const start = raw.commands.length;
    const second = await driver.acquireConnection();
    expect(second).not.toBe(first);
    expect(raw.commands.slice(start)).toEqual(initial);
    const before = raw.commands.length;
    await expect(first.executeQuery(statement())).rejects.toMatchObject({
      code: "connection_closed",
    });
    expect(raw.commands).toHaveLength(before);
    await second.executeQuery(statement(readSql));
    await driver.releaseConnection(second);
    await driver.destroy();
  });

  it("physically discards any reservation initialization failure", async () => {
    for (const control of [
      "ROLLBACK",
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "SET SESSION time_zone = '+00:00'",
      "SET NAMES utf8mb4 COLLATE utf8mb4_bin",
      "SET SESSION autocommit = 1",
    ]) {
      const { driver, raw } = setup();
      const failure = new Error("initialization failed");
      raw.failures.set(control, failure);
      await expect(driver.acquireConnection()).rejects.toBe(failure);
      expect(raw.destroys).toBe(1);
      expect(raw.releases).toBe(0);
      expect(raw.commands.at(-1)).toBe(control);
      await driver.destroy();
    }
  });

  it("discards failed release cleanup, and a release exception cannot make the wrapper reusable", async () => {
    for (const cleanup of [true, false]) {
      const { driver, raw } = setup();
      const connection = await driver.acquireConnection();
      const failure = new Error("release failed");
      if (cleanup) raw.failures.set("ROLLBACK", failure);
      else raw.releaseFailure = failure;
      await expect(driver.releaseConnection(connection)).rejects.toBe(failure);
      expect(raw.destroys).toBe(1);
      expect(raw.releases).toBe(0);
      await expect(connection.executeQuery(statement())).rejects.toMatchObject({
        code: "connection_closed",
      });
      await driver.destroy();
    }
  });

  it("cleans up an uncommitted transaction on release and permits a fresh successful transaction", async () => {
    const { driver, raw } = setup();
    const first = await driver.acquireConnection();
    await driver.beginTransaction(first, {});
    await first.executeQuery(statement());
    await driver.releaseConnection(first);
    expect(raw.committed).toBe(0);
    expect(raw.staged).toBe(0);
    const second = await driver.acquireConnection();
    await driver.beginTransaction(second, {
      isolationLevel: "read committed",
      accessMode: "read write",
    });
    await second.executeQuery(statement());
    await driver.commitTransaction(second);
    await driver.releaseConnection(second);
    expect(raw.committed).toBe(1);
    expect(raw.commands.some((sql) => /^SET TRANSACTION\b/u.test(sql))).toBe(false);
    await driver.destroy();
  });

  it("rejects alternate isolation/access modes before BEGIN and poisons unsupported nested controls", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    for (const isolationLevel of [
      "read uncommitted",
      "repeatable read",
      "serializable",
      "snapshot",
    ] as const)
      await expect(driver.beginTransaction(connection, { isolationLevel })).rejects.toMatchObject({
        code: "transaction_settings",
      });
    await expect(
      driver.beginTransaction(connection, { accessMode: "read only" }),
    ).rejects.toMatchObject({ code: "transaction_settings" });
    expect(raw.commands).not.toContain("START TRANSACTION READ WRITE");
    await driver.beginTransaction(connection, {});
    await expect(driver.beginTransaction(connection, {})).rejects.toMatchObject({
      code: "transaction_state",
    });
    await expect(driver.commitTransaction(connection)).rejects.toBeInstanceOf(
      MariaDbRollbackOnlyError,
    );
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  it("blocks transaction/session/DDL controls and leading comments without sending SQL", async () => {
    for (const sql of [
      "COMMIT",
      "ROLLBACK",
      "BEGIN",
      "START TRANSACTION",
      "SAVEPOINT a",
      "SET SESSION autocommit=1",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "USE other",
      "CREATE TABLE a(id INT)",
      "ALTER TABLE a ADD b INT",
      "DROP TABLE a",
      "TRUNCATE a",
      "SHOW CREATE TABLE users",
      "SHOW CREATE TABLE classes; DROP TABLE users",
      "SHOW TABLES",
      "-- comment\nSELECT 1",
      "/* comment */ SELECT 1",
      "/*! SET autocommit=1 */",
      "# comment\nSELECT 1",
    ]) {
      const { driver, raw } = setup();
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      const count = raw.commands.length;
      await expect(connection.executeQuery(statement(sql))).rejects.toMatchObject({
        code: "sql_not_allowed",
      });
      expect(raw.commands).toHaveLength(count);
      await expect(driver.commitTransaction(connection)).rejects.toBeInstanceOf(
        MariaDbRollbackOnlyError,
      );
      expect(raw.commands).not.toContain("COMMIT");
      await driver.releaseConnection(connection);
      await driver.destroy();
    }
  });

  it("poisons unsupported streams and all savepoint operations even when the caller catches them", async () => {
    const operations: ((driver: MariaDbDriver, connection: DatabaseConnection) => unknown)[] = [
      (_, connection) => connection.streamQuery(statement(readSql), 10),
      (driver, connection) => driver.savepoint(connection),
      (driver, connection) => driver.rollbackToSavepoint(connection),
      (driver, connection) => driver.releaseSavepoint(connection),
    ];
    for (const operation of operations) {
      const { driver, raw } = setup();
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      await expect(
        Promise.resolve().then(() => operation(driver, connection)),
      ).rejects.toMatchObject({ code: "unsupported_operation" });
      await expect(driver.commitTransaction(connection)).rejects.toBeInstanceOf(
        MariaDbRollbackOnlyError,
      );
      expect(raw.commands).not.toContain("COMMIT");
      await driver.releaseConnection(connection);
      await driver.destroy();
    }
  });

  it("destroys active sockets, ends its owned pool only once and rejects later acquisition", async () => {
    const { driver, pool, raw } = setup();
    const connection = await driver.acquireConnection();
    await driver.destroy();
    await driver.destroy();
    expect(pool.ends).toBe(1);
    expect(raw.destroys).toBe(1);
    expect(raw.releases).toBe(0);
    await expect(driver.acquireConnection()).rejects.toMatchObject({ code: "driver_closed" });
    await expect(connection.executeQuery(statement())).rejects.toMatchObject({
      code: "connection_closed",
    });
  });
});

describe("MariaDbDriver result and diagnostic boundary", () => {
  it("preserves exact bigint packet values and omits the zero insert id", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    raw.nextResult = {
      affectedRows: "18446744073709551615",
      changedRows: 2,
      insertId: "9223372036854775807",
    };
    expect(await connection.executeQuery(statement())).toEqual({
      rows: [],
      numAffectedRows: 18446744073709551615n,
      numChangedRows: 2n,
      insertId: 9223372036854775807n,
    });
    raw.nextResult = { affectedRows: 0, insertId: 0 };
    expect(await connection.executeQuery(statement())).toEqual({ rows: [], numAffectedRows: 0n });
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  it("refuses already-rounded numeric packet values and rolls back their writes", async () => {
    const { driver, raw } = setup();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    raw.nextResult = { affectedRows: 1, insertId: Number.MAX_SAFE_INTEGER + 1 };
    await expect(connection.executeQuery(statement())).rejects.toMatchObject({
      code: "unsafe_integer",
    });
    await expect(driver.commitTransaction(connection)).rejects.toBeInstanceOf(
      MariaDbRollbackOnlyError,
    );
    expect(raw.committed).toBe(0);
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  it("uses fixed guard messages without copying rejected SQL or credentials", async () => {
    const { driver } = setup();
    const connection = await driver.acquireConnection();
    const result = connection.executeQuery(
      statement("SET @secret='mysql://private:password@host/customer'"),
    );
    await expect(result).rejects.toThrow(
      "MariaDB guarded driver rejected operation: sql_not_allowed",
    );
    await expect(result).rejects.not.toThrow("private");
    await driver.releaseConnection(connection);
    await driver.destroy();
  });
});
