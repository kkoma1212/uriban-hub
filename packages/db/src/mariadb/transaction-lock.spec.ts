import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { TransactionLockMode } from "../transaction-lock.js";
import { createMariaDbDatabase } from "./connection.js";
import { MariaDbRollbackOnlyError, type MariaDbRawConnection } from "./guarded-driver.js";
import {
  createMariaDbRegisteredTransactionLockManager,
  mariaDbRegisteredTransactionLockIdentities,
  MariaDbTransactionLockError,
} from "./transaction-lock.js";

const lifecycle = "classhub:operator-lifecycle",
  meal = "classhub:meal-import";
type Database = { lock_probe: { value: number } };
type Row = Record<string, unknown>;
const manager = createMariaDbRegisteredTransactionLockManager<Database>();

// No lock/state engine: fixed server responses exercise real Kysely and the
// guarded transaction boundary. S/X contention and MariaDB syntax need real QA.
class Connection implements MariaDbRawConnection {
  commands: { statement: string; parameters: readonly unknown[] }[] = [];
  seed: Row[] | undefined;
  locked: Row[] | undefined;
  failure: unknown;
  staged = 0;
  committed = 0;
  commits = 0;
  begins = 0;
  lostCommit = false;
  destroys = 0;
  query(
    statement: string,
    parameters: readonly unknown[],
    callback: (error: unknown, result: unknown) => void,
  ) {
    statement = statement.trim().replaceAll(/\s+/gu, " ");
    this.commands.push({ statement, parameters });
    queueMicrotask(() => {
      if (statement.includes("FROM transaction_lock_keys")) {
        if (this.failure) return callback(this.failure, undefined);
        const digest = Buffer.from(parameters[0] as Buffer);
        return callback(
          null,
          statement.includes("@@in_transaction")
            ? (this.seed ?? [
                { lock_digest: digest, in_transaction: 1, isolation_level: "READ-COMMITTED" },
              ])
            : (this.locked ?? [{ lock_digest: digest }]),
        );
      }
      if (statement.startsWith("START TRANSACTION")) {
        this.begins++;
        this.staged = 0;
      } else if (statement === "ROLLBACK") this.staged = 0;
      else if (statement === "INSERT INTO lock_probe(value) VALUES (1)") this.staged++;
      else if (statement === "COMMIT") {
        this.commits++;
        this.committed += this.staged;
        this.staged = 0;
        if (this.lostCommit)
          return callback(new Error("synthetic acknowledgement lost"), undefined);
      }
      callback(null, { affectedRows: 0, insertId: 0 });
    });
  }
  release() {}
  destroy() {
    this.destroys++;
    this.staged = 0;
  }
}
const databases: Kysely<Database>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});
function setup() {
  const raw = new Connection();
  const db = createMariaDbDatabase<Database>(
    () => ({
      getConnection: (callback) => callback(null, raw),
      end: (callback) => callback(null),
    }),
    {
      host: "qa.invalid",
      database: "qa",
      user: "qa_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----",
    },
  );
  databases.push(db);
  return { raw, db };
}
const ownError = (reason: string) => ({ code: "MARIADB_TRANSACTION_LOCK_REJECTED", reason });
const lockingQueries = (raw: Connection) =>
  raw.commands.filter(
    ({ statement }) =>
      statement.includes("FROM transaction_lock_keys") && !statement.includes("@@in_transaction"),
  );
const write = (tx: Transaction<Database>) =>
  sql`INSERT INTO lock_probe(value) VALUES (1)`.execute(tx);

describe("MariaDB registered transaction-lock candidate", () => {
  it("publishes exactly five immutable registered identities", () => {
    expect(mariaDbRegisteredTransactionLockIdentities).toEqual([
      lifecycle,
      meal,
      "classhub:school-import",
      "classhub:school-schedule-import",
      "classhub:public-holiday-import",
    ]);
    expect(Object.isFrozen(mariaDbRegisteredTransactionLockIdentities)).toBe(true);
  });
  for (const mode of ["shared", "exclusive"] as const)
    it.each(mariaDbRegisteredTransactionLockIdentities)(
      `binds only SHA-256 and acquires ${mode}: %s`,
      async (identity) => {
        const { db, raw } = setup();
        await db.transaction().execute((tx) => manager.acquire(tx, identity, mode));
        const expected = createHash("sha256")
          .update("classhub:mariadb:transaction-lock:v1:pg-hashtextextended:0\0", "utf8")
          .update(identity, "utf8")
          .digest();
        const queries = raw.commands.filter(({ statement }) =>
          statement.includes("FROM transaction_lock_keys"),
        );
        expect(queries).toHaveLength(2);
        for (const query of queries) {
          expect(query.parameters).toEqual([expected]);
          expect(query.statement).not.toContain(identity);
        }
        expect(queries[1]!.statement).toContain(
          mode === "shared" ? "LOCK IN SHARE MODE" : "FOR UPDATE",
        );
        expect(queries[1]!.statement).not.toMatch(
          /SKIP LOCKED|NOWAIT|GET_LOCK|INSERT|UPDATE transaction_lock_keys|DELETE/u,
        );
        expect(raw.commits).toBe(1);
      },
    );
  it("defaults to exclusive and rechecks committed seed presence on every acquisition", async () => {
    const { db, raw } = setup();
    await db.transaction().execute(async (tx) => {
      await manager.acquire(tx, meal);
      await manager.acquire(tx, meal);
    });
    expect(lockingQueries(raw)).toHaveLength(2);
    expect(lockingQueries(raw).every(({ statement }) => statement.endsWith("FOR UPDATE"))).toBe(
      true,
    );
    expect(
      raw.commands.filter(({ statement }) => statement.includes("@@in_transaction")),
    ).toHaveLength(2);
    expect(lockingQueries(raw)[0]!.parameters).toEqual(lockingQueries(raw)[1]!.parameters);
    expect(lockingQueries(raw)[0]!.parameters[0]).not.toBe(lockingQueries(raw)[1]!.parameters[0]);
  });
  it.each(["shared", "exclusive"] as const)("try %s success uses SKIP LOCKED", async (mode) => {
    const { db, raw } = setup();
    await expect(
      db.transaction().execute((tx) => manager.tryAcquire(tx, lifecycle, mode)),
    ).resolves.toBe(true);
    expect(lockingQueries(raw)[0]!.statement).toContain(
      mode === "shared" ? "LOCK IN SHARE MODE SKIP LOCKED" : "FOR UPDATE SKIP LOCKED",
    );
  });
  it.each(["shared", "exclusive"] as const)(
    "try %s false still commits writes before and after it",
    async (mode) => {
      const { db, raw } = setup();
      raw.locked = [];
      await db.transaction().execute(async (tx) => {
        await write(tx);
        expect(await manager.tryAcquire(tx, lifecycle, mode)).toBe(false);
        await write(tx);
      });
      expect(raw.committed).toBe(2);
      expect(raw.commits).toBe(1);
      expect(raw.begins).toBe(1);
    },
  );
  it.each(["", null, 1])(
    "rejects invalid identity %o before acquiring a connection",
    async (identity) => {
      const { db, raw } = setup();
      await expect(
        manager.acquire(db as Transaction<Database>, identity as never),
      ).rejects.toMatchObject(ownError("invalid_identity"));
      expect(raw.commands).toEqual([]);
    },
  );
  it.each([
    "admin-account:private@example.invalid",
    "CLASSHUB:MEAL-IMPORT",
    "classhub:meal-import ",
    "1",
    "classhub.attendance_notifications.retention.v1",
  ])("rejects unregistered/dynamic/key-space input without disclosure: %s", async (identity) => {
    const { db, raw } = setup();
    const error: unknown = await manager
      .tryAcquire(db as Transaction<Database>, identity)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MariaDbTransactionLockError);
    expect(error).toMatchObject(ownError("unregistered_identity"));
    expect(JSON.stringify(error) + String(error)).not.toContain(identity);
    expect(error).not.toHaveProperty("cause");
    expect(raw.commands).toEqual([]);
  });
  it.each(["", "read", null])("rejects invalid mode %o before SQL", async (mode) => {
    const { db, raw } = setup();
    await expect(
      manager.acquire(db as Transaction<Database>, lifecycle, mode as TransactionLockMode),
    ).rejects.toMatchObject(ownError("invalid_mode"));
    expect(raw.commands).toEqual([]);
  });
  it("requires an actual Kysely transaction", async () => {
    const { db, raw } = setup();
    await expect(manager.acquire(db as Transaction<Database>, lifecycle)).rejects.toMatchObject(
      ownError("transaction_required"),
    );
    expect(raw.commands).toEqual([]);
  });
  it.each([false, true])("missing seed is an error, never false (try=%s)", async (tryOnly) => {
    const { db, raw } = setup();
    raw.seed = [];
    await expect(
      db.transaction().execute(async (tx) => {
        if (tryOnly) await manager.tryAcquire(tx, lifecycle);
        else await manager.acquire(tx, lifecycle);
      }),
    ).rejects.toMatchObject(ownError("seed_missing"));
    expect(lockingQueries(raw)).toEqual([]);
    expect(raw.commits).toBe(0);
  });
  it.each([
    { result: [] },
    { result: [{}] },
    { result: [{ lock_digest: Buffer.alloc(31) }] },
    { result: [{ lock_digest: Buffer.alloc(32) }] },
  ])("blocking acquire rejects malformed/missing result %o", async ({ result }) => {
    const { db, raw } = setup();
    raw.locked = result;
    await expect(db.transaction().execute((tx) => manager.acquire(tx, meal))).rejects.toMatchObject(
      ownError("invalid_result"),
    );
    expect(raw.commits).toBe(0);
  });
  it.each([
    { in_transaction: 0, isolation_level: "READ-COMMITTED", reason: "transaction_required" },
    { in_transaction: 1, isolation_level: "REPEATABLE-READ", reason: "transaction_settings" },
  ])("rejects server transaction/session mismatch %o", async ({ reason, ...fields }) => {
    const { db, raw } = setup();
    const digest = createHash("sha256")
      .update("classhub:mariadb:transaction-lock:v1:pg-hashtextextended:0\0" + lifecycle)
      .digest();
    raw.seed = [{ lock_digest: digest, ...fields }];
    await expect(
      db.transaction().execute((tx) => manager.acquire(tx, lifecycle)),
    ).rejects.toMatchObject(ownError(reason));
    expect(lockingQueries(raw)).toEqual([]);
  });
  it.each([
    { errno: 1205, sqlState: "HY000" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1142, sqlState: "42000" },
  ])("preserves native %o and rollback-only when the caller catches it", async (native) => {
    const { db, raw } = setup();
    raw.failure = native;
    await expect(
      db.transaction().execute(async (tx) => {
        await write(tx);
        await expect(manager.tryAcquire(tx, meal)).rejects.toBe(native);
      }),
    ).rejects.toBeInstanceOf(MariaDbRollbackOnlyError);
    expect(raw.begins).toBe(1);
    expect(raw.commits).toBe(0);
    expect(raw.committed).toBe(0);
  });
  it("does not retry a lost COMMIT acknowledgement", async () => {
    const { db, raw } = setup();
    raw.lostCommit = true;
    await expect(
      db.transaction().execute(async (tx) => {
        await manager.acquire(tx, lifecycle);
        await write(tx);
      }),
    ).rejects.toThrow("synthetic acknowledgement lost");
    expect(raw.begins).toBe(1);
    expect(raw.commits).toBe(1);
    expect(raw.committed).toBe(1);
    expect(raw.destroys).toBe(1);
  });
});
