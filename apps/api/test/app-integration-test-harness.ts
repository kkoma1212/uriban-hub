import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";

import { loadEnvironment, type AppEnvironment } from "../src/config/environment.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

let postgres: StartedNativeTestService | undefined;
let redis: StartedNativeTestService | undefined;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  if (postgres === undefined) {
    throw new Error("The app integration PostgreSQL container has not started.");
  }
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(postgresUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql
      .raw(
        `CREATE TABLE pgmigrations (
          id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, run_on TIMESTAMPTZ NOT NULL
        )`,
      )
      .execute(migrator);
    for (const path of await loadAllTestMigrationPaths()) {
      const migration = await readFile(path, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

export interface AppIntegrationEnvironments {
  development: AppEnvironment;
  servedWeb: AppEnvironment;
}

export async function setupAppIntegrationEnvironments(): Promise<AppIntegrationEnvironments> {
  try {
    [postgres, redis] = await Promise.all([
      startNativeTestService("postgres", {
        POSTGRES_DB: "classhub_dev",
        POSTGRES_PASSWORD: "local_bootstrap_password",
        POSTGRES_USER: "classhub_bootstrap",
      }),
      startNativeTestService("redis"),
    ]);

    const bootstrapDatabase = createDatabase<DB>(
      postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
    );
    try {
      await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
    } finally {
      await bootstrapDatabase.destroy();
    }
    await applyMigrations();

    const baseEnvironment = {
      DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
      LOG_LEVEL: "fatal",
      NODE_ENV: "development",
      PUBLIC_API_ORIGIN: "http://localhost:5173",
      PUBLIC_APP_ORIGIN: "http://localhost:5173",
      REDIS_URL: `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`,
    };

    return {
      development: loadEnvironment({ ...baseEnvironment, SERVE_WEB: "false" }),
      servedWeb: loadEnvironment({ ...baseEnvironment, SERVE_WEB: "true" }),
    };
  } catch (error) {
    await teardownAppIntegrationEnvironments();
    throw error;
  }
}

export async function teardownAppIntegrationEnvironments(): Promise<void> {
  const containers = [postgres, redis];
  postgres = undefined;
  redis = undefined;
  const results = await Promise.allSettled(
    containers.map((container) => container?.stop() ?? Promise.resolve()),
  );
  const cleanupFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cleanupFailure !== undefined) {
    throw cleanupFailure.reason;
  }
}
