import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedMariaDbPoolFactory,
  MARIADB_MAXIMUM_QUEUED_ACQUISITIONS as QUEUE,
} from "./bounded-pool.js";
import type { MariaDbPoolConfiguration, MariaDbPoolFactory } from "./connection.js";

type Pool = ReturnType<MariaDbPoolFactory>;
type AcquireCallback = Parameters<Pool["getConnection"]>[0];
type Raw = Parameters<AcquireCallback>[1];
type QueryCallback = Parameters<Raw["query"]>[2];
type Physical = Raw & { id: number; on: ReturnType<typeof vi.fn>; errors: (() => void)[] };
const configuration: MariaDbPoolConfiguration = {
  host: "synthetic.invalid",
  port: 3306,
  database: "synthetic",
  user: "synthetic",
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
  ssl: { ca: "synthetic", rejectUnauthorized: true, verifyIdentity: true },
};

function fixture(limit = 1, readiness = () => false, queryTimeout: 5000 | 10000 = 5000) {
  const control = {
    holdAcquire: false,
    holdEnd: false,
    throwAcquire: false,
    throwAfterCallback: false,
    throwAfterHolding: false,
    failAcquire: false,
    errorWithRaw: false,
    throwRelease: false,
    throwDestroy: false,
    throwListener: false,
    holdQuery: (_statement: string) => false,
    failQuery: (_statement: string): unknown => null,
    throwQuery: (_statement: string) => false,
  };
  const all = new Set<Physical>(),
    active = new Set<Physical>(),
    idle: Physical[] = [];
  const raws: Physical[] = [],
    pendingAcquires: { callback: AcquireCallback; raw: Physical }[] = [];
  const pendingQueries: { callback: QueryCallback; statement: string; raw: Physical }[] = [];
  const endCompletions: Parameters<Pool["end"]>[0][] = [],
    statements: string[] = [];
  let maximumActive = 0;
  const notify = vi.fn();
  function remove(raw: Physical) {
    all.delete(raw);
    active.delete(raw);
    const index = idle.indexOf(raw);
    if (index !== -1) idle.splice(index, 1);
  }
  function physical(): Physical {
    const raw: Physical = {
      id: raws.length + 1,
      errors: [],
      query: vi.fn((statement, _parameters, callback) => {
        statements.push(statement);
        if (control.throwQuery(statement)) throw new Error("synthetic query throw");
        if (control.holdQuery(statement)) pendingQueries.push({ callback, statement, raw });
        else callback(control.failQuery(statement), []);
      }),
      release: vi.fn(() => {
        if (control.throwRelease) throw new Error("synthetic release throw");
        if (!active.delete(raw)) throw new Error("physical released twice");
        idle.push(raw);
      }),
      destroy: vi.fn(() => {
        if (control.throwDestroy) throw new Error("synthetic destroy throw");
        remove(raw);
      }),
      on: vi.fn((_event: string, listener: () => void) => {
        if (control.throwListener) throw new Error("synthetic listener throw");
        raw.errors.push(listener);
      }),
    };
    all.add(raw);
    raws.push(raw);
    return raw;
  }
  const getConnection = vi.fn<Pool["getConnection"]>((callback) => {
    if (control.throwAcquire) throw new Error("synthetic acquire throw");
    if (control.failAcquire)
      return callback(new Error("synthetic acquire failure"), undefined as never);
    if (active.size === limit) return callback(new Error("native failfast"), undefined as never);
    const raw = idle.pop() ?? physical();
    active.add(raw);
    maximumActive = Math.max(maximumActive, active.size);
    if (control.holdAcquire) {
      pendingAcquires.push({ callback, raw });
      if (control.throwAfterHolding) throw new Error("synthetic callback scheduled before throw");
    } else {
      callback(control.errorWithRaw ? new Error("synthetic failure with raw") : null, raw);
      if (control.throwAfterCallback) throw new Error("synthetic throw after callback");
    }
  });
  const end = vi.fn<Pool["end"]>((callback) => {
    endCompletions.push(callback);
    if (!control.holdEnd) callback(null);
  });
  const factory = vi.fn<MariaDbPoolFactory>(() => ({ getConnection, end }));
  const pool = boundedMariaDbPoolFactory(
    factory,
    readiness,
    notify,
    undefined,
    queryTimeout,
  )({ ...configuration, connectionLimit: limit });
  function request() {
    const done = vi.fn<AcquireCallback>();
    pool.getConnection(done);
    return done;
  }
  return {
    pool,
    factory,
    notify,
    control,
    raws,
    all,
    active,
    idle,
    statements,
    getConnection,
    end,
    pendingAcquires,
    pendingQueries,
    endCompletions,
    request,
    maximumActive: () => maximumActive,
    emitError: (raw: Physical) => {
      remove(raw);
      for (const listener of raw.errors) listener();
    },
  };
}
function lease(done: ReturnType<ReturnType<typeof fixture>["request"]>): Raw {
  expect(done).toHaveBeenCalledExactlyOnceWith(null, expect.any(Object));
  return done.mock.calls[0]![1];
}
function failure(done: ReturnType<ReturnType<typeof fixture>["request"]>, reason: string) {
  expect(done).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ code: "WORKER_MARIADB_DATABASE_FAILED", reason }),
    undefined,
  );
}
async function pump() {
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MariaDB bounded FIFO admission", () => {
  it("pins public failfast settings while preserving the physical limit", () => {
    const h = fixture(2);
    expect(h.factory).toHaveBeenCalledExactlyOnceWith({
      ...configuration,
      connectionLimit: 2,
      waitForConnections: false,
      queueLimit: 0,
      resetOnRelease: false,
    });
    expect(h.getConnection).not.toHaveBeenCalled();
  });

  it("overrides untyped native waiting/reset options after copying configuration", () => {
    const factory = vi.fn<MariaDbPoolFactory>(() => ({ getConnection: vi.fn(), end: vi.fn() }));
    boundedMariaDbPoolFactory(
      factory,
      () => false,
    )({
      ...configuration,
      waitForConnections: true,
      queueLimit: 100,
      resetOnRelease: true,
    } as unknown as MariaDbPoolConfiguration);
    expect(factory.mock.calls[0]![0]).toMatchObject({
      connectionLimit: 1,
      waitForConnections: false,
      queueLimit: 0,
      resetOnRelease: false,
    });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s before native construction",
    (connectionLimit) => {
      const factory = vi.fn<MariaDbPoolFactory>();
      expect(() =>
        boundedMariaDbPoolFactory(factory, () => false)({ ...configuration, connectionLimit }),
      ).toThrow(expect.objectContaining({ reason: "configuration" }));
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("bounds queued work at the queue limit, rejects 128 excess, and removes all expired work before release", async () => {
    vi.useFakeTimers();
    const h = fixture(2),
      a = lease(h.request()),
      b = lease(h.request());
    const accepted = Array.from({ length: QUEUE }, () => h.request());
    const overflow = Array.from({ length: 128 }, () => h.request());
    overflow.forEach((done) => failure(done, "connection_queue_full"));
    expect(vi.getTimerCount()).toBe(QUEUE);
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999);
    accepted.forEach((done) => expect(done).not.toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1);
    accepted.forEach((done) => failure(done, "connection_timeout"));
    expect(vi.getTimerCount()).toBe(0);
    a.release();
    b.release();
    await pump();
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    h.raws.forEach((raw) => expect(raw.destroy).not.toHaveBeenCalled());
    lease(h.request()).release();
    expect(h.maximumActive()).toBe(2);
    expect(h.getConnection).toHaveBeenCalledTimes(3);
  });

  it("keeps FIFO order across a release and a newly arriving request", async () => {
    const h = fixture(),
      held = lease(h.request()),
      order: string[] = [];
    h.pool.getConnection((_error, raw) => {
      order.push("A");
      raw.release();
    });
    h.pool.getConnection((_error, raw) => {
      order.push("B");
      raw.release();
    });
    held.release();
    h.pool.getConnection((_error, raw) => {
      order.push("C");
      raw.release();
    });
    await pump();
    expect(order).toEqual(["A", "B", "C"]);
    expect(h.maximumActive()).toBe(1);
    expect(h.raws).toHaveLength(1);
  });

  it("checks queued deadlines even if timer execution is delayed", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = fixture(),
      held = lease(h.request()),
      expired = h.request();
    now = 5001;
    held.release();
    await pump();
    failure(expired, "connection_timeout");
    expect(h.getConnection).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    lease(h.request()).release();
  });

  it("does not report a full queue solely because expired timers have not run", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = fixture(),
      held = lease(h.request());
    const expired = Array.from({ length: QUEUE }, () => h.request());
    now = 5001;
    const fresh = h.request();
    expired.forEach((done) => failure(done, "connection_timeout"));
    expect(fresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    held.release();
    // A new caller pumps the existing fresh request first, even before a microtask.
    const another = h.request();
    lease(fresh).release();
    h.pool.end(vi.fn());
    failure(another, "closed");
  });

  it("expires a middle node when callback re-entry has inverted deadline order", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = fixture();
    lease(h.request());
    let reentrant: ReturnType<typeof h.request> | undefined;
    h.pool.getConnection(() => {
      now = 5002;
      reentrant = h.request();
    });
    now = 5001;
    const earlierDeadline = h.request();
    now = 10001;
    const fresh = h.request();
    failure(earlierDeadline, "connection_timeout");
    expect(reentrant).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    expect(h.getConnection).toHaveBeenCalledTimes(1);
    h.pool.end(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains at most L native attempts after caller timeout and destroys late raw exactly once", async () => {
    vi.useFakeTimers();
    const h = fixture(2);
    h.control.holdAcquire = true;
    const attempts = [h.request(), h.request()];
    await vi.advanceTimersByTimeAsync(5000);
    attempts.forEach((done) => failure(done, "connection_timeout"));
    const queued = Array.from({ length: QUEUE }, () => h.request());
    failure(h.request(), "connection_queue_full");
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    h.control.holdAcquire = false;
    for (const pending of h.pendingAcquires) {
      pending.callback(null, pending.raw);
      pending.callback(null, pending.raw);
      expect(pending.raw.query).not.toHaveBeenCalled();
      expect(pending.raw.destroy).toHaveBeenCalledTimes(1);
    }
    await pump();
    expect(h.getConnection).toHaveBeenCalledTimes(4);
    expect(h.maximumActive()).toBe(2);
    lease(queued[0]!).release();
    lease(queued[1]!).release();
    h.pool.end(vi.fn());
    queued.slice(2).forEach((done) => failure(done, "closed"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline when a queued request is promoted to native acquire", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      held = lease(h.request()),
      queued = h.request();
    await vi.advanceTimersByTimeAsync(4999);
    h.control.holdAcquire = true;
    held.release();
    await pump();
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    failure(queued, "connection_timeout");
    const fresh = h.request();
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    const pending = h.pendingAcquires[0]!;
    h.control.holdAcquire = false;
    pending.callback(null, pending.raw);
    await pump();
    expect(pending.raw.destroy).toHaveBeenCalledTimes(1);
    expect(pending.raw.query).toHaveBeenCalledTimes(1); // Only the original held lease bootstrap.
    lease(fresh).release();
    expect(h.maximumActive()).toBe(1);
  });

  it("rejects a late native success without relying on its timeout callback running first", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = fixture();
    h.control.holdAcquire = true;
    const done = h.request(),
      pending = h.pendingAcquires[0]!;
    now = 5000;
    pending.callback(null, pending.raw);
    failure(done, "connection_timeout");
    expect(pending.raw.query).not.toHaveBeenCalled();
    expect(pending.raw.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([4999, 5000, 5001])(
    "checks the bootstrap completion against the shared deadline at %dms",
    (nowAtCompletion) => {
      vi.useFakeTimers();
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const h = fixture();
      h.control.holdQuery = (statement) => statement.startsWith("SET SESSION max_statement_time");
      const done = h.request(),
        pending = h.pendingQueries[0]!;
      now = nowAtCompletion;
      pending.callback(null, []);
      pending.callback(null, []);
      if (nowAtCompletion < 5000) {
        lease(done).release();
        expect(pending.raw.destroy).not.toHaveBeenCalled();
      } else {
        failure(done, "connection_timeout");
        expect(pending.raw.destroy).toHaveBeenCalledTimes(1);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("includes queue time in the bootstrap deadline even with retention's ten-second SQL budget", async () => {
    vi.useFakeTimers();
    const h = fixture(1, () => false, 10000);
    const held = lease(h.request()),
      queued = h.request();
    await vi.advanceTimersByTimeAsync(4000);
    h.control.holdQuery = () => true;
    held.release();
    await pump();
    await vi.advanceTimersByTimeAsync(999);
    expect(queued).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    failure(queued, "connection_timeout");
    h.pendingQueries[0]!.callback(null, []);
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves readiness and caller AsyncLocalStorage across a different releasing context", async () => {
    const context = new AsyncLocalStorage<{ ready: boolean; name: string }>();
    const h = fixture(1, () => context.getStore()?.ready === true);
    const held = lease(h.request()),
      observed: (string | undefined)[] = [];
    context.run({ ready: true, name: "readiness" }, () =>
      h.pool.getConnection((_error, raw) => {
        observed.push(context.getStore()?.name);
        raw.release();
      }),
    );
    context.run({ ready: false, name: "ordinary" }, () =>
      h.pool.getConnection((_error, raw) => {
        observed.push(context.getStore()?.name);
        raw.release();
      }),
    );
    context.run({ ready: false, name: "releaser" }, () => held.release());
    await pump();
    expect(observed).toEqual(["readiness", "ordinary"]);
    expect(h.statements).toEqual([
      "SET SESSION max_statement_time = 5",
      "SET SESSION max_statement_time = 1",
      "SET SESSION max_statement_time = 5",
    ]);
  });

  it("never revives an old facade or double-returns the same permit on physical reuse", async () => {
    const h = fixture(),
      first = lease(h.request()),
      next = h.request();
    first.release();
    first.release();
    first.destroy();
    await pump();
    const second = lease(next),
      third = h.request(),
      staleQuery = vi.fn();
    first.query("SELECT stale", [], staleQuery);
    first.destroy();
    first.release();
    expect(staleQuery).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "closed" }),
      undefined,
    );
    expect(third).not.toHaveBeenCalled();
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    expect(h.raws[0]!.on).toHaveBeenCalledTimes(1);
    expect(h.raws[0]!.destroy).not.toHaveBeenCalled();
    second.release();
    second.destroy();
    await pump();
    lease(third).release();
    expect(h.maximumActive()).toBe(1);
    expect(h.statements).not.toContain("SELECT stale");
  });

  it("discards a released lease with pending SQL and ignores its late result", async () => {
    const h = fixture(),
      first = lease(h.request()),
      done = vi.fn();
    h.control.holdQuery = (statement) => statement === "SELECT slow";
    first.query("SELECT slow", [], done);
    const queued = h.request();
    first.release();
    first.release();
    await pump();
    expect(done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "closed" }),
      undefined,
    );
    h.pendingQueries[0]!.callback(null, []);
    expect(done).toHaveBeenCalledTimes(1);
    expect(h.raws[0]!.release).not.toHaveBeenCalled();
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    lease(queued).release();
  });

  it("handles query-timeout, release, destroy and physical error without double recovery", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      first = lease(h.request()),
      done = vi.fn(() => first.release());
    h.control.holdQuery = (statement) => statement === "SELECT slow";
    first.query("SELECT slow", [], done);
    const queued = h.request();
    await vi.advanceTimersByTimeAsync(4999);
    // Keep the queued request alive slightly longer than the query watchdog.
    const fresh = h.request();
    await vi.advanceTimersByTimeAsync(1);
    failure(queued, "connection_timeout");
    expect(done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "query_timeout" }),
      undefined,
    );
    first.destroy();
    h.emitError(h.raws[0]!);
    h.pendingQueries[0]!.callback(null, []);
    await pump();
    lease(fresh).release();
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(h.raws[0]!.release).not.toHaveBeenCalled();
    expect(h.maximumActive()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not subtract a permit for an idle physical error", async () => {
    const h = fixture(),
      first = lease(h.request());
    first.release();
    h.emitError(h.raws[0]!);
    const second = lease(h.request()),
      queued = h.request();
    expect(queued).not.toHaveBeenCalled();
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    second.release();
    await pump();
    lease(queued).release();
    expect(h.maximumActive()).toBe(1);
  });

  it("preserves query_timeout when destroy synchronously reports a native query failure", async () => {
    vi.useFakeTimers();
    const h = fixture(),
      first = lease(h.request()),
      done = vi.fn();
    h.control.holdQuery = (statement) => statement === "SELECT slow";
    first.query("SELECT slow", [], done);
    vi.mocked(h.raws[0]!.destroy).mockImplementation(() => {
      h.active.delete(h.raws[0]!);
      h.all.delete(h.raws[0]!);
      h.pendingQueries[0]!.callback(new Error("synthetic native closed"), undefined);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: "query_timeout" }),
      undefined,
    );
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    lease(h.request()).release();
  });

  it.each(["failAcquire", "throwAcquire", "errorWithRaw", "throwListener"] as const)(
    "recovers after %s without consuming a second permit",
    async (key) => {
      const h = fixture();
      h.control[key] = true;
      failure(h.request(), "connection");
      h.control[key] = false;
      lease(h.request()).release();
      await pump();
      expect(h.maximumActive()).toBeLessThanOrEqual(1);
    },
  );

  it.each(["error", "throw"])("recovers after bootstrap %s", (kind) => {
    const h = fixture();
    if (kind === "error") h.control.failQuery = () => new Error("synthetic bootstrap failure");
    else h.control.throwQuery = () => true;
    failure(h.request(), "connection");
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    h.control.failQuery = () => null;
    h.control.throwQuery = () => false;
    lease(h.request()).release();
  });

  it("handles a native callback then throw without losing the delivered lease", () => {
    const h = fixture();
    h.control.throwAfterCallback = true;
    const first = lease(h.request());
    h.control.throwAfterCallback = false;
    const queued = h.request();
    expect(queued).not.toHaveBeenCalled();
    first.release();
    h.pool.end(vi.fn());
    failure(queued, "closed");
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("discards a native callback arriving after the acquisition function threw", () => {
    const h = fixture();
    h.control.holdAcquire = true;
    h.control.throwAfterHolding = true;
    const done = h.request(),
      pending = h.pendingAcquires[0]!;
    failure(done, "connection");
    pending.callback(null, pending.raw);
    expect(pending.raw.destroy).toHaveBeenCalledTimes(1);
    expect(pending.raw.query).not.toHaveBeenCalled();
    h.control.holdAcquire = false;
    h.control.throwAfterHolding = false;
    lease(h.request()).release();
  });

  it("contains consumer callback exceptions and returns their permits", () => {
    const h = fixture();
    h.pool.getConnection(() => {
      throw new Error("synthetic callback throw");
    });
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    const next = lease(h.request());
    next.query("SELECT callback", [], () => {
      throw new Error("synthetic query callback throw");
    });
    expect(h.raws[1]!.destroy).toHaveBeenCalledTimes(1);
    lease(h.request()).release();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("discards a release failure before returning its permit", () => {
    const h = fixture(),
      first = lease(h.request());
    h.control.throwRelease = true;
    expect(() => first.release()).toThrow(expect.objectContaining({ reason: "cleanup" }));
    first.release();
    first.destroy();
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    h.control.throwRelease = false;
    lease(h.request()).release();
  });

  it("never reuses a socket whose destroy throws or retries it inside admission", () => {
    const h = fixture(),
      first = lease(h.request());
    h.control.throwDestroy = true;
    first.destroy();
    first.destroy();
    first.release();
    failure(h.request(), "connection");
    expect(h.getConnection).toHaveBeenCalledTimes(2);
    expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(h.raws[0]!.release).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("rejects work if an expired callback re-enters end during getConnection", () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = fixture();
    lease(h.request());
    h.pool.getConnection(() => h.pool.end(vi.fn()));
    now = 5001;
    failure(h.request(), "closed");
    expect(h.getConnection).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes queued, acquiring, bootstrap and delivered work exactly once", () => {
    vi.useFakeTimers();
    const h = fixture(3),
      held = lease(h.request());
    h.control.holdQuery = () => true;
    const bootstrap = h.request();
    h.control.holdAcquire = true;
    const acquiring = h.request();
    const queued = [h.request(), h.request()],
      ends = [vi.fn(), vi.fn()];
    h.control.holdEnd = true;
    h.pool.end(ends[0]!);
    h.pool.end(ends[1]!);
    [bootstrap, acquiring, ...queued].forEach((done) => failure(done, "closed"));
    failure(h.request(), "closed");
    h.pendingAcquires[0]!.callback(null, h.pendingAcquires[0]!.raw);
    h.pendingQueries[0]!.callback(null, []);
    held.release();
    held.destroy();
    h.endCompletions[0]!(null);
    h.endCompletions[0]!(new Error("late end error"));
    ends.forEach((done) => expect(done).toHaveBeenCalledExactlyOnceWith(null));
    const laterEnd = vi.fn();
    h.pool.end(laterEnd);
    expect(laterEnd).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.getConnection).toHaveBeenCalledTimes(3);
    h.raws.forEach((raw) => expect(raw.destroy).toHaveBeenCalledTimes(1));
    expect(vi.getTimerCount()).toBe(0);
    expect(h.all.size).toBe(0);
  });

  it.each(["error", "timeout"])(
    "bounds shutdown %s and ignores late native results",
    async (kind) => {
      vi.useFakeTimers();
      const h = fixture();
      h.control.holdAcquire = true;
      h.control.holdEnd = true;
      const acquiring = h.request(),
        queued = h.request(),
        done = vi.fn();
      h.pool.end(done);
      failure(acquiring, "closed");
      failure(queued, "closed");
      if (kind === "error") h.endCompletions[0]!(new Error("synthetic end failure"));
      else await vi.advanceTimersByTimeAsync(5000);
      expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: "cleanup" }));
      h.endCompletions[0]!(null);
      h.pendingAcquires[0]!.callback(null, h.pendingAcquires[0]!.raw);
      expect(h.raws[0]!.destroy).toHaveBeenCalledTimes(1);
      expect(h.raws[0]!.query).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("handles 2000 synchronous acquire/release re-entries without recursion or listener growth", async () => {
    const h = fixture();
    let completed = 0;
    const consume: AcquireCallback = (_error, raw) => {
      completed++;
      raw.release();
      if (completed < 2000) h.pool.getConnection(consume);
    };
    h.pool.getConnection(consume);
    await pump();
    expect(completed).toBe(2000);
    expect(h.getConnection).toHaveBeenCalledTimes(2000);
    expect(h.maximumActive()).toBe(1);
    expect(h.raws).toHaveLength(1);
    expect(h.raws[0]!.on).toHaveBeenCalledTimes(1);
  });

  it("removes 6400 expired requests across repeated overload and recovery without delayed native work", async () => {
    vi.useFakeTimers();
    const h = fixture();
    for (let cycle = 0; cycle < 100; cycle++) {
      const held = lease(h.request());
      const queued = Array.from({ length: 64 }, () => h.request());
      await vi.advanceTimersByTimeAsync(5000);
      queued.forEach((done) => failure(done, "connection_timeout"));
      held.release();
      await pump();
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(h.getConnection).toHaveBeenCalledTimes(100);
    expect(h.raws).toHaveLength(1);
    expect(h.raws[0]!.on).toHaveBeenCalledTimes(1);
    expect(h.raws[0]!.destroy).not.toHaveBeenCalled();
    expect(h.maximumActive()).toBe(1);
  }, 15000);
});
