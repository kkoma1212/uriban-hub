import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createMariaDbDatabase } from "./connection.js";
import type { MariaDbRawConnection } from "./guarded-driver.js";
import {
  createMariaDbWorkerAuditLockManager,
  type PreparedWorkerAuditLock,
} from "./worker-audit-lock.js";

type Database = { sample: { value: number } };
const identity =
  '["authz.denied","9007199254740993","192.0.2.1",null,"private.resource","role_insufficient"]';
const domain = "classhub:mariadb:worker-audit-lock:v1:pg-hashtextextended:0\0";
const digest = (value = identity) => createHash("sha256").update(domain).update(value).digest();
const native = (errno = 1062, sqlState = "23000") => ({ errno, sqlState });
const insertion = (statement: string) =>
  statement.startsWith("INSERT INTO worker_security_audit_lock_keys");
const lookup = (statement: string) => statement.includes("FROM worker_security_audit_lock_keys");

// A single available lease and staged registrations model rollback boundaries,
// not row contention. Real MariaDB QA owns lock scheduling and SQL semantics.
class Connection implements MariaDbRawConnection {
  commands: { statement: string; parameters: readonly unknown[] }[] = [];
  events: string[] = [];
  registered = new Set<string>();
  pending = new Set<string>();
  leased = false;
  acquires = 0;
  commits = 0;
  destroys = 0;
  collision: "winner" | "missing" | undefined;
  fault: ((statement: string) => unknown) | undefined;
  commitFailure: unknown;
  affectedRows = 1;
  isolation = "READ-COMMITTED";
  rowOverride: unknown[] | undefined;
  query(
    statement: string,
    parameters: readonly unknown[],
    callback: (e: unknown, r: unknown) => void,
  ) {
    statement = statement.trim().replaceAll(/\s+/gu, " ");
    this.events.push(statement);
    this.commands.push({ statement, parameters });
    queueMicrotask(() => {
      const failure = this.fault?.(statement);
      if (failure !== undefined) return callback(failure, undefined);
      if (statement === "ROLLBACK") this.pending.clear();
      if (statement === "COMMIT") {
        this.commits++;
        for (const key of this.pending) this.registered.add(key);
        this.pending.clear();
        if (this.commitFailure) return callback(this.commitFailure, undefined);
      }
      if (lookup(statement)) {
        const key = (parameters[0] as Buffer).toString("hex");
        const result =
          this.registered.has(key) || this.pending.has(key)
            ? [
                {
                  lock_digest: Buffer.from(key, "hex"),
                  in_transaction: 1,
                  isolation_level: this.isolation,
                },
              ]
            : [];
        return callback(null, this.rowOverride ?? result);
      }
      if (insertion(statement)) {
        const key = (parameters[0] as Buffer).toString("hex");
        if (this.collision) {
          if (this.collision === "winner") this.registered.add(key);
          return callback(native(), undefined);
        }
        this.pending.add(key);
        return callback(null, { affectedRows: this.affectedRows, insertId: 0 });
      }
      callback(null, { affectedRows: 0, insertId: 0 });
    });
  }
  release() {
    this.events.push("release");
    this.leased = false;
  }
  destroy() {
    this.events.push("destroy");
    this.leased = false;
    this.pending.clear();
    this.destroys++;
  }
}
const opened: Kysely<Database>[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.destroy()));
});
function setup() {
  const raw = new Connection();
  const db = createMariaDbDatabase<Database>(
    () => ({
      getConnection(callback) {
        if (raw.leased)
          return callback(new Error("Second simultaneous lease from capacity-one pool"), raw);
        raw.leased = true;
        raw.acquires++;
        raw.events.push("acquire");
        callback(null, raw);
      },
      end: (callback) => callback(null),
    }),
    {
      host: "qa.invalid",
      database: "qa",
      user: "qa_worker",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----",
      connectionLimit: 1,
    },
  );
  opened.push(db);
  return { db, raw, manager: createMariaDbWorkerAuditLockManager<Database>() };
}
const rejected = (reason: string) => ({ code: "MARIADB_WORKER_AUDIT_LOCK_REJECTED", reason });

describe("worker audit dynamic preparation boundary", () => {
  it("commits preparation and releases the one connection before business acquisition", async () => {
    const { db, raw, manager } = setup();
    const handle = await manager.prepare(db, identity);
    expect(raw.commits).toBe(1);
    expect(raw.leased).toBe(false);
    expect(raw.registered).toEqual(new Set([digest().toString("hex")]));
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.keys(handle)).toEqual([]);
    expect(JSON.stringify(handle)).toBe("{}");
    await db.transaction().execute(async (tx) => {
      await manager.acquire(tx, handle);
      await sql`SELECT 1 AS usable`.execute(tx);
    });
    expect(raw.commits).toBe(2);
    expect(raw.acquires).toBe(2);
    for (const query of raw.commands.filter(
      ({ statement }) => insertion(statement) || lookup(statement),
    ))
      expect(query.parameters).toEqual([digest()]);
    expect(JSON.stringify(raw.commands)).not.toContain(identity);
    expect(raw.commands.filter(({ statement }) => statement.includes("FOR UPDATE"))).toHaveLength(
      1,
    );
    expect(
      raw.commands.some(({ statement }) =>
        /IGNORE|ON DUPLICATE|DELETE FROM|GET_LOCK/u.test(statement),
      ),
    ).toBe(false);
  });
  it("already registered scopes only read, without INSERT or an UPDATE", async () => {
    const { db, raw, manager } = setup();
    raw.registered.add(digest().toString("hex"));
    await manager.prepare(db, identity);
    expect(raw.commands.filter(({ statement }) => insertion(statement))).toHaveLength(0);
    expect(raw.commits).toBe(1);
  });
  it("only INSERT 1062 rolls back and releases before fresh winner lookup", async () => {
    const { db, raw, manager } = setup();
    raw.collision = "winner";
    const handle = await manager.prepare(db, identity);
    const insertIndex = raw.events.findIndex(insertion);
    const rollbackIndex = raw.events.indexOf("ROLLBACK", insertIndex + 1);
    const releaseIndex = raw.events.indexOf("release", rollbackIndex + 1);
    const freshIndex = raw.events.findIndex(
      (statement, index) => index > releaseIndex && lookup(statement),
    );
    expect(rollbackIndex).toBeGreaterThan(insertIndex);
    expect(releaseIndex).toBeGreaterThan(rollbackIndex);
    expect(freshIndex).toBeGreaterThan(releaseIndex);
    expect(raw.commits).toBe(0);
    expect(raw.acquires).toBe(2);
    await db.transaction().execute((tx) => manager.acquire(tx, handle));
    expect(raw.commits).toBe(1);
  });
  it("missing registration after collision is an error instead of a usable handle", async () => {
    const { db, raw, manager } = setup();
    raw.collision = "missing";
    await expect(manager.prepare(db, identity)).rejects.toMatchObject(
      rejected("registration_missing"),
    );
    expect(raw.acquires).toBe(2);
    expect(raw.commits).toBe(0);
  });
  it("1062 from SELECT is not misclassified as a registration race", async () => {
    const { db, raw, manager } = setup();
    const error = native();
    raw.fault = (statement) => (lookup(statement) ? error : undefined);
    await expect(manager.prepare(db, identity)).rejects.toBe(error);
    expect(raw.acquires).toBe(1);
  });
  it.each([
    native(1213, "40001"),
    native(1205, "HY000"),
    native(1062, "45000"),
    native(1142, "42000"),
  ])("does not retry non-registration INSERT failure %o", async (error) => {
    const { db, raw, manager } = setup();
    raw.fault = (statement) => (insertion(statement) ? error : undefined);
    await expect(manager.prepare(db, identity)).rejects.toBe(error);
    expect(raw.acquires).toBe(1);
    expect(raw.commits).toBe(0);
  });
  it.each([new Error("synthetic COMMIT acknowledgement loss"), native()])(
    "COMMIT failure never becomes successful preparation: %o",
    async (error) => {
      const { db, raw, manager } = setup();
      raw.commitFailure = error;
      await expect(manager.prepare(db, identity)).rejects.toBe(error);
      expect(raw.registered.size).toBe(1);
      expect(raw.acquires).toBe(1);
      expect(raw.destroys).toBe(1);
    },
  );
  it("rollback failure during collision prevents fresh lookup and preparation success", async () => {
    const { db, raw, manager } = setup();
    const error = new Error("synthetic rollback failure");
    raw.collision = "winner";
    raw.fault = (statement) =>
      statement === "ROLLBACK" && raw.registered.size > 0 ? error : undefined;
    await expect(manager.prepare(db, identity)).rejects.toBe(error);
    expect(raw.acquires).toBe(1);
    expect(raw.destroys).toBe(1);
  });
  it.each(["", null, 42, "a".repeat(4097), "가".repeat(1366), "x\0y", "x\uD800"])(
    "rejects invalid/bounded identity without SQL or PII: %o",
    async (value) => {
      const { db, raw, manager } = setup();
      const error: unknown = await manager
        .prepare(db, value as never)
        .catch((error: unknown) => error);
      expect(error).toMatchObject(rejected("invalid_identity"));
      expect(raw.acquires).toBe(0);
      if (typeof value === "string" && value.length > 0)
        expect(JSON.stringify(error)).not.toContain(value);
    },
  );
  it.each(["a".repeat(4096), "가".repeat(1365)])(
    "accepts the UTF-8 byte boundary",
    async (value) => {
      const { db, manager } = setup();
      await expect(manager.prepare(db, value)).resolves.toEqual({});
    },
  );
  it("rejects preparation through an existing Transaction without a nested lease", async () => {
    const { db, raw, manager } = setup();
    await db.transaction().execute(async (tx) => {
      await expect(manager.prepare(tx, identity)).rejects.toMatchObject(
        rejected("prepare_inside_transaction"),
      );
    });
    expect(raw.acquires).toBe(1);
    expect(raw.commands.some(({ statement }) => lookup(statement))).toBe(false);
  });
  it("rejects foreign and forged handles before business SQL", async () => {
    const { db, raw, manager } = setup();
    const handle = await manager.prepare(db, identity);
    const other = createMariaDbWorkerAuditLockManager<Database>();
    const before = raw.commands.length;
    await expect(other.acquire(db as Transaction<Database>, handle)).rejects.toMatchObject(
      rejected("invalid_handle"),
    );
    await expect(
      manager.acquire(db as Transaction<Database>, {} as PreparedWorkerAuditLock),
    ).rejects.toMatchObject(rejected("invalid_handle"));
    expect(raw.commands).toHaveLength(before);
  });
  it("requires a transaction for a valid prepared handle", async () => {
    const { db, manager } = setup();
    const handle = await manager.prepare(db, identity);
    await expect(manager.acquire(db as Transaction<Database>, handle)).rejects.toMatchObject(
      rejected("transaction_required"),
    );
  });
  it("keeps committed registration across failed business transactions", async () => {
    const { db, raw, manager } = setup();
    const handle = await manager.prepare(db, identity);
    const error = new Error("synthetic business failure");
    await expect(
      db.transaction().execute(async (tx) => {
        await manager.acquire(tx, handle);
        throw error;
      }),
    ).rejects.toBe(error);
    expect(raw.registered.size).toBe(1);
    await db.transaction().execute((tx) => manager.acquire(tx, handle));
  });
  it("missing prepared row fails closed without recreating inside business transaction", async () => {
    const { db, raw, manager } = setup();
    const handle = await manager.prepare(db, identity);
    raw.registered.clear();
    await expect(
      db.transaction().execute((tx) => manager.acquire(tx, handle)),
    ).rejects.toMatchObject(rejected("registration_missing"));
    expect(raw.commands.filter(({ statement }) => insertion(statement))).toHaveLength(1);
  });
  it("rejects wrong isolation after acquiring a prepared row", async () => {
    const { db, raw, manager } = setup();
    const handle = await manager.prepare(db, identity);
    raw.isolation = "REPEATABLE-READ";
    await expect(
      db.transaction().execute((tx) => manager.acquire(tx, handle)),
    ).rejects.toMatchObject(rejected("transaction_settings"));
  });
  it("a wrong INSERT result rolls back the registration", async () => {
    const { db, raw, manager } = setup();
    raw.affectedRows = 0;
    await expect(manager.prepare(db, identity)).rejects.toMatchObject(rejected("invalid_result"));
    expect(raw.registered.size).toBe(0);
  });
  it("never evaluates diagnostic accessors or accepts inherited/proxy duplicates", async () => {
    let reads = 0;
    const accessor = Object.defineProperties(
      {},
      {
        errno: {
          get() {
            reads++;
            return 1062;
          },
        },
        sqlState: {
          get() {
            reads++;
            return "23000";
          },
        },
      },
    );
    const revoked = Proxy.revocable(native(), {});
    revoked.revoke();
    for (const error of [
      accessor,
      Object.create(native()),
      new Proxy(native(), {}),
      revoked.proxy,
    ]) {
      const { db, raw, manager } = setup();
      raw.fault = (statement) => (insertion(statement) ? error : undefined);
      let caught: unknown;
      await manager.prepare(db, identity).catch((error: unknown) => {
        caught = error;
      });
      expect(caught === error).toBe(true);
      expect(raw.acquires).toBe(1);
    }
    expect(reads).toBe(0);
  });
});
