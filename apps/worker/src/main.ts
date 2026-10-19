import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { createClient } from "redis";

import type { WorkerDatabase } from "./database.js";
import {
  openConfiguredWorkerDatabase,
  probeConfiguredWorkerDatabaseReadiness,
  createConfiguredSecurityAuditStore,
} from "./configured-database.js";
import { loadWorkerEnvironment } from "./environment.js";
import { WorkerHealthServer } from "./health-server.js";
import { probeWorkerRedisReadiness } from "./redis-readiness.js";
import { SecurityAuditWorker } from "./security-audit/security-audit-worker.js";
import { SecurityAuditProcessingStatus } from "./security-audit/processing-status.js";
import { readSecurityAuditQueueMetadata } from "./security-audit/queue-metadata.js";
import { readServiceIdentity } from "./service-identity.js";

const environment = loadWorkerEnvironment();
const logger = pino({
  /*
   * pino 기본 필드(pid·hostname) 대신 최소 log 계약이 요구하는 신원 필드를 붙인다.
   * hostname은 instance_id로 그대로 남고, pid는 더 이상 찍히지 않는다 — 재시작마다
   * 바뀌는 값이라 배포본을 짚는 데 쓸 수 없고, API 로그와 필드를 맞추는 편이 낫다.
   */
  base: readServiceIdentity("worker"),
  level: environment.logLevel,
  redact: {
    censor: "[REDACTED]",
    paths: ["token", "password", "email", "cookie", "authorization", "err"],
  },
});
const redis = createClient({
  socket: { connectTimeout: 5_000 },
  url: environment.redisUrl,
});
redis.on("error", () => undefined);
const readinessRedis = redis.duplicate({ disableOfflineQueue: true });
readinessRedis.on("error", () => undefined);
const controller = new AbortController();
let database: WorkerDatabase | undefined;
const processingStatus = new SecurityAuditProcessingStatus({
  readMetadata: () => readSecurityAuditQueueMetadata(redis),
  log: (snapshot) => {
    const level =
      snapshot.status === "degraded" ? "error" : snapshot.status === "ok" ? "info" : "warn";
    logger[level](
      { action: "security_audit.processing_status", ...snapshot },
      "Security audit processing status.",
    );
  },
});
const healthServer = new WorkerHealthServer({
  host: environment.healthHost,
  port: environment.healthPort,
  processingSnapshot: () => processingStatus.snapshot(),
  probes: {
    database: async () => {
      if (database === undefined) throw new Error("Worker database is not initialized.");
      await probeConfiguredWorkerDatabaseReadiness(database, environment);
    },
    redis: () => probeWorkerRedisReadiness(redis, readinessRedis),
  },
});

const shutdownHandlers = new Map<NodeJS.Signals, () => void>();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const handleShutdown = (): void => {
    healthServer.markStopping();
    controller.abort();
    if (redis.isOpen) redis.destroy();
    if (readinessRedis.isOpen) readinessRedis.destroy();
  };
  shutdownHandlers.set(signal, handleShutdown);
  process.once(signal, handleShutdown);
}

try {
  await healthServer.listen();
  controller.signal.throwIfAborted();
  database = await openConfiguredWorkerDatabase(environment, () => {
    healthServer.markNotReady();
    logger.error(
      {
        action: "database.idle_client_error",
        failure_code: "worker_database_connection_lost",
      },
      "Worker database idle connection was lost.",
    );
  });
  controller.signal.throwIfAborted();
  await Promise.all([redis.connect(), readinessRedis.connect()]);
  controller.signal.throwIfAborted();
  const worker = new SecurityAuditWorker(redis, database, logger, {
    persistence: createConfiguredSecurityAuditStore(database, environment),
    consumerName: `${hostname()}:${process.pid}:${randomUUID()}`,
  });
  await worker.initialize();
  processingStatus.sampleIfDue();
  controller.signal.throwIfAborted();
  healthServer.markReady();
  logger.info(
    {
      component: "worker",
      health_port: healthServer.port,
      jobs_registered: 1,
    },
    "Security audit worker started.",
  );

  while (!controller.signal.aborted) {
    try {
      processingStatus.cycleStarted();
      const result = await worker.runOnce(1_000);
      processingStatus.cycleCompleted(result);
      processingStatus.sampleIfDue();
      healthServer.markReady();
    } catch {
      processingStatus.cycleErrored();
      processingStatus.sampleIfDue();
      healthServer.markNotReady();
      if (controller.signal.aborted) break;
      logger.error(
        {
          action: "security_audit.worker_cycle_failed",
          failure_code: "worker_dependency_unavailable",
        },
        "Security audit worker cycle failed.",
      );
      await delay(1_000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  }
} catch (error) {
  if (!controller.signal.aborted) throw error;
} finally {
  healthServer.markStopping();
  for (const [signal, handleShutdown] of shutdownHandlers) {
    process.removeListener(signal, handleShutdown);
  }
  if (redis.isOpen) redis.destroy();
  if (readinessRedis.isOpen) readinessRedis.destroy();
  if (database !== undefined) await database.destroy();
  await healthServer.close();
}
