import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
const migrationFileNames = (await readdir(migrationsDirectory))
  .filter((fileName) => /^[0-9]{13}_[a-z0-9-]+\.sql$/u.test(fileName))
  .sort();
const migrationNames = migrationFileNames.map((fileName) => fileName.replace(/\.sql$/u, ""));
const firstRetentionMigrationIndex = (
  await Promise.all(
    migrationFileNames.map(async (fileName) => ({
      fileName,
      source: await readFile(
        new URL(fileName, new URL("../../../db/migrations/", import.meta.url)),
      ),
    })),
  )
).findIndex(({ source }) => source.includes("classhub_retention"));

let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;

function databaseUrl(username: string, password: string): string {
  const host = container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
  return `postgresql://${username}:${password}@${host}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function migrateToLatest(): Promise<void> {
  await runner({
    databaseUrl: migratorDatabaseUrl,
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    /*
     * **운영과 똑같이 하나씩 커밋한다.** 이 스펙이 재는 것은 "권한이 모자라 중간에
     * 실패하면 그 전까지는 적용된 채로 남는다" 이고, 그건 운영 CLI 의 기본 동작이다.
     * 한 트랜잭션으로 묶으면 전부 롤백되어 **시험이 운영과 다른 것을 재게 된다.**
     * (다른 스펙은 시계 드리프트를 피하려고 묶는다 — `migration-diagnostics.setup.ts`, T-HUB-47.)
     */
    singleTransaction: false,
    verbose: false,
  });
}

async function migrationLedger(): Promise<{ count: string; latest: string | null }> {
  const result = await bootstrapPool.query<{ count: string; latest: string | null }>(`
    SELECT count(*)::text AS count, max(name) AS latest
    FROM pgmigrations
  `);
  return result.rows[0]!;
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "synthetic_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  bootstrapPool = new Pool({
    connectionString: databaseUrl("classhub_bootstrap", "synthetic_bootstrap_password"),
  });
  await bootstrapPool.query(`
    CREATE ROLE classhub_migrator
      LOGIN PASSWORD 'synthetic_migrator_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE classhub_app
      LOGIN PASSWORD 'synthetic_app_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE classhub_worker
      LOGIN PASSWORD 'synthetic_worker_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    CREATE ROLE classhub_operator
      LOGIN PASSWORD 'synthetic_operator_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE classhub_dev
      TO classhub_migrator, classhub_app, classhub_worker, classhub_operator;
    GRANT USAGE, CREATE ON SCHEMA public TO classhub_migrator;
    GRANT USAGE ON SCHEMA public TO classhub_app, classhub_worker, classhub_operator;
  `);
  migratorDatabaseUrl = databaseUrl("classhub_migrator", "synthetic_migrator_password");
}, 120_000);

afterAll(async () => {
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("production role migration contract", () => {
  it("fails with four required roles and reaches the dynamic migration head after retention is added", async () => {
    expect(firstRetentionMigrationIndex).toBeGreaterThan(0);
    await expect(migrateToLatest()).rejects.toThrow(/classhub_retention/u);
    await expect(migrationLedger()).resolves.toEqual({
      count: String(firstRetentionMigrationIndex),
      latest: migrationNames[firstRetentionMigrationIndex - 1],
    });

    await bootstrapPool.query(`
      CREATE ROLE classhub_retention
        LOGIN PASSWORD 'synthetic_retention_password'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      GRANT CONNECT ON DATABASE classhub_dev TO classhub_retention;
      GRANT USAGE ON SCHEMA public TO classhub_retention;
    `);
    await migrateToLatest();
    await expect(migrationLedger()).resolves.toEqual({
      count: String(migrationNames.length),
      latest: migrationNames.at(-1),
    });

    const contract = await bootstrapPool.query<{
      local_admin_exists: boolean;
      production_role_count: string;
      unsafe_role_count: string;
    }>(`
      SELECT
        count(*) FILTER (
          WHERE rolname IN (
            'classhub_migrator',
            'classhub_app',
            'classhub_worker',
            'classhub_operator',
            'classhub_retention'
          )
        )::text AS production_role_count,
        count(*) FILTER (
          WHERE rolname IN (
            'classhub_migrator',
            'classhub_app',
            'classhub_worker',
            'classhub_operator',
            'classhub_retention'
          )
          AND (
            NOT rolcanlogin
            OR rolsuper
            OR rolcreatedb
            OR rolcreaterole
            OR rolinherit
            OR rolreplication
            OR rolbypassrls
          )
        )::text AS unsafe_role_count,
        bool_or(rolname = 'classhub_local_admin') AS local_admin_exists
      FROM pg_roles
    `);
    expect(contract.rows[0]).toEqual({
      local_admin_exists: false,
      production_role_count: "5",
      unsafe_role_count: "0",
    });
  });
});
