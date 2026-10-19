import { randomUUID } from "node:crypto";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapPool,
  databaseUrl,
  expectPostgresError,
  migrationsDirectory,
  migratorDatabaseUrl,
  operatorId,
  setupAttendanceMigrationTestHarness,
  teardownAttendanceMigrationTestHarness,
} from "./attendance-migration-test-harness.js";

let operatorPool: Pool;
let migratorPool: Pool;

async function applyOperatorMigration(direction: "down" | "up", count = 1): Promise<void> {
  await runner({
    count,
    databaseUrl: migratorDatabaseUrl,
    direction,
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
}

beforeAll(async () => {
  await setupAttendanceMigrationTestHarness();
  await bootstrapPool.query("GRANT SELECT (display_name) ON users TO classhub_operator");
  await bootstrapPool.query("GRANT USAGE ON SEQUENCE users_id_seq TO classhub_operator");
  await applyOperatorMigration("up");
  migratorPool = new Pool({ connectionString: migratorDatabaseUrl });
  operatorPool = new Pool({
    connectionString: databaseUrl("classhub_operator", "local_operator_password"),
  });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([operatorPool?.end(), migratorPool?.end()]);
  await teardownAttendanceMigrationTestHarness();
}, 120_000);

describe.sequential("operator runtime privilege migration", () => {
  it("provisions a non-privileged dedicated login with only schema usage", async () => {
    const identity = await operatorPool.query<{ current_user: string }>("SELECT current_user");
    expect(identity.rows[0]?.current_user).toBe("classhub_operator");

    const role = await bootstrapPool.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'classhub_operator'
    `);
    expect(role.rows[0]).toEqual({
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
    });
    expect(
      (
        await bootstrapPool.query<{ allowed: boolean }>(`
          SELECT has_schema_privilege('classhub_operator', 'public', 'USAGE') AS allowed
        `)
      ).rows[0]?.allowed,
    ).toBe(true);
    expect(
      (
        await bootstrapPool.query<{ allowed: boolean }>(`
          SELECT has_schema_privilege('classhub_operator', 'public', 'CREATE') AS allowed
        `)
      ).rows[0]?.allowed,
    ).toBe(false);
    await expectPostgresError(
      operatorPool.query("CREATE TABLE forbidden_operator_ddl (id int)"),
      "42501",
    );
  });

  it("allows only the operator and school columns required by current commands", async () => {
    const operator = await operatorPool.query(`
      SELECT id, credential_hash, status, revoked_at
      FROM operators
      LIMIT 1
    `);
    expect(operator.rowCount).toBe(1);
    await expectPostgresError(
      operatorPool.query("SELECT email_normalized FROM operators"),
      "42501",
    );
    await expectPostgresError(
      operatorPool.query("UPDATE operators SET status = 'revoked' WHERE id = $1", [operatorId]),
      "42501",
    );

    const school = await operatorPool.query(`
      SELECT edu_office_code, school_code
      FROM schools
      LIMIT 1
    `);
    expect(school.rowCount).toBe(1);
    await expectPostgresError(operatorPool.query("SELECT school_name FROM schools"), "42501");
    await expectPostgresError(operatorPool.query("UPDATE schools SET updated_at = now()"), "42501");

    const client = await operatorPool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO operators (email_normalized, credential_hash)
        VALUES ('operator-role-probe@example.com', decode(repeat('71', 32), 'hex'))
        RETURNING id
      `);
      await client.query(
        `
          INSERT INTO operator_audit_logs (
            actor_type, operator_id, action, target_type, target_id,
            after_json, run_id
          ) VALUES (
            'system', NULL, 'operator.bootstrapped', 'operator', $1::text,
            jsonb_build_object('operator_id', $1::bigint, 'status', 'active'), $2
          )
        `,
        [inserted.rows[0]!.id, randomUUID()],
      );
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("can transact seed meals and append required import logs but cannot rewrite their history", async () => {
    const client = await operatorPool.connect();
    try {
      await client.query("BEGIN");
      const meal = await client.query<{ id: string }>(`
        INSERT INTO meals (
          edu_office_code, school_code, meal_date, meal_type,
          menu_json, source, source_updated_at
        ) VALUES (
          'B10', '7060001', DATE '2099-01-02', 'lunch',
          '[{"name":"권한 테스트","allergens":[]}]'::jsonb, 'seed', now()
        ) RETURNING id
      `);
      await client.query(
        `
          UPDATE meals
          SET menu_json = '[{"name":"수정된 권한 테스트","allergens":[]}]'::jsonb,
              source = 'seed', source_updated_at = now(), updated_at = now()
          WHERE id = $1
        `,
        [meal.rows[0]!.id],
      );
      const runId = randomUUID();
      const checksum = "a".repeat(64);
      await client.query(
        `
          INSERT INTO meal_import_logs (
            run_id, operator_id, file_name, checksum,
            inserted_count, updated_count, deleted_count,
            skipped_count, failed_count, result, error_json,
            started_at, completed_at
          ) VALUES ($1, $2, 'operator-role.json', $3, 1, 1, 0, 0, 0, 'success', NULL, now(), now())
        `,
        [runId, operatorId, checksum],
      );
      await client.query(
        `
          INSERT INTO operator_audit_logs (
            actor_type, operator_id, action, target_type, target_id,
            before_json, after_json, checksum, run_id
          ) VALUES (
            'operator', $1, 'meal.imported', 'meal_import', 'global', NULL,
            jsonb_build_object(
              'file_name', 'operator-role.json', 'checksum', $2::text,
              'result', 'success', 'inserted_count', 1, 'updated_count', 1,
              'deleted_count', 0, 'skipped_count', 0, 'failed_count', 0
            ), $2, $3
          )
        `,
        [operatorId, checksum, runId],
      );
      await client.query("DELETE FROM meals WHERE id = $1", [meal.rows[0]!.id]);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await expectPostgresError(operatorPool.query("SELECT * FROM meal_import_logs"), "42501");
    await expectPostgresError(operatorPool.query("SELECT * FROM operator_audit_logs"), "42501");
    await expectPostgresError(
      operatorPool.query("UPDATE meal_import_logs SET result = 'failed'"),
      "42501",
    );
    await expectPostgresError(operatorPool.query("DELETE FROM operator_audit_logs"), "42501");
    await expectPostgresError(operatorPool.query("UPDATE meals SET created_at = now()"), "42501");
  });

  it("denies application, migration, attendance, worker, and future objects", async () => {
    for (const query of [
      "SELECT display_name FROM users",
      "SELECT * FROM classes",
      "SELECT * FROM attendance_notifications",
      "SELECT * FROM security_audit_logs",
      "SELECT * FROM pgmigrations",
    ]) {
      await expectPostgresError(operatorPool.query(query), "42501");
    }
    await expectPostgresError(operatorPool.query("SELECT nextval('users_id_seq')"), "42501");

    await migratorPool.query(
      "CREATE TABLE operator_future_probe (id bigint GENERATED ALWAYS AS IDENTITY)",
    );
    try {
      await expectPostgresError(operatorPool.query("SELECT * FROM operator_future_probe"), "42501");
      await expectPostgresError(
        operatorPool.query("INSERT INTO operator_future_probe DEFAULT VALUES"),
        "42501",
      );
    } finally {
      await migratorPool.query("DROP TABLE operator_future_probe");
    }
  });

  it("down leaves the login inert without deleting existing data and up restores the whitelist", async () => {
    const before = await bootstrapPool.query<{ audits: string; meals: string; operators: string }>(`
      SELECT
        (SELECT count(*)::text FROM operators) AS operators,
        (SELECT count(*)::text FROM meals) AS meals,
        (SELECT count(*)::text FROM operator_audit_logs) AS audits
    `);

    await applyOperatorMigration("down");
    try {
      await expectPostgresError(operatorPool.query("SELECT id FROM operators"), "42501");
      await expectPostgresError(operatorPool.query("SELECT id FROM meals"), "42501");
      await expectPostgresError(operatorPool.query("SELECT nextval('operators_id_seq')"), "42501");
      const after = await bootstrapPool.query<{
        audits: string;
        meals: string;
        operators: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM operators) AS operators,
          (SELECT count(*)::text FROM meals) AS meals,
          (SELECT count(*)::text FROM operator_audit_logs) AS audits
      `);
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await applyOperatorMigration("up");
    }

    expect((await operatorPool.query("SELECT id FROM operators LIMIT 1")).rowCount).toBe(1);
  });

  it("adds only the reviewed school-import and teacher-provisioning privileges", async () => {
    await applyOperatorMigration("up", 3);

    const profileInvariant = await bootstrapPool.query<{
      configuration: string[] | null;
      security_definer: boolean;
    }>(`
      SELECT prosecdef AS security_definer, proconfig AS configuration
      FROM pg_proc
      WHERE oid = 'public.enforce_profile_teacher_invariants()'::regprocedure
    `);
    expect(profileInvariant.rows[0]).toEqual({
      configuration: ["search_path=pg_catalog, public"],
      security_definer: true,
    });
    expect(
      (
        await bootstrapPool.query<{ allowed: boolean }>(`
          SELECT has_function_privilege(
            'classhub_operator',
            'public.enforce_profile_teacher_invariants()',
            'EXECUTE'
          ) AS allowed
        `)
      ).rows[0]?.allowed,
    ).toBe(false);

    expect(
      (
        await operatorPool.query(`
          SELECT edu_office_code, school_code, school_name, school_kind,
                 region_name, edu_office_name
          FROM schools
          LIMIT 1
        `)
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await operatorPool.query(`
          SELECT edu_office_code, school_code, grade
          FROM classes
          LIMIT 1
        `)
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await operatorPool.query(`
          SELECT id, email_normalized, is_active, deleted_at
          FROM users
          LIMIT 1
        `)
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await operatorPool.query(`
          SELECT user_id, status
          FROM teacher_profiles
          LIMIT 1
        `)
      ).rowCount,
    ).toBe(1);

    const client = await operatorPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO schools (
          edu_office_code, school_code, school_name, school_kind,
          region_name, edu_office_name
        ) VALUES (
          'B10', '7099999', '운영 권한 학교', 'high',
          '서울특별시', '서울특별시교육청'
        )
      `);
      await client.query(`
        UPDATE schools
        SET school_name = '수정된 운영 권한 학교',
            school_kind = 'high',
            region_name = '서울특별시',
            edu_office_name = '서울특별시교육청',
            updated_at = now()
        WHERE edu_office_code = 'B10' AND school_code = '7099999'
      `);
      const user = await client.query<{ id: string }>(`
        INSERT INTO users (
          email_normalized, display_name, password_hash, email_verified_at
        ) VALUES (
          'operator-onboarding@example.com', '운영 담임',
          'argon2-placeholder', now()
        )
        RETURNING id
      `);
      await client.query(
        `
          INSERT INTO teacher_profiles (
            user_id, temporary_password_must_change,
            temporary_password_expires_at, created_by_operator_id
          ) VALUES ($1, true, now() + interval '72 hours', $2)
        `,
        [user.rows[0]!.id, operatorId],
      );
      await client.query(
        `
          INSERT INTO school_import_logs (
            run_id, operator_id, file_name, checksum,
            inserted_count, updated_count, skipped_count, failed_count,
            result, error_json, started_at, completed_at
          ) VALUES ($1, $2, 'operator-school.json', $3, 1, 1, 0, 0,
                    'success', NULL, now(), now())
        `,
        [randomUUID(), operatorId, "b".repeat(64)],
      );
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    for (const query of [
      "SELECT created_at FROM schools",
      "SELECT id FROM classes",
      "SELECT display_name FROM users",
      "SELECT temporary_password_expires_at FROM teacher_profiles",
      "SELECT * FROM school_import_logs",
      "UPDATE users SET is_active = false",
      "UPDATE teacher_profiles SET status = 'revoked'",
      "DELETE FROM schools",
    ]) {
      await expectPostgresError(operatorPool.query(query), "42501");
    }

    await applyOperatorMigration("down");
    try {
      expect(
        (
          await operatorPool.query(`
            SELECT edu_office_code, school_code
            FROM schools
            LIMIT 1
          `)
        ).rowCount,
      ).toBe(1);
      expect((await operatorPool.query("SELECT id FROM meals LIMIT 1")).rowCount).toBe(0);
      await expectPostgresError(operatorPool.query("SELECT school_name FROM schools"), "42501");
      await expectPostgresError(operatorPool.query("SELECT id FROM users"), "42501");
      await expectPostgresError(operatorPool.query("SELECT grade FROM classes"), "42501");
      await expectPostgresError(operatorPool.query("SELECT nextval('users_id_seq')"), "42501");
    } finally {
      await applyOperatorMigration("up");
    }
  });

  // T-HUB-02에서 down이 GRANT만 회수하고 넓힌 제약을 남긴 사고가 있었다. 담임 이관
  // 감사 권한도 열었으면 되돌릴 때 그만큼 정확히 닫혀야 한다. 새 스펙 파일을 만들면
  // 컨테이너 주기가 하나 더 늘어 T-HUB-03 flake를 키우므로 이 스펙에 붙인다.
  it("opens and closes the class-audit insert grant symmetrically", async () => {
    async function grantedColumns(): Promise<string[]> {
      const result = await bootstrapPool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.column_privileges
        WHERE grantee = 'classhub_operator'
          AND table_name = 'audit_logs'
          AND privilege_type = 'INSERT'
        ORDER BY column_name
      `);
      return result.rows.map(({ column_name }) => column_name);
    }

    // 이 권한을 여는 마이그레이션 이후로 몇 개가 더 쌓였는지 세어 그만큼만 되돌린다.
    // "그게 마지막"이라고 가정하면 다음 마이그레이션이 생길 때 조용히 엉뚱한 것을
    // 되돌린다(실제로 겪었다).
    const GRANT_MIGRATION = "1783700026000_operator-class-transfer-audit";
    async function migrationsSinceGrant(): Promise<number> {
      const result = await bootstrapPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pgmigrations WHERE name >= $1",
        [GRANT_MIGRATION],
      );
      return Number(result.rows[0]!.count);
    }

    // 남은 마이그레이션을 모두 적용해 이 권한이 실제로 열리는 지점까지 간다.
    await applyOperatorMigration("up", 1_000);
    expect(await grantedColumns()).toEqual([
      "action",
      "actor_display_name_snapshot",
      "actor_role_snapshot",
      "after_json",
      "before_json",
      "class_id",
      "reason",
      "request_id",
      "target_id",
      "target_snapshot",
      "target_type",
    ]);

    const steps = await migrationsSinceGrant();
    await applyOperatorMigration("down", steps);
    expect(await grantedColumns()).toEqual([]);

    await applyOperatorMigration("up", steps);
    expect((await grantedColumns()).length).toBe(11);
  });
});
