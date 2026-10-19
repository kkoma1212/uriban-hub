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

describe.sequential("NEIS school schedule migration", () => {
  it("preserves class schedules and exposes official events read-only to the app role", async () => {
    await migrate("up", 13);
    await bootstrapPool.query(`
      WITH created_operator AS (
        INSERT INTO operators (email_normalized, credential_hash)
        VALUES ('migration-operator@classhub.local', decode(repeat('11', 32), 'hex'))
        RETURNING id
      ), created_user AS (
        INSERT INTO users (email_normalized, display_name, password_hash)
        VALUES ('migration-teacher@classhub.local', '교사', 'test-hash')
        RETURNING id
      ), created_profile AS (
        INSERT INTO teacher_profiles (
          user_id,
          temporary_password_must_change,
          temporary_password_expires_at,
          created_by_operator_id
        )
        SELECT created_user.id, FALSE, NULL, created_operator.id
        FROM created_user, created_operator
        RETURNING id
      ), created_school AS (
        INSERT INTO schools (
          edu_office_code, school_code, school_name, school_kind,
          region_name, edu_office_name
        ) VALUES (
          'J10', '7530063', '동안고등학교', 'high',
          '경기도', '경기도교육청'
        )
        RETURNING edu_office_code
      ), created_class AS (
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        )
        SELECT '1반', 2026, 2, 'J10', '7530063', 30, id
        FROM created_user
        RETURNING id
      ), created_member AS (
        INSERT INTO class_members (class_id, user_id, role, status, student_number)
        SELECT created_class.id, created_user.id, 'teacher', 'approved', NULL
        FROM created_class, created_user
        RETURNING id, class_id
      )
      INSERT INTO schedules (
        class_id, title, schedule_type, due_date, created_by_member_id
      )
      SELECT class_id, '기존 학급 일정', 'exam', DATE '2026-07-01', id
      FROM created_member
    `);

    await migrate("up", 1);

    const migrated = await bootstrapPool.query<{ latest: string; title: string }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        title
      FROM schedules
      WHERE title = '기존 학급 일정'
    `);
    expect(migrated.rows[0]).toEqual({
      latest: "1783700013000_neis-school-schedules",
      title: "기존 학급 일정",
    });

    await operatorPool.query(`
      INSERT INTO school_schedule_events (
        edu_office_code, school_code, academic_year, event_date, event_name,
        event_content, school_day_type, grade_mask, source_loaded_on, source_updated_at
      ) VALUES (
        'J10', '7530063', 2026, DATE '2026-07-01', '2차 정기시험',
        NULL, '수업일', 7, DATE '2026-07-30', TIMESTAMPTZ '2026-07-30T00:00:00Z'
      )
    `);
    const visible = await appPool.query<{ event_name: string }>(
      "SELECT event_name FROM school_schedule_events",
    );
    expect(visible.rows).toEqual([{ event_name: "2차 정기시험" }]);

    await expectPostgresError(
      appPool.query(`
        INSERT INTO school_schedule_events (
          edu_office_code, school_code, academic_year, event_date, event_name,
          school_day_type, grade_mask, source_loaded_on, source_updated_at
        ) VALUES (
          'J10', '7530063', 2026, DATE '2026-07-02', '앱 위조 일정',
          '수업일', 7, DATE '2026-07-30', now()
        )
      `),
      "42501",
    );
    await expectPostgresError(operatorPool.query("DELETE FROM school_schedule_events"), "42501");
    await expectPostgresError(
      bootstrapPool.query("UPDATE school_schedule_events SET grade_mask = 0"),
      "23514",
    );
  });

  it("refuses destructive rollback until official events are explicitly cleared", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /NEIS school schedule rollback requires events, import logs, and audit rows to be empty/,
    );

    await bootstrapPool.query("DELETE FROM school_schedule_events");
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      count: string;
      event_table: string | null;
      latest: string;
      schedule_count: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        to_regclass('public.school_schedule_events')::text AS event_table,
        (SELECT max(name) FROM pgmigrations) AS latest,
        (SELECT count(*)::text FROM schedules WHERE title = '기존 학급 일정') AS schedule_count
    `);
    expect(restored.rows[0]).toEqual({
      count: "13",
      event_table: null,
      latest: "1783700012000_neis-meal-calorie",
      schedule_count: "1",
    });

    await migrate("up", 1);
  });
});
