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
let retentionPool: Pool;
let workerPool: Pool;
let ownerUserId: string;

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
  await migrate("up", 16);

  appPool = new Pool({
    connectionString: databaseUrl("classhub_app", "local_app_password"),
  });
  operatorPool = new Pool({
    connectionString: databaseUrl("classhub_operator", "local_operator_password"),
  });
  retentionPool = new Pool({
    connectionString: databaseUrl("classhub_retention", "local_retention_password"),
  });
  workerPool = new Pool({
    connectionString: databaseUrl("classhub_worker", "local_worker_password"),
  });

  const owner = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'assessment-owner@example.com', '평가 기록 학생', 'argon2-placeholder', now()
    )
    RETURNING id
  `);
  ownerUserId = owner.rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([
    appPool?.end(),
    bootstrapPool?.end(),
    operatorPool?.end(),
    retentionPool?.end(),
    workerPool?.end(),
  ]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("student assessment records migration", () => {
  it("enforces draft and recorded contracts while allowing app-owned CRUD", async () => {
    const draft = await appPool.query<{ id: string; status: string }>(
      `
        INSERT INTO student_assessment_records (
          owner_user_id, academic_year, semester, assessment_type, subject, title
        ) VALUES ($1, 2026, 1, 'performance', '수학', '수학 주제 탐구')
        RETURNING id, status
      `,
      [ownerUserId],
    );
    expect(draft.rows[0]?.status).toBe("draft");

    await appPool.query(
      `
        UPDATE student_assessment_records
        SET
          assessment_date = DATE '2026-07-20',
          score_hundredths = 9250,
          max_score_hundredths = 10000,
          weight_basis_points = 2000,
          memo = '발표와 보고서 점수',
          status = 'recorded',
          recorded_at = TIMESTAMPTZ '2026-07-30 00:00:00+00',
          expires_at = TIMESTAMPTZ '2026-07-30 00:00:00+00' + interval '365 days',
          updated_at = clock_timestamp(),
          row_version = row_version + 1
        WHERE id = $1
      `,
      [draft.rows[0]!.id],
    );

    const recorded = await appPool.query<{
      max_score_hundredths: number;
      score_hundredths: number;
      status: string;
    }>(
      `
        SELECT status, score_hundredths, max_score_hundredths
        FROM student_assessment_records
        WHERE id = $1
      `,
      [draft.rows[0]!.id],
    );
    expect(recorded.rows[0]).toEqual({
      max_score_hundredths: 10_000,
      score_hundredths: 9_250,
      status: "recorded",
    });

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO student_assessment_records (
            owner_user_id, status, academic_year, semester, assessment_type,
            subject, title, assessment_date, score_hundredths,
            max_score_hundredths, recorded_at, expires_at
          ) VALUES (
            $1, 'recorded', 2026, 1, 'written',
            '영어', '1학기 지필', DATE '2026-06-30', 8000,
            NULL, TIMESTAMPTZ '2026-07-30 00:00:00+00',
            TIMESTAMPTZ '2027-07-30 00:00:00+00'
          )
        `,
        [ownerUserId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO student_assessment_records (
            owner_user_id, academic_year, assessment_date
          ) VALUES ($1, 2026, DATE '2026-02-28')
        `,
        [ownerUserId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO student_assessment_records (
            owner_user_id, score_hundredths, max_score_hundredths
          ) VALUES ($1, 10100, 10000)
        `,
        [ownerUserId],
      ),
      "23514",
    );

    await appPool.query("DELETE FROM student_assessment_records WHERE id = $1", [
      draft.rows[0]!.id,
    ]);
  });

  it("keeps exact runtime role privileges and denies unrelated roles", async () => {
    const privileges = await bootstrapPool.query<{
      app_delete: boolean;
      app_insert: boolean;
      app_select: boolean;
      app_update: boolean;
      operator_select: boolean;
      retention_delete: boolean;
      retention_insert: boolean;
      retention_select: boolean;
      retention_update: boolean;
      worker_select: boolean;
    }>(`
      SELECT
        has_table_privilege('classhub_app', 'student_assessment_records', 'SELECT') AS app_select,
        has_table_privilege('classhub_app', 'student_assessment_records', 'INSERT') AS app_insert,
        has_table_privilege('classhub_app', 'student_assessment_records', 'UPDATE') AS app_update,
        has_table_privilege('classhub_app', 'student_assessment_records', 'DELETE') AS app_delete,
        has_table_privilege('classhub_retention', 'student_assessment_records', 'SELECT')
          AS retention_select,
        has_table_privilege('classhub_retention', 'student_assessment_records', 'INSERT')
          AS retention_insert,
        has_table_privilege('classhub_retention', 'student_assessment_records', 'UPDATE')
          AS retention_update,
        has_table_privilege('classhub_retention', 'student_assessment_records', 'DELETE')
          AS retention_delete,
        has_table_privilege('classhub_operator', 'student_assessment_records', 'SELECT')
          AS operator_select,
        has_table_privilege('classhub_worker', 'student_assessment_records', 'SELECT')
          AS worker_select
    `);
    expect(privileges.rows[0]).toEqual({
      app_delete: true,
      app_insert: true,
      app_select: true,
      app_update: true,
      operator_select: false,
      retention_delete: true,
      retention_insert: false,
      retention_select: true,
      retention_update: false,
      worker_select: false,
    });

    await expectPostgresError(
      operatorPool.query("SELECT id FROM student_assessment_records LIMIT 1"),
      "42501",
    );
    await expectPostgresError(
      workerPool.query("SELECT id FROM student_assessment_records LIMIT 1"),
      "42501",
    );
    await expectPostgresError(
      retentionPool.query("INSERT INTO student_assessment_records (owner_user_id) VALUES ($1)", [
        ownerUserId,
      ]),
      "42501",
    );

    const expired = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO student_assessment_records (
          owner_user_id, expires_at, created_at, updated_at
        ) VALUES (
          $1,
          clock_timestamp() - interval '1 day',
          clock_timestamp() - interval '31 days',
          clock_timestamp() - interval '31 days'
        )
        RETURNING id
      `,
      [ownerUserId],
    );
    const deleted = await retentionPool.query<{ id: string }>(
      "DELETE FROM student_assessment_records WHERE id = $1 RETURNING id",
      [expired.rows[0]!.id],
    );
    expect(deleted.rows).toEqual([{ id: expired.rows[0]!.id }]);
  });

  it("refuses destructive down with data and restores cleanly after explicit deletion", async () => {
    const retained = await appPool.query<{ id: string }>(
      `
        INSERT INTO student_assessment_records (owner_user_id, title)
        VALUES ($1, 'rollback guard')
        RETURNING id
      `,
      [ownerUserId],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /student assessment rollback requires student_assessment_records to be empty/u,
    );

    await appPool.query("DELETE FROM student_assessment_records WHERE id = $1", [
      retained.rows[0]!.id,
    ]);
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{ latest: string; table_count: string }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        (
          SELECT count(*)::text
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'student_assessment_records'
        ) AS table_count
    `);
    expect(restored.rows[0]).toEqual({
      latest: "1783700014000_neis-school-details",
      table_count: "0",
    });

    await migrate("up", 1);
  });
});
