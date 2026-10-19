import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  openWorkerDatabase,
  probeWorkerDatabaseReadiness,
  type WorkerDatabase,
} from "../src/database.js";
import { WorkerHealthServer } from "../src/health-server.js";
import { probeWorkerRedisReadiness } from "../src/redis-readiness.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const workerDirectory = fileURLToPath(new URL("..", import.meta.url));

let database: WorkerDatabase;
let healthServer: WorkerHealthServer;
let postgres: StartedNativeTestService;
let redis: RedisClientType;
let redisContainer: StartedNativeTestService;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function workerDatabaseUrl(): string {
  return `postgresql://classhub_worker:local_worker_password@${reachableHost(
    postgres,
  )}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

function createRedisClient(): RedisClientType {
  const client = createClient({
    url: `redis://${reachableHost(redisContainer)}:${redisContainer.getMappedPort(6379)}`,
  });
  client.on("error", () => undefined);
  return client;
}

function request(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${healthServer.port}${path}`);
}

async function redisConnections(): Promise<Map<string, Record<string, string>>> {
  const rows = (await redis.sendCommand(["CLIENT", "LIST"])) as string;
  return new Map(
    rows
      .trim()
      .split("\n")
      .map((row) => {
        const fields = Object.fromEntries(
          row
            .trim()
            .split(" ")
            .map((field) => {
              const separator = field.indexOf("=");
              return [field.slice(0, separator), field.slice(separator + 1)];
            }),
        );
        return [fields.id!, fields];
      }),
  );
}

async function waitForRedisState(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Redis connection state did not settle.");
}

async function reserveFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve a loopback port for the worker process.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

async function waitForStatus(
  child: ChildProcess,
  url: string,
  expectedStatus: number,
): Promise<Response> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Worker process exited before its health probe (code ${child.exitCode}).`);
    }

    try {
      const response = await fetch(url);
      if (response.status === expectedStatus) return response;
    } catch {
      // The health listener may not have bound its port yet.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for worker health status ${expectedStatus}.`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    }),
    startNativeTestService("redis"),
  ]);

  const bootstrapDatabase = createDatabase<DB>(
    `postgresql://classhub_bootstrap:local_bootstrap_password@${reachableHost(
      postgres,
    )}:${postgres.getMappedPort(5432)}/classhub_dev`,
  );
  try {
    await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  } finally {
    await bootstrapDatabase.destroy();
  }

  database = await openWorkerDatabase(workerDatabaseUrl());
  redis = createRedisClient();
  await redis.connect();

  healthServer = new WorkerHealthServer({
    host: "127.0.0.1",
    port: 0,
    probes: {
      database: () => probeWorkerDatabaseReadiness(database),
      redis: async () => {
        if (!redis.isReady) throw new Error("Redis is not ready.");
        await redis.ping();
      },
    },
  });
  await healthServer.listen();
  healthServer.markReady();
}, 120_000);

afterAll(async () => {
  await healthServer?.close();
  if (redis?.isOpen) redis.destroy();
  await database?.destroy();
  await Promise.allSettled([postgres?.stop(), redisContainer?.stop()]);
}, 120_000);

describe("worker health integration", () => {
  it("fails closed and recovers across disposable Redis and PostgreSQL connections", async () => {
    const initiallyReady = await request("/readyz");
    expect(initiallyReady.status).toBe(200);
    await expect(initiallyReady.json()).resolves.toEqual({ status: "ready" });

    redis.destroy();
    const redisUnavailable = await request("/readyz");
    expect(redisUnavailable.status).toBe(503);
    await expect(redisUnavailable.json()).resolves.toEqual({ status: "not_ready" });
    expect((await request("/healthz")).status).toBe(200);

    redis = createRedisClient();
    await redis.connect();
    expect((await request("/readyz")).status).toBe(200);

    await database.destroy();
    const postgresUnavailable = await request("/readyz");
    expect(postgresUnavailable.status).toBe(503);
    await expect(postgresUnavailable.json()).resolves.toEqual({ status: "not_ready" });
    expect((await request("/healthz")).status).toBe(200);

    database = await openWorkerDatabase(workerDatabaseUrl());
    const recovered = await request("/readyz");
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ status: "ready" });
  });

  it("keeps readiness independent of a blocked read while requiring both connections", async () => {
    let workerRedis = createRedisClient();
    let probeRedis = createRedisClient();
    const server = new WorkerHealthServer({
      host: "127.0.0.1",
      port: 0,
      probes: {
        database: () => probeWorkerDatabaseReadiness(database),
        redis: () => probeWorkerRedisReadiness(workerRedis, probeRedis),
      },
    });
    const ready = () => fetch(`http://127.0.0.1:${server.port}/readyz`);
    let blocked: Promise<unknown> | undefined;
    try {
      await Promise.all([workerRedis.connect(), probeRedis.connect()]);
      await server.listen();
      server.markReady();
      const workerId = String(await workerRedis.sendCommand(["CLIENT", "ID"]));
      blocked = workerRedis
        .xRead({ key: "worker-health:empty-stream", id: "$" }, { BLOCK: 5_000 })
        .catch(() => undefined);
      await waitForRedisState(
        async () => (await redisConnections()).get(workerId)?.flags?.includes("b") === true,
      );
      expect((await ready()).status).toBe(200);
      expect((await redisConnections()).get(workerId)?.flags).toContain("b");

      workerRedis.destroy();
      await blocked;
      expect((await ready()).status).toBe(503);
      workerRedis = createRedisClient();
      await workerRedis.connect();
      expect((await ready()).status).toBe(200);
      probeRedis.destroy();
      expect((await ready()).status).toBe(503);
      probeRedis = createRedisClient();
      await probeRedis.connect();
      expect((await ready()).status).toBe(200);
    } finally {
      if (workerRedis.isOpen) workerRedis.destroy();
      if (probeRedis.isOpen) probeRedis.destroy();
      await blocked;
      await server.close();
    }
  });

  it("serves readiness with two owned Redis connections and releases them on worker exit", async () => {
    const port = await reserveFreeLoopbackPort();
    const beforeConnections = await redisConnections();
    const childEnvironment = {
      ...process.env,
      LOG_LEVEL: "fatal",
      NODE_ENV: "test",
      REDIS_URL: `redis://${reachableHost(redisContainer)}:${redisContainer.getMappedPort(6379)}`,
      WORKER_DATABASE_URL: workerDatabaseUrl(),
      WORKER_HEALTH_HOST: "127.0.0.1",
      WORKER_HEALTH_PORT: String(port),
    };
    delete childEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
    for (const key of Object.keys(childEnvironment)) {
      if (/^PGSSL/iu.test(key)) delete childEnvironment[key];
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: workerDirectory,
      env: childEnvironment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume();

    try {
      const readiness = await waitForStatus(child, `http://127.0.0.1:${port}/readyz`, 200);
      await expect(readiness.json()).resolves.toEqual({ status: "ready" });

      const liveness = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(liveness.status).toBe(200);
      await expect(liveness.json()).resolves.toEqual({ status: "ok" });
      const ownedConnections = [...(await redisConnections()).keys()].filter(
        (id) => !beforeConnections.has(id),
      );
      expect(ownedConnections).toHaveLength(2);
    } finally {
      await stopChild(child);
      await waitForRedisState(async () =>
        [...(await redisConnections()).keys()].every((id) => beforeConnections.has(id)),
      );
    }
  });
});
