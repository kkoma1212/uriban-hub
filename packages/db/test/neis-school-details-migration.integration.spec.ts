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

let appPool: Pool;
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
  appPool = new Pool({
    connectionString: databaseUrl("classhub_app", "local_app_password"),
  });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), bootstrapPool?.end(), operatorPool?.end()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("NEIS school details migration", () => {
  it("preserves existing schools and grants read-only app plus narrow operator access", async () => {
    await migrate("up", 14);
    await bootstrapPool.query(`
      INSERT INTO schools (
        edu_office_code, school_code, school_name, school_kind,
        region_name, edu_office_name
      ) VALUES (
        'J10', '7530063', '동안고등학교', 'high',
        '경기도', '경기도교육청'
      )
    `);

    await migrate("up", 1);

    const migrated = await appPool.query<{
      homepage_url: string | null;
      phone_number: string | null;
      road_address: string | null;
      road_address_detail: string | null;
    }>(`
      SELECT
        homepage_url,
        phone_number,
        road_address,
        road_address_detail
      FROM schools
      WHERE edu_office_code = 'J10' AND school_code = '7530063'
    `);
    expect(migrated.rows[0]).toEqual({
      homepage_url: null,
      phone_number: null,
      road_address: null,
      road_address_detail: null,
    });
    const migration = await bootstrapPool.query<{ latest: string }>(
      "SELECT max(name) AS latest FROM pgmigrations",
    );
    expect(migration.rows[0]?.latest).toBe("1783700014000_neis-school-details");

    await operatorPool.query(`
      UPDATE schools
      SET
        homepage_url = 'https://dongan-h.goeay.kr/',
        phone_number = '031-387-6105',
        road_address = '경기도 안양시 동안구 부림로 71',
        road_address_detail = '(평촌동,동안고등학교)'
      WHERE edu_office_code = 'J10' AND school_code = '7530063'
    `);
    const details = await appPool.query<{
      homepage_url: string;
      phone_number: string;
      road_address: string;
      road_address_detail: string;
    }>(`
      SELECT homepage_url, phone_number, road_address, road_address_detail
      FROM schools
      WHERE edu_office_code = 'J10' AND school_code = '7530063'
    `);
    expect(details.rows[0]).toEqual({
      homepage_url: "https://dongan-h.goeay.kr/",
      phone_number: "031-387-6105",
      road_address: "경기도 안양시 동안구 부림로 71",
      road_address_detail: "(평촌동,동안고등학교)",
    });

    await expectPostgresError(
      appPool.query(`
        UPDATE schools
        SET phone_number = '031-000-0000'
        WHERE edu_office_code = 'J10' AND school_code = '7530063'
      `),
      "42501",
    );
    await expectPostgresError(
      bootstrapPool.query(`
        UPDATE schools
        SET homepage_url = 'javascript:alert(1)'
        WHERE edu_office_code = 'J10' AND school_code = '7530063'
      `),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(`
        UPDATE schools
        SET phone_number = '학교 대표번호'
        WHERE edu_office_code = 'J10' AND school_code = '7530063'
      `),
      "23514",
    );
  });

  it("refuses a destructive down until every school detail is cleared", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /NEIS school details rollback requires every detail value to be null/u,
    );

    await bootstrapPool.query(`
      UPDATE schools
      SET
        homepage_url = NULL,
        phone_number = NULL,
        road_address = NULL,
        road_address_detail = NULL
    `);
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      count: string;
      details_column_count: string;
      latest: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (
          SELECT count(*)::text
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'schools'
            AND column_name IN (
              'homepage_url',
              'phone_number',
              'road_address',
              'road_address_detail'
            )
        ) AS details_column_count,
        (SELECT max(name) FROM pgmigrations) AS latest
    `);
    expect(restored.rows[0]).toEqual({
      count: "14",
      details_column_count: "0",
      latest: "1783700013000_neis-school-schedules",
    });

    await migrate("up", 1);
  });
});
