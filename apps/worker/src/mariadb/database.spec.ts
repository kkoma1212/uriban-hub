import { sql } from "kysely";
import type { MariaDbPoolFactory } from "@classhub/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerMariaDbDatabaseRole,
  openWorkerMariaDbDatabase,
  probeWorkerMariaDbReadiness,
  type WorkerMariaDbDatabase,
} from "./database.js";

type Pool = ReturnType<MariaDbPoolFactory>;
type Raw = Parameters<Parameters<Pool["getConnection"]>[0]>[1];
const options = {
  host: "qa.invalid",
  database: "qa",
  user: "qa_worker",
  accountHost: "%",
  password: "private-password",
  sslCa: "-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----",
};
const header = { affectedRows: 0, insertId: 0 };
function fixture() {
  const statements: string[] = [],
    raws: Raw[] = [],
    pending: { statement: string; callback: (error: unknown, result: unknown) => void }[] = [];
  const control = {
    ready: 1 as unknown,
    extraGrant: false,
    hangAcquire: false,
    hangEnd: false,
    failObserver: false,
    hang: (_statement: string) => false,
    fail: (_statement: string): unknown => undefined,
  };
  const rawObservers: (() => void)[] = [];
  let acquire: Parameters<Pool["getConnection"]>[0] | undefined,
    poolObserver: (() => void) | undefined;
  function rawConnection(): Raw {
    const raw: Raw & { on: (event: string, callback: () => void) => void } = {
      query: vi.fn((statement, _parameters, callback) => {
        statements.push(statement);
        if (control.hang(statement)) {
          pending.push({ statement, callback });
          return;
        }
        const error = control.fail(statement);
        if (error) {
          callback(error, undefined);
          return;
        }
        let result: unknown = header;
        if (statement.startsWith("SELECT CURRENT_USER"))
          result = [
            {
              account: "qa_worker@%",
              login_user: "qa_worker@172.20.0.2",
              database_name: "qa",
              active_role: null,
              server_version: "11.4.13-MariaDB-ubu2404",
              ssl_cipher: "TLS_AES_256_GCM_SHA384",
              applicable_roles: 0,
              enabled_roles: "0",
            },
          ];
        if (statement === "SHOW GRANTS FOR CURRENT_USER")
          result = [
            {
              grant:
                "GRANT USAGE ON *.* TO `qa_worker`@`%` IDENTIFIED BY PASSWORD '*" +
                "A".repeat(40) +
                "' REQUIRE SSL",
            },
            { grant: "GRANT SELECT, INSERT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`" },
            ...(control.extraGrant
              ? [{ grant: "GRANT SELECT ON `qa`.`users` TO `qa_worker`@`%`" }]
              : []),
          ];
        if (statement === "SHOW GRANTS FOR PUBLIC") result = [];
        if (statement.trim() === "SELECT 1 AS worker_role_ready")
          result = [{ worker_role_ready: 1 }];
        if (statement.trim() === "SELECT 1 AS ready") result = [{ ready: control.ready }];
        callback(null, result);
      }),
      release: vi.fn(),
      destroy: vi.fn(),
      on(_event, callback) {
        rawObservers.push(callback);
      },
    };
    raws.push(raw);
    return raw;
  }
  const end = vi.fn((callback: (error: unknown) => void) => {
    if (!control.hangEnd) callback(null);
  });
  const pool: Pool & { on: (event: string, callback: () => void) => void } = {
    getConnection(callback) {
      if (control.hangAcquire) acquire = callback;
      else callback(null, rawConnection());
    },
    end,
    on(_event, callback) {
      if (control.failObserver) throw new Error("private observer failure");
      poolObserver = callback;
    },
  };
  const factory = vi.fn<MariaDbPoolFactory>(() => pool);
  return {
    factory,
    control,
    statements,
    raws,
    pending,
    end,
    observer: () => poolObserver?.(),
    rawError: (index: number) => rawObservers[index]?.(),
    lateConnection: () => {
      const raw = rawConnection();
      acquire?.(null, raw);
      return raw;
    },
  };
}
function safeError(error: unknown) {
  expect(error).toMatchObject({ code: "WORKER_MARIADB_DATABASE_FAILED" });
  expect(String(error) + JSON.stringify(error)).not.toMatch(
    /private|PASSWORD|SHOW GRANTS|qa_worker|qa\.invalid|SELECT/iu,
  );
  expect(error).not.toHaveProperty("cause");
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("isolated MariaDB worker opener", () => {
  it("uses worker-only attestation, mandatory TLS and existing UTC/RC reset with a five-second cap", async () => {
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5000,
        timezone: "Z",
        dateStrings: true,
        bigNumberStrings: true,
        multipleStatements: false,
        ssl: { ca: options.sslCa, rejectUnauthorized: true, verifyIdentity: true },
      }),
    );
    expect(h.statements[0]).toBe("SET SESSION max_statement_time = 5");
    expect(h.statements).toContain("SET SESSION time_zone = '+00:00'");
    expect(h.statements).toContain("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(h.statements).toContain("SHOW GRANTS FOR CURRENT_USER");
    expect(h.statements).toContain("SHOW GRANTS FOR PUBLIC");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.end).not.toHaveBeenCalled();
    await assertWorkerMariaDbDatabaseRole(database);
    expect(
      h.statements.filter((statement) => statement === "SHOW GRANTS FOR CURRENT_USER"),
    ).toHaveLength(2);
    await database.destroy();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("rejects excess privileges and closes the pool without exposing native identity details", async () => {
    const h = fixture();
    h.control.extraGrant = true;
    const error: unknown = await openWorkerMariaDbDatabase(h.factory, options).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(error).toMatchObject({ reason: "role" });
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("contains constructor validation failures before pool creation", async () => {
    const h = fixture();
    const error: unknown = await openWorkerMariaDbDatabase(h.factory, {
      ...options,
      host: "127.0.0.1",
    }).catch((error: unknown) => error);
    safeError(error);
    expect(h.factory).not.toHaveBeenCalled();
  });
  it("re-attests every new lease and rejects pooled privilege drift before business SQL", async () => {
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    h.control.extraGrant = true;
    await expect(assertWorkerMariaDbDatabaseRole(database)).rejects.toMatchObject({
      reason: "role",
    });
    expect(
      h.statements.filter((statement) => statement.trim() === "SELECT 1 AS worker_role_ready"),
    ).toHaveLength(1);
    await database.destroy();
  });
  it("passes a no-argument pool observer and contains observer exceptions", async () => {
    const h = fixture(),
      observer = vi.fn(() => {
        throw new Error("private observer payload");
      });
    const database = await openWorkerMariaDbDatabase(h.factory, options, observer);
    expect(() => h.observer()).not.toThrow();
    expect(observer).toHaveBeenCalledWith();
    expect(() => h.rawError(0)).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(2);
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    await database.destroy();
  });
  it("closes a pool whose observer registration fails", async () => {
    const h = fixture();
    h.control.failObserver = true;
    const error: unknown = await openWorkerMariaDbDatabase(h.factory, options).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(h.raws).toHaveLength(0);
    expect(h.end).toHaveBeenCalledOnce();
  });
});

describe("MariaDB worker readiness transaction", () => {
  it("sets only its lease to one second, waits for COMMIT, then restores five seconds on a later ordinary lease", async () => {
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement === "COMMIT";
    let completed = false;
    const task = probeWorkerMariaDbReadiness(database).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    expect(completed).toBe(false);
    expect(h.pending[0]!.statement).toBe("COMMIT");
    expect(h.statements).toContain("SET SESSION max_statement_time = 1");
    expect(h.statements).toContain("START TRANSACTION READ WRITE");
    expect(h.statements).toContain("SELECT 1 AS ready");
    h.pending[0]!.callback(null, header);
    await task;
    h.control.hang = () => false;
    await assertWorkerMariaDbDatabaseRole(database);
    expect(
      h.statements.filter((statement) => statement.startsWith("SET SESSION max_statement_time")),
    ).toEqual([
      "SET SESSION max_statement_time = 5",
      "SET SESSION max_statement_time = 1",
      "SET SESSION max_statement_time = 5",
    ]);
    await database.destroy();
  });
  it("does not leak readiness scope into concurrent ordinary leases", async () => {
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement.trim() === "SELECT 1 AS ready";
    const task = probeWorkerMariaDbReadiness(database);
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    await assertWorkerMariaDbDatabaseRole(database);
    expect(
      h.statements
        .filter((statement) => statement.startsWith("SET SESSION max_statement_time"))
        .at(-1),
    ).toBe("SET SESSION max_statement_time = 5");
    h.pending[0]!.callback(null, [{ ready: 1 }]);
    await task;
    await database.destroy();
  });
  it.each([0, "1", null])(
    "rolls back unexpected readiness result %o before returning",
    async (ready) => {
      const h = fixture(),
        database = await openWorkerMariaDbDatabase(h.factory, options),
        start = h.statements.length;
      h.control.ready = ready;
      const error: unknown = await probeWorkerMariaDbReadiness(database).catch(
        (error: unknown) => error,
      );
      safeError(error);
      expect(error).toMatchObject({ reason: "readiness" });
      expect(h.statements.slice(start)).not.toContain("COMMIT");
      expect(h.statements.at(-1)).toBe("ROLLBACK");
      await database.destroy();
    },
  );
  it("contains native probe failures and ends the transaction before reuse", async () => {
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    h.control.fail = (statement) =>
      statement.trim() === "SELECT 1 AS ready"
        ? new Error("private-password private SQL")
        : undefined;
    const error: unknown = await probeWorkerMariaDbReadiness(database).catch(
      (error: unknown) => error,
    );
    safeError(error);
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    h.control.fail = () => undefined;
    await probeWorkerMariaDbReadiness(database);
    await database.destroy();
  });
  it("rejects databases lacking this adapter's timeout bootstrap", async () => {
    const database = {} as WorkerMariaDbDatabase;
    await expect(probeWorkerMariaDbReadiness(database)).rejects.toMatchObject({
      reason: "readiness",
    });
    await expect(assertWorkerMariaDbDatabaseRole(database)).rejects.toMatchObject({
      reason: "role",
    });
  });
});

describe("MariaDB worker client deadlines and resource cleanup", () => {
  it("bounds a hung pool acquisition and discards a late socket", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.hangAcquire = true;
    const outcome = openWorkerMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    const raw = h.lateConnection();
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(raw.release).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledOnce();
  });
  it("bounds a hung bootstrap and ignores its late callback", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.hang = (statement) => statement.startsWith("SET SESSION max_statement_time");
    const outcome = openWorkerMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    h.pending[0]!.callback(null, header);
    expect(h.statements).toHaveLength(1);
    expect(h.raws[0]!.release).not.toHaveBeenCalled();
  });
  it("bounds general queries at five seconds and never returns the uncertain socket to the pool", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      database = await openWorkerMariaDbDatabase(h.factory, options);
    h.control.hang = (statement) => statement.includes("worker_timeout_probe");
    const outcome = sql`SELECT 1 AS worker_timeout_probe`
      .execute(database)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    safeError(await outcome);
    expect(h.raws[1]!.destroy).toHaveBeenCalledOnce();
    expect(h.raws[1]!.release).not.toHaveBeenCalled();
    h.pending[0]!.callback(null, [{ worker_timeout_probe: 1 }]);
    await database.destroy();
  });
  it("bounds failed opener cleanup and suppresses its native error", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.control.extraGrant = true;
    h.control.hangEnd = true;
    const outcome = openWorkerMariaDbDatabase(h.factory, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await outcome;
    safeError(error);
    expect(error).toMatchObject({ reason: "cleanup" });
    expect(h.raws[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });
});
