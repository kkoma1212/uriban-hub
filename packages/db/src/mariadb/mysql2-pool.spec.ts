import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MariaDbPoolConfiguration } from "./connection.js";
import type { MariaDbRawConnection } from "./guarded-driver.js";
import { createMysql2MariaDbPool } from "./mysql2-pool.js";

const mocks = vi.hoisted(() => ({ createPool: vi.fn() }));
vi.mock("mysql2", () => ({ createPool: mocks.createPool }));

type ResultCallback = (error: unknown, result: unknown) => void;
type Events = { on(event: "error", listener: () => void): unknown };
const configuration: MariaDbPoolConfiguration = {
  host: "synthetic.invalid",
  port: 3306,
  database: "synthetic",
  user: "synthetic_app",
  password: "synthetic",
  connectionLimit: 1,
  connectTimeout: 5000,
  charset: "utf8mb4_bin",
  timezone: "Z",
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  jsonStrings: true,
  multipleStatements: false,
  ssl: {
    ca: "synthetic-test-ca",
    rejectUnauthorized: true,
    verifyIdentity: true,
  },
};
function rawConnection() {
  return {
    query: vi.fn((_statement: string, _parameters: unknown[], _callback: ResultCallback) => ({})),
    release: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((_event: "error", _listener: () => void) => ({})),
  };
}
function fixture() {
  const raw = rawConnection();
  const nativePool = {
    getConnection: vi.fn((callback: (error: unknown, connection: typeof raw) => void) => {
      callback(null, raw);
    }),
    end: vi.fn((callback: (error: unknown) => void) => callback(null)),
    on: vi.fn((_event: "error", _listener: () => void) => ({})),
  };
  mocks.createPool.mockReturnValue(nativePool);
  const pool = createMysql2MariaDbPool(configuration);
  function acquire() {
    const callback = vi.fn();
    pool.getConnection(callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, expect.any(Object));
    return callback.mock.calls[0]![1] as MariaDbRawConnection & Events;
  }
  return { raw, nativePool, pool, acquire };
}

beforeEach(() => vi.clearAllMocks());

describe("mysql2 callback pool facade", () => {
  it("passes the guarded configuration directly and does not acquire or query eagerly", () => {
    const h = fixture();
    expect(mocks.createPool).toHaveBeenCalledExactlyOnceWith(configuration);
    expect(mocks.createPool.mock.calls[0]![0]).toBe(configuration);
    expect(h.nativePool.getConnection).not.toHaveBeenCalled();
    expect(h.raw.query).not.toHaveBeenCalled();
  });
  it("forwards acquisition failure exactly once without a facade or query", () => {
    const h = fixture(),
      failure = new Error("synthetic connection unavailable"),
      callback = vi.fn();
    h.nativePool.getConnection.mockImplementation((done) => done(failure, undefined as never));
    h.pool.getConnection(callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(failure, undefined);
    expect(h.raw.query).not.toHaveBeenCalled();
    expect(h.nativePool.end).not.toHaveBeenCalled();
  });
  it("copies the readonly parameter array while preserving SQL, value identities and the callback", () => {
    const h = fixture(),
      connection = h.acquire(),
      binary = Buffer.from([0, 255]),
      object = { synthetic: true },
      parameters = Object.freeze(["9223372036854775807", binary, object, null]),
      done = vi.fn(),
      query = { syntheticQuery: true };
    h.raw.query.mockImplementation((_statement, mutableParameters, callback) => {
      expect(mutableParameters).not.toBe(parameters);
      expect(mutableParameters).toEqual(parameters);
      expect(mutableParameters[1]).toBe(binary);
      expect(mutableParameters[2]).toBe(object);
      expect(callback).toBe(done);
      mutableParameters.push("mysql2 local mutation");
      return query;
    });
    const statement = "SELECT ?, ?, ?, ? AS synthetic_values";
    expect(connection.query(statement, parameters, done)).toBe(query);
    expect(h.raw.query.mock.calls[0]![0]).toBe(statement);
    expect(h.raw.query.mock.contexts[0]).toBe(h.raw);
    expect(parameters).toHaveLength(4);
    expect(done).not.toHaveBeenCalled();
  });
  it("preserves result and error callback objects without translation", () => {
    const h = fixture(),
      connection = h.acquire(),
      done = vi.fn(),
      failure = { errno: 1213, sqlState: "40001" },
      rows = [{ synthetic_id: "9223372036854775807" }];
    connection.query("SELECT synthetic_id", [], done);
    const nativeCallback = h.raw.query.mock.calls[0]![2];
    nativeCallback(null, rows);
    expect(done).toHaveBeenLastCalledWith(null, rows);
    nativeCallback(failure, undefined);
    expect(done).toHaveBeenLastCalledWith(failure, undefined);
  });
  it("reuses one facade for the same physical connection and separates different sockets", () => {
    const h = fixture(),
      first = h.acquire();
    first.release();
    expect(h.acquire()).toBe(first);
    const other = rawConnection();
    h.nativePool.getConnection.mockImplementation((done) => done(null, other));
    const second = h.acquire();
    expect(second).not.toBe(first);
    second.destroy();
    expect(other.destroy).toHaveBeenCalledOnce();
    expect(h.raw.destroy).not.toHaveBeenCalled();
  });
  it("forwards pool and physical error listeners unchanged", () => {
    const h = fixture(),
      connection = h.acquire(),
      poolListener = vi.fn(),
      connectionListener = vi.fn();
    (h.pool as typeof h.pool & Events).on("error", poolListener);
    connection.on("error", connectionListener);
    expect(h.nativePool.on).toHaveBeenCalledExactlyOnceWith("error", poolListener);
    expect(h.raw.on).toHaveBeenCalledExactlyOnceWith("error", connectionListener);
    expect(h.nativePool.on.mock.contexts[0]).toBe(h.nativePool);
    expect(h.raw.on.mock.contexts[0]).toBe(h.raw);
    h.nativePool.on.mock.calls[0]![1]();
    h.raw.on.mock.calls[0]![1]();
    expect(poolListener).toHaveBeenCalledExactlyOnceWith();
    expect(connectionListener).toHaveBeenCalledExactlyOnceWith();
  });
  it("forwards release, destroy and asynchronous pool shutdown with their receiver intact", () => {
    const h = fixture(),
      connection = h.acquire(),
      done = vi.fn();
    connection.release();
    connection.destroy();
    expect(h.raw.release).toHaveBeenCalledExactlyOnceWith();
    expect(h.raw.destroy).toHaveBeenCalledExactlyOnceWith();
    expect(h.raw.release.mock.contexts[0]).toBe(h.raw);
    expect(h.raw.destroy.mock.contexts[0]).toBe(h.raw);
    h.nativePool.end.mockImplementation(() => undefined);
    h.pool.end(done);
    expect(h.nativePool.end).toHaveBeenCalledExactlyOnceWith(done);
    expect(h.nativePool.end.mock.contexts[0]).toBe(h.nativePool);
    expect(done).not.toHaveBeenCalled();
    const failure = new Error("synthetic shutdown failure");
    h.nativePool.end.mock.calls[0]![0](failure);
    expect(done).toHaveBeenCalledExactlyOnceWith(failure);
  });
});

describe("physical runtime TLS capability", () => {
  it("projects fresh immutable booleans without exposing the physical socket or configuration", () => {
    const h = fixture();
    const physical = Object.assign(h.raw, {
      config: {
        ssl: {
          rejectUnauthorized: true,
          verifyIdentity: true,
          ca: "private-ca",
          key: "private-key",
        },
      },
      stream: { encrypted: true, authorized: true, private: "secret" },
    });
    const connection = h.acquire();
    const state = connection.readRuntimeTls!();
    expect(state).toEqual({
      encrypted: true,
      authorized: true,
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.keys(connection)).not.toContain("stream");
    expect(Object.keys(connection)).not.toContain("config");
    physical.stream.authorized = false;
    expect(connection.readRuntimeTls!().authorized).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/private|secret/);
  });
});
