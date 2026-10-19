import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;
let operatorPool: Pool;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function migrate(direction: "down" | "up", count?: number): Promise<void> {
  await runner({
    ...(count === undefined ? {} : { count }),
    databaseUrl: migratorDatabaseUrl,
    direction,
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
}

async function expectPostgresError(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });

  bootstrapPool = new Pool({
    connectionString: databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  });
  await bootstrapPool.query(await readFile(bootstrapPath, "utf8"));
  migratorDatabaseUrl = databaseUrl("classhub_migrator", "local_migrator_password");
  operatorPool = new Pool({
    connectionString: databaseUrl("classhub_operator", "local_operator_password"),
  });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([bootstrapPool?.end(), operatorPool?.end()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("NEIS meal source migration", () => {
  it("preserves seed rows and grants only the metadata needed by the operator", async () => {
    await migrate("up", 11);
    await bootstrapPool.query(`
      INSERT INTO schools (
        edu_office_code, school_code, school_name, school_kind,
        region_name, edu_office_name
      ) VALUES (
        'M10', '8021028', '연동 검증 학교', 'middle',
        '충청북도', '충청북도교육청'
      )
    `);
    await bootstrapPool.query(`
      INSERT INTO meals (
        edu_office_code, school_code, meal_date, meal_type,
        menu_json, source, source_updated_at
      ) VALUES (
        'M10', '8021028', DATE '2026-07-01', 'lunch',
        '[{"name":"기존 급식","allergens":[]}]'::jsonb,
        'seed', TIMESTAMPTZ '2026-07-01T00:00:00Z'
      )
    `);

    await migrate("up", 1);

    const migrated = await bootstrapPool.query<{
      latest: string;
      source: string;
      source_loaded_on: string | null;
    }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        source,
        source_loaded_on::text
      FROM meals
      WHERE meal_date = DATE '2026-07-01'
    `);
    expect(migrated.rows[0]).toEqual({
      latest: "1783700011000_neis-meal-source",
      source: "seed",
      source_loaded_on: null,
    });

    await operatorPool.query(`
      INSERT INTO meals (
        edu_office_code, school_code, meal_date, meal_type,
        menu_json, source, source_loaded_on, source_updated_at
      ) VALUES (
        'M10', '8021028', DATE '2026-07-02', 'lunch',
        '[{"name":"NEIS 급식","allergens":["1"]}]'::jsonb,
        'neis', DATE '2026-07-01', TIMESTAMPTZ '2026-07-01T01:00:00Z'
      )
    `);
    const visibleMetadata = await operatorPool.query<{
      source: string;
      source_loaded_on: string;
      source_updated_at: Date;
    }>(`
      SELECT source, source_loaded_on::text, source_updated_at
      FROM meals
      WHERE meal_date = DATE '2026-07-02'
    `);
    expect(visibleMetadata.rows[0]).toMatchObject({
      source: "neis",
      source_loaded_on: "2026-07-01",
    });
    await expectPostgresError(operatorPool.query("SELECT created_at FROM meals LIMIT 1"), "42501");

    await expectPostgresError(
      bootstrapPool.query(`
        INSERT INTO meals (
          edu_office_code, school_code, meal_date, meal_type,
          menu_json, source, source_loaded_on, source_updated_at
        ) VALUES (
          'M10', '8021028', DATE '2026-07-03', 'lunch',
          '[{"name":"잘못된 NEIS 급식","allergens":[]}]'::jsonb,
          'neis', NULL, now()
        )
      `),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(`
        INSERT INTO meals (
          edu_office_code, school_code, meal_date, meal_type,
          menu_json, source, source_loaded_on, source_updated_at
        ) VALUES (
          'M10', '8021028', DATE '2026-07-04', 'lunch',
          '[{"name":"잘못된 seed 급식","allergens":[]}]'::jsonb,
          'seed', DATE '2026-07-01', now()
        )
      `),
      "23514",
    );
  });

  it("refuses a destructive down while NEIS rows exist and restores v10 when clean", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /NEIS meal source rollback requires every meal to remain seed-only/,
    );

    const stillApplied = await bootstrapPool.query<{
      count: string;
      source_loaded_on: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'meals'
            AND column_name = 'source_loaded_on'
        ) AS source_loaded_on
    `);
    expect(stillApplied.rows[0]).toEqual({
      count: "12",
      source_loaded_on: "source_loaded_on",
    });

    await bootstrapPool.query("DELETE FROM meals WHERE source = 'neis'");
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      count: string;
      meals: string;
      source_loaded_on: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT count(*)::text FROM meals) AS meals,
        (
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'meals'
            AND column_name = 'source_loaded_on'
        ) AS source_loaded_on
    `);
    expect(restored.rows[0]).toEqual({
      count: "11",
      meals: "1",
      source_loaded_on: null,
    });

    await migrate("up", 1);
  });
});
