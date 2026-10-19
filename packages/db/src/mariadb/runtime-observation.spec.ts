import { describe, expect, it, vi } from "vitest";
import { MariaDbDriver, type MariaDbRawConnection } from "./guarded-driver.js";
import { boundedMariaDbPoolFactory } from "./bounded-pool.js";
import { createMariaDbDatabase } from "./connection.js";
import {
  MARIADB_RUNTIME_OBSERVATION_SQL,
  MariaDbRuntimeObservationError,
  requireRuntimeObservationTls,
  runtimeObservationFromRows,
  type MariaDbRuntimeObservationSink,
} from "./runtime-observation.js";
const identity = {
  role: "worker",
  user: "qa_worker",
  accountHost: "%",
  database: "qa",
  tls: "required",
} as const;
const tls = { encrypted: true, authorized: true, rejectUnauthorized: true, verifyIdentity: true };
const row = {
  database_name: "qa",
  account: "qa_worker@%",
  server_version: "11.4.13-MariaDB",
  ssl_cipher: "TLS_AES_256_GCM_SHA384",
  ssl_version: "TLSv1.3",
  server_hostname: "private-db",
  server_id: "1",
  server_port: "3306",
  connection_id: "42",
};
function fixture(sink?: MariaDbRuntimeObservationSink, overrides: Record<string, unknown> = {}) {
  const commands: string[] = [];
  const raw: MariaDbRawConnection = {
    readRuntimeTls: vi.fn(() => tls),
    release: vi.fn(),
    destroy: vi.fn(),
    query(sql, _parameters, callback) {
      commands.push(sql);
      let value: unknown = [];
      if (sql === MARIADB_RUNTIME_OBSERVATION_SQL) value = [{ ...row, ...overrides }];
      else if (sql.startsWith("SELECT CURRENT_USER"))
        value = [
          {
            account: row.account,
            login_user: "qa_worker@private-client",
            database_name: "qa",
            active_role: null,
            server_version: row.server_version,
            ssl_cipher: row.ssl_cipher,
            applicable_roles: 0,
            enabled_roles: 0,
          },
        ];
      else if (sql === "SHOW GRANTS FOR CURRENT_USER")
        value = [
          {
            grant:
              "GRANT USAGE ON *.* TO `qa_worker`@`%` IDENTIFIED BY PASSWORD '*AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' REQUIRE SSL",
          },
          { grant: "GRANT SELECT, INSERT ON `qa`.`security_audit_logs` TO `qa_worker`@`%`" },
        ];
      callback(null, value);
    },
  };
  const pool = {
    getConnection: (callback: (error: unknown, connection: MariaDbRawConnection) => void) =>
      callback(null, raw),
    end: (callback: (error: unknown) => void) => callback(null),
  };
  return { commands, raw, pool, driver: new MariaDbDriver(pool, identity, sink) };
}
describe("opt-in same-lease runtime observation", () => {
  it("observes only after initialization and exact ACL on the same physical lease", async () => {
    const sink = vi.fn(),
      h = fixture(sink);
    const connection = await h.driver.acquireConnection();
    expect(h.commands.slice(-3)).toEqual([
      "SHOW GRANTS FOR CURRENT_USER",
      "SHOW GRANTS FOR PUBLIC",
      MARIADB_RUNTIME_OBSERVATION_SQL,
    ]);
    expect(h.raw.readRuntimeTls).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledOnce();
    const observed = sink.mock.calls[0]![0];
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed.observedAt).toMatch(/^\d{4}-/);
    expect(JSON.stringify(observed)).not.toMatch(
      /qa_worker|private-db|private-client|password|CA|image|provenance/,
    );
    expect(observed.sessionIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    await h.driver.releaseConnection(connection);
    expect(h.raw.release).toHaveBeenCalledOnce();
    expect(h.raw.destroy).not.toHaveBeenCalled();
  });
  it("never reads the capability or adds a query without the hook", async () => {
    const h = fixture();
    const connection = await h.driver.acquireConnection();
    expect(h.raw.readRuntimeTls).not.toHaveBeenCalled();
    expect(h.commands).not.toContain(MARIADB_RUNTIME_OBSERVATION_SQL);
    await h.driver.releaseConnection(connection);
  });
  it.each([
    { account: "root@%" },
    { database_name: "other" },
    { ssl_version: "TLSv1.1" },
    { server_version: "11.8.1-MariaDB" },
    { connection_id: "0" },
    { server_port: "65536" },
    { secret: "private" },
  ])("discards drifted or extra observation values %o", async (overrides) => {
    const sink = vi.fn(),
      h = fixture(sink, overrides);
    await expect(h.driver.acquireConnection()).rejects.toBeInstanceOf(
      MariaDbRuntimeObservationError,
    );
    expect(sink).not.toHaveBeenCalled();
    expect(h.raw.destroy).toHaveBeenCalledOnce();
    expect(h.raw.release).not.toHaveBeenCalled();
  });
  it.each([undefined, { ...tls, authorized: false }, { ...tls, verifyIdentity: false }])(
    "rejects missing or downgraded physical TLS capability %o",
    async (value) => {
      const h = fixture(vi.fn());
      if (value === undefined) delete h.raw.readRuntimeTls;
      else h.raw.readRuntimeTls = () => value;
      await expect(h.driver.acquireConnection()).rejects.toBeInstanceOf(
        MariaDbRuntimeObservationError,
      );
      expect(h.commands).not.toContain(MARIADB_RUNTIME_OBSERVATION_SQL);
      expect(h.raw.destroy).toHaveBeenCalledOnce();
    },
  );
  it("sanitizes callback errors and rejects async sinks without unhandled rejection", async () => {
    for (const sink of [
      () => {
        throw new Error("private-password");
      },
      () => Promise.reject(new Error("private-password")),
    ]) {
      const h = fixture(sink);
      await expect(h.driver.acquireConnection()).rejects.toMatchObject({
        code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
        message: "MariaDB runtime observation failed.",
      });
      expect(h.raw.destroy).toHaveBeenCalledOnce();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  it("requires runtime identity and required TLS before pool creation", () => {
    const factory = vi.fn();
    const base = {
      host: "synthetic.invalid",
      user: "qa_worker",
      password: "private",
      database: "qa",
      sslCa: "-----BEGIN CERTIFICATE-----",
      onRuntimeObservation: vi.fn(),
    };
    expect(() => createMariaDbDatabase(factory, base)).toThrow();
    expect(() =>
      createMariaDbDatabase(factory, {
        ...base,
        runtimeRole: "worker",
        accountHost: "%",
        tls: "disabled",
        sslCa: undefined,
      }),
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it("requires exact physical booleans and hashes per-session identity without raw values", () => {
    for (const key of Object.keys(tls))
      expect(() => requireRuntimeObservationTls({ ...tls, [key]: 1 })).toThrow();
    expect(() => requireRuntimeObservationTls({ ...tls, secret: "private" })).toThrow();
    const a = runtimeObservationFromRows([row], identity),
      b = runtimeObservationFromRows([{ ...row, connection_id: "43" }], identity);
    expect(a.databaseIdentitySha256).toBe(b.databaseIdentitySha256);
    expect(a.sessionIdentitySha256).not.toBe(b.sessionIdentitySha256);
  });
});

it("keeps the physical query watchdog and suppresses an observation arriving after discard", async () => {
  vi.useFakeTimers();
  try {
    const sink = vi.fn(),
      h = fixture();
    let complete: ((error: unknown, result: unknown) => void) | undefined;
    const query = h.raw.query.bind(h.raw);
    h.raw.query = (sql, parameters, callback) => {
      if (sql === MARIADB_RUNTIME_OBSERVATION_SQL) complete = callback;
      else query(sql, parameters, callback);
    };
    const pool = boundedMariaDbPoolFactory(
      () => h.pool,
      () => false,
    )({ connectionLimit: 1 } as never);
    const driver = new MariaDbDriver(pool, identity, sink);
    const pending = driver.acquireConnection();
    const rejected = expect(pending).rejects.toMatchObject({
      code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(h.raw.destroy).toHaveBeenCalledOnce();
    expect(h.raw.release).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    complete!(null, [row]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("contains a rejected Promise with a hostile then getter before generic rejection", async () => {
  const h = fixture(() => {
    const promise = Promise.reject(new Error("private-password"));
    Object.defineProperty(promise, "then", {
      get: () => {
        throw new Error("private-getter");
      },
    });
    return promise;
  });
  await expect(h.driver.acquireConnection()).rejects.toMatchObject({
    code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.raw.destroy).toHaveBeenCalledOnce();
});

it.each([undefined, null, 0, "hidden"])(
  "rejects native Promise sinks even when then is shadowed by %s",
  async (then) => {
    const h = fixture(() => {
      const promise = Promise.reject(new Error("private-password"));
      Object.defineProperty(promise, "then", { value: then });
      return promise;
    });
    await expect(h.driver.acquireConnection()).rejects.toMatchObject({
      code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.raw.destroy).toHaveBeenCalledOnce();
    expect(h.raw.release).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "masks native acquisition errors only with the hook: %s",
  async (enabled) => {
    const native = new Error("private-acquisition-password");
    const h = fixture();
    const pool = {
      ...h.pool,
      getConnection: (callback: (error: unknown, connection: MariaDbRawConnection) => void) =>
        callback(native, undefined as never),
    };
    const driver = new MariaDbDriver(pool, identity, enabled ? vi.fn() : undefined);
    if (enabled)
      await expect(driver.acquireConnection()).rejects.toMatchObject({
        code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
        message: "MariaDB runtime observation failed.",
      });
    else await expect(driver.acquireConnection()).rejects.toBe(native);
    expect(h.raw.destroy).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "masks initialization errors and discards the lease only with hook error semantics: %s",
  async (enabled) => {
    const native = new Error("private-initialization-password");
    const h = fixture();
    h.raw.query = (_sql, _parameters, callback) => callback(native, undefined);
    const driver = new MariaDbDriver(h.pool, identity, enabled ? vi.fn() : undefined);
    if (enabled)
      await expect(driver.acquireConnection()).rejects.toMatchObject({
        code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
        message: "MariaDB runtime observation failed.",
      });
    else await expect(driver.acquireConnection()).rejects.toBe(native);
    expect(h.raw.destroy).toHaveBeenCalledOnce();
    expect(h.raw.release).not.toHaveBeenCalled();
  },
);
it.each([0, false, "value", {}, () => undefined])(
  "rejects every non-void sink result: %s",
  async (value) => {
    const h = fixture(() => value);
    await expect(h.driver.acquireConnection()).rejects.toMatchObject({
      code: "MARIADB_RUNTIME_OBSERVATION_FAILED",
    });
    expect(h.raw.destroy).toHaveBeenCalledOnce();
  },
);
