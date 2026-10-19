import { describe, expect, it } from "vitest";

import { loadWorkerEnvironment } from "./environment.js";

const PRODUCTION_ENVIRONMENT = {
  NODE_ENV: "production",
  REDIS_URL: "rediss://redis.internal:6380",
  WORKER_DATABASE_URL:
    "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=verify-full",
} as const;

describe("worker environment", () => {
  it("defaults to development for the current local worker and accepts plaintext loopback URLs", () => {
    expect(
      loadWorkerEnvironment({
        LOG_LEVEL: "warn",
        REDIS_URL: "redis://127.0.0.1:6379",
        WORKER_DATABASE_URL: "postgresql://classhub_worker:password@127.0.0.1:5432/classhub_dev",
      }),
    ).toEqual({
      databaseEngine: "postgres",
      healthHost: "127.0.0.1",
      healthPort: 3001,
      logLevel: "warn",
      nodeEnvironment: "development",
      redisUrl: "redis://127.0.0.1:6379",
      workerDatabaseUrl: "postgresql://classhub_worker:password@127.0.0.1:5432/classhub_dev",
    });
  });

  it("allows ephemeral plaintext dependencies in test", () => {
    expect(
      loadWorkerEnvironment({
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
        WORKER_DATABASE_URL: "postgresql://classhub_worker:password@127.0.0.1:5432/classhub_test",
      }).nodeEnvironment,
    ).toBe("test");
  });

  it("accepts certificate-verifying PostgreSQL and TLS Redis in production", () => {
    expect(loadWorkerEnvironment(PRODUCTION_ENVIRONMENT)).toEqual({
      databaseEngine: "postgres",
      healthHost: "0.0.0.0",
      healthPort: 3001,
      logLevel: "info",
      nodeEnvironment: "production",
      redisUrl: PRODUCTION_ENVIRONMENT.REDIS_URL,
      workerDatabaseUrl: PRODUCTION_ENVIRONMENT.WORKER_DATABASE_URL,
    });
  });

  it.each([
    [
      "missing sslmode",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub",
    ],
    [
      "disabled TLS",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=disable",
    ],
    [
      "sslmode=require",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=require",
    ],
    [
      "sslmode=verify-ca",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=verify-ca",
    ],
    [
      "the reviewer libpq downgrade",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=require&uselibpqcompat=true",
    ],
    [
      "duplicate sslmode",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&sslmode=verify-full",
    ],
    [
      "uppercase SSLMODE",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?SSLMODE=verify-full",
    ],
    [
      "an explicit ssl switch",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&ssl=0",
    ],
    [
      "an unapproved service option",
      "postgresql://classhub_worker:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&service=privileged-service",
    ],
  ])("rejects production PostgreSQL with %s", (_label, workerDatabaseUrl) => {
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        WORKER_DATABASE_URL: workerDatabaseUrl,
      }),
    ).toThrow("WORKER_DATABASE_URL");
  });

  it.each([
    [
      "a loopback hostname",
      "postgresql://classhub_worker:password@127.0.0.1/classhub?sslmode=verify-full",
    ],
    ["a missing password", "postgresql://classhub_worker@db.internal/classhub?sslmode=verify-full"],
  ])("rejects production PostgreSQL authority with %s", (_label, workerDatabaseUrl) => {
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        WORKER_DATABASE_URL: workerDatabaseUrl,
      }),
    ).toThrow("explicit remote hostname, nonblank password, and database name");
  });

  it("rejects process-wide TLS overrides supplied to the worker", () => {
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        PGSSLMODE: "disable",
      }),
    ).toThrow("PGSSL*");
  });

  it("rejects plaintext Redis in production, including loopback", () => {
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toThrow("production REDIS_URL must use rediss://");
  });

  it("rejects an invalid NODE_ENV", () => {
    expect(() =>
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        NODE_ENV: "staging",
      }),
    ).toThrow("NODE_ENV is invalid");
  });

  it("accepts an explicit internal health bind address and port", () => {
    expect(
      loadWorkerEnvironment({
        ...PRODUCTION_ENVIRONMENT,
        WORKER_HEALTH_HOST: "::1",
        WORKER_HEALTH_PORT: "65535",
      }),
    ).toMatchObject({
      healthHost: "::1",
      healthPort: 65_535,
    });
  });

  it.each(["localhost", "10.0.0.2", "", " worker.internal "])(
    "rejects the unapproved health bind host %j",
    (healthHost) => {
      expect(() =>
        loadWorkerEnvironment({
          ...PRODUCTION_ENVIRONMENT,
          WORKER_HEALTH_HOST: healthHost,
        }),
      ).toThrow("WORKER_HEALTH_HOST");
    },
  );

  it.each(["0", "-1", "1.5", "65536", " 3001", "3001 ", ""])(
    "rejects the invalid health port %j",
    (healthPort) => {
      expect(() =>
        loadWorkerEnvironment({
          ...PRODUCTION_ENVIRONMENT,
          WORKER_HEALTH_PORT: healthPort,
        }),
      ).toThrow("WORKER_HEALTH_PORT");
    },
  );

  it.each([
    ["a migrator DB role", "postgresql://classhub_migrator:password@db/classhub"],
    ["an app DB role", "postgresql://classhub_app:password@db/classhub"],
    ["a malformed URL", "not-a-url"],
  ])("rejects %s", (_label, workerDatabaseUrl) => {
    expect(() =>
      loadWorkerEnvironment({
        REDIS_URL: "redis://127.0.0.1:6379",
        WORKER_DATABASE_URL: workerDatabaseUrl,
      }),
    ).toThrow();
  });
});
