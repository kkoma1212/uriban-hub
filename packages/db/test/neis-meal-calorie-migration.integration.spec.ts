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

describe.sequential("NEIS meal calorie migration", () => {
  it("preserves existing rows and grants only the new calorie column to the operator", async () => {
    await migrate("up", 12);
    await bootstrapPool.query(`
      INSERT INTO schools (
        edu_office_code, school_code, school_name, school_kind,
        region_name, edu_office_name
      ) VALUES (
        'M10', '8021028', 'Migration test school', 'middle',
        'Test region', 'Test office'
      )
    `);
    await bootstrapPool.query(`
      INSERT INTO meals (
        edu_office_code, school_code, meal_date, meal_type,
        menu_json, source, source_updated_at
      ) VALUES (
        'M10', '8021028', DATE '2026-07-01', 'lunch',
        '[{"name":"Existing meal","allergens":[]}]'::jsonb,
        'seed', TIMESTAMPTZ '2026-07-01T00:00:00Z'
      )
    `);

    await migrate("up", 1);

    const migrated = await bootstrapPool.query<{
      calorie_kcal_tenths: number | null;
      latest: string;
    }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        calorie_kcal_tenths
      FROM meals
      WHERE meal_date = DATE '2026-07-01'
    `);
    expect(migrated.rows[0]).toEqual({
      calorie_kcal_tenths: null,
      latest: "1783700012000_neis-meal-calorie",
    });

    await operatorPool.query(`
      INSERT INTO meals (
        edu_office_code, school_code, meal_date, meal_type,
        menu_json, calorie_kcal_tenths, source, source_loaded_on, source_updated_at
      ) VALUES (
        'M10', '8021028', DATE '2026-07-02', 'lunch',
        '[{"name":"NEIS meal","allergens":["1"]}]'::jsonb,
        14522, 'neis', DATE '2026-07-29', TIMESTAMPTZ '2026-07-29T00:00:00Z'
      )
    `);
    const calorie = await operatorPool.query<{ calorie_kcal_tenths: number }>(`
      SELECT calorie_kcal_tenths
      FROM meals
      WHERE meal_date = DATE '2026-07-02'
    `);
    expect(calorie.rows[0]?.calorie_kcal_tenths).toBe(14522);

    await expectPostgresError(
      bootstrapPool.query(`
        UPDATE meals
        SET calorie_kcal_tenths = 100000
        WHERE meal_date = DATE '2026-07-02'
      `),
      "23514",
    );
  });

  it("refuses a destructive down until calorie values are cleared", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /NEIS meal calorie rollback requires every calorie value to be null/,
    );

    await bootstrapPool.query("UPDATE meals SET calorie_kcal_tenths = NULL");
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      calorie_column: string | null;
      count: string;
      latest: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        (
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'meals'
            AND column_name = 'calorie_kcal_tenths'
        ) AS calorie_column
    `);
    expect(restored.rows[0]).toEqual({
      calorie_column: null,
      count: "12",
      latest: "1783700011000_neis-meal-source",
    });

    await migrate("up", 1);
  });
});
