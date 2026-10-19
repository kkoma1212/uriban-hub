import { setImmediate as waitForImmediate } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerHealthServer, type WorkerHealthServerOptions } from "./health-server.js";
import { SecurityAuditProcessingStatus } from "./security-audit/processing-status.js";

const servers = new Set<WorkerHealthServer>();

async function startServer(
  override: Partial<WorkerHealthServerOptions> = {},
): Promise<WorkerHealthServer> {
  const server = new WorkerHealthServer({
    host: "127.0.0.1",
    port: 0,
    probes: {
      database: vi.fn().mockResolvedValue(undefined),
      redis: vi.fn().mockResolvedValue(undefined),
    },
    ...override,
  });
  servers.add(server);
  await server.listen();
  return server;
}

function request(server: WorkerHealthServer, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, init);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(Array.from(servers, (server) => server.close()));
  servers.clear();
});

describe("WorkerHealthServer", () => {
  it("exposes local processing degradation independently of healthy dependency probes", async () => {
    const processing = new SecurityAuditProcessingStatus({ readMetadata: vi.fn(), log: vi.fn() });
    processing.cycleCompleted({
      acknowledged: 0,
      deferred: 1,
      deadLettered: 0,
      invalid: 0,
      databaseFailures: { reference_missing: 1 },
    });
    const server = await startServer({ processingSnapshot: () => processing.snapshot() });
    server.markReady();
    const response = await request(server, "/processingz");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      deferredAttempts: 1,
      databaseFailures: { reference_missing: 1 },
    });
    expect((await request(server, "/readyz")).status).toBe(200);
    expect((await request(server, "/healthz")).status).toBe(200);
  });

  it("does not expose processing on a public bind even to a loopback client or forged headers", async () => {
    const processingSnapshot = vi.fn();
    const server = await startServer({ host: "0.0.0.0", processingSnapshot });
    const response = await request(server, "/processingz", {
      headers: { "x-forwarded-for": "127.0.0.1", host: "localhost" },
    });
    expect(response.status).toBe(404);
    expect(processingSnapshot).not.toHaveBeenCalled();
  });

  it("contains processing provider errors and keeps the readiness contract", async () => {
    const server = await startServer({
      processingSnapshot: () => {
        throw new Error("private operational data");
      },
    });
    server.markReady();
    const response = await request(server, "/processingz");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"not_ready"}');
    expect((await request(server, "/readyz")).status).toBe(200);
  });

  it("keeps liveness independent while readiness follows startup and shutdown state", async () => {
    const server = await startServer();

    const startingLiveness = await request(server, "/healthz");
    const startingReadiness = await request(server, "/readyz");
    expect(startingLiveness.status).toBe(200);
    await expect(startingLiveness.json()).resolves.toEqual({ status: "ok" });
    expect(startingReadiness.status).toBe(503);
    await expect(startingReadiness.json()).resolves.toEqual({ status: "not_ready" });

    server.markReady();
    const ready = await request(server, "/readyz");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ready" });

    server.markNotReady();
    expect((await request(server, "/readyz")).status).toBe(503);

    server.markReady();
    server.markStopping();
    server.markReady();
    expect((await request(server, "/readyz")).status).toBe(503);
    expect((await request(server, "/healthz")).status).toBe(200);
  });

  it.each(["database", "redis"] as const)(
    "fails closed without exposing the %s probe error and recovers",
    async (failedProbe) => {
      let dependencyAvailable = false;
      const database = vi.fn(async () => {
        if (failedProbe === "database" && !dependencyAvailable) {
          throw new Error("postgresql://user:secret@db/private");
        }
      });
      const redis = vi.fn(async () => {
        if (failedProbe === "redis" && !dependencyAvailable) {
          throw new Error("redis://:secret@cache/private");
        }
      });
      const server = await startServer({ probes: { database, redis } });
      server.markReady();

      const failed = await request(server, "/readyz");
      expect(failed.status).toBe(503);
      expect(await failed.text()).toBe('{"status":"not_ready"}');

      dependencyAvailable = true;
      const recovered = await request(server, "/readyz");
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toBe('{"status":"ready"}');
    },
  );

  it("bounds responses and shares one unresolved dependency probe", async () => {
    const stalled = deferred();
    const database = vi.fn(() => stalled.promise);
    const redis = vi.fn().mockResolvedValue(undefined);
    const server = await startServer({
      probes: { database, redis },
      responseTimeoutMs: 10,
    });
    server.markReady();

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => request(server, "/readyz")),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 12 }, () => 503),
    );
    expect(database).toHaveBeenCalledOnce();
    expect(redis).toHaveBeenCalledOnce();

    expect((await request(server, "/readyz")).status).toBe(503);
    expect(database).toHaveBeenCalledOnce();

    stalled.resolve();
    await stalled.promise;
    await waitForImmediate();

    expect((await request(server, "/readyz")).status).toBe(200);
    expect(database).toHaveBeenCalledTimes(2);
    expect(redis).toHaveBeenCalledTimes(2);
  });

  it("uses exact paths, GET-only probes, and non-cacheable JSON responses", async () => {
    const server = await startServer();

    const withQuery = await request(server, "/healthz?probe=1");
    expect(withQuery.status).toBe(200);
    expect(withQuery.headers.get("cache-control")).toBe("no-store");
    expect(withQuery.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const unknown = await request(server, "/healthz/extra");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ status: "not_found" });

    const disallowed = await request(server, "/healthz", { method: "POST" });
    expect(disallowed.status).toBe(405);
    expect(disallowed.headers.get("allow")).toBe("GET");
    await expect(disallowed.json()).resolves.toEqual({ status: "method_not_allowed" });
  });

  it("accepts dynamic test ports but rejects invalid server options", () => {
    const probes = {
      database: vi.fn().mockResolvedValue(undefined),
      redis: vi.fn().mockResolvedValue(undefined),
    };

    expect(() => new WorkerHealthServer({ host: "127.0.0.1", port: 0, probes })).not.toThrow();
    expect(() => new WorkerHealthServer({ host: "", port: 3001, probes })).toThrow(RangeError);
    expect(() => new WorkerHealthServer({ host: "127.0.0.1", port: -1, probes })).toThrow(
      RangeError,
    );
    expect(() => new WorkerHealthServer({ host: "127.0.0.1", port: 65_536, probes })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new WorkerHealthServer({
          host: "127.0.0.1",
          port: 3001,
          probes,
          responseTimeoutMs: 0,
        }),
    ).toThrow(RangeError);
  });
});
