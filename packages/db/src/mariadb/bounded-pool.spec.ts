import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedMariaDbPoolFactory } from "./bounded-pool.js";
import type { MariaDbPoolFactory } from "./connection.js";

type Pool = ReturnType<MariaDbPoolFactory>;
type Raw = Parameters<Parameters<Pool["getConnection"]>[0]>[1];
function fixture(queryTimeoutMs: 5000 | 10000, readiness = false, holdAcquire = false) {
  let deliver: ((error: unknown, result: unknown) => void) | undefined;
  let lateAcquire: Parameters<Pool["getConnection"]>[0] | undefined;
  const raw: Raw = {
    query: vi.fn((statement, _parameters, callback) => {
      if (statement === "SELECT slow") deliver = callback;
      else callback(null, []);
    }),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const factory = vi.fn<MariaDbPoolFactory>(() => ({
    getConnection: (callback) => {
      if (holdAcquire) lateAcquire = callback;
      else callback(null, raw);
    },
    end: (callback) => callback(null),
  }));
  // The fake ignores connection identity; admission still uses the real one-slot limit.
  const pool = boundedMariaDbPoolFactory(
    factory,
    () => readiness,
    undefined,
    undefined,
    queryTimeoutMs,
  )({ connectionLimit: 1 } as Parameters<MariaDbPoolFactory>[0]);
  return {
    pool,
    raw,
    factory,
    completeQuery: () => deliver?.(null, [{ value: 1 }]),
    completeAcquire: () => lateAcquire?.(null, raw),
  };
}
afterEach(() => vi.useRealTimers());

describe("MariaDB retention SQL watchdog", () => {
  it.each([5000, 10000] as const)(
    "enforces the selected %dms SQL deadline once and discards late results",
    async (limit) => {
      vi.useFakeTimers();
      const target = fixture(limit);
      let connection: Raw | undefined;
      target.pool.getConnection((error, acquired) => {
        expect(error).toBeNull();
        connection = acquired;
      });
      expect(connection).toBeDefined();
      expect(target.raw.query).toHaveBeenCalledWith(
        `SET SESSION max_statement_time = ${limit / 1000}`,
        [],
        expect.any(Function),
      );
      const callback = vi.fn();
      connection!.query("SELECT slow", [], callback);
      await vi.advanceTimersByTimeAsync(limit - 1);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]?.[0]).toMatchObject({ reason: "query_timeout" });
      expect(target.raw.destroy).toHaveBeenCalledTimes(1);
      target.completeQuery();
      connection!.release();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(target.raw.release).not.toHaveBeenCalled();
    },
  );

  it("keeps acquisition at five seconds with the ten-second SQL budget", async () => {
    vi.useFakeTimers();
    const target = fixture(10000, false, true);
    const callback = vi.fn();
    target.pool.getConnection(callback);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ reason: "connection_timeout" });
    target.completeAcquire();
    expect(target.raw.destroy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("preserves the one-second readiness statement cap", () => {
    const target = fixture(10000, true);
    target.pool.getConnection((error, connection) => {
      expect(error).toBeNull();
      connection.release();
    });
    expect(target.raw.query).toHaveBeenCalledWith(
      "SET SESSION max_statement_time = 1",
      [],
      expect.any(Function),
    );
  });

  it("rejects unreviewed timeout values before constructing a pool", () => {
    const factory = vi.fn<MariaDbPoolFactory>();
    expect(() =>
      boundedMariaDbPoolFactory(factory, () => false, undefined, undefined, 6500 as 5000),
    ).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("bounded same-lease TLS capability", () => {
  it("forwards only while the lease owns the physical connection and rejects a stale wrapper", () => {
    const h = fixture(5000);
    const tls = {
      encrypted: true,
      authorized: true,
      rejectUnauthorized: true,
      verifyIdentity: true,
    };
    h.raw.readRuntimeTls = vi.fn(() => tls);
    let first: Raw | undefined;
    h.pool.getConnection((error, raw) => {
      expect(error).toBeNull();
      first = raw;
    });
    expect(first!.readRuntimeTls!()).toBe(tls);
    first!.release();
    expect(() => first!.readRuntimeTls!()).toThrow();
    let second: Raw | undefined;
    h.pool.getConnection((error, raw) => {
      expect(error).toBeNull();
      second = raw;
    });
    expect(second!.readRuntimeTls!()).toBe(tls);
    expect(() => first!.readRuntimeTls!()).toThrow();
    second!.destroy();
    expect(() => second!.readRuntimeTls!()).toThrow();
  });
  it("preserves missing capability instead of manufacturing verified TLS", () => {
    const h = fixture(5000);
    h.pool.getConnection((error, raw) => {
      expect(error).toBeNull();
      expect(raw.readRuntimeTls).toBeUndefined();
      raw.release();
    });
  });
});
