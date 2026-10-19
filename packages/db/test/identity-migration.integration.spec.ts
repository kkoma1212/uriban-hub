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

let container: StartedNativeTestService;
let bootstrapPool: Pool;
let migratorDatabaseUrl: string;
let operatorId: string;
let teacherUserId: string;
let teacherMemberId: string;
let activeClassId: string;
let suspendedClassId: string;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
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
  const legacyMigratorPool = new Pool({ connectionString: migratorDatabaseUrl });
  await legacyMigratorPool.query(`
    ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO classhub_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE classhub_migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO classhub_app;
  `);
  await legacyMigratorPool.end();

  // Reproduce an existing installation that accumulated the historical broad
  // defaults, then prove the fifth migration closes those privileges and the
  // sixth opens only the two teacher temporary-password state columns.
  await runner({
    count: 4,
    databaseUrl: migratorDatabaseUrl,
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
  const legacyPrivilege = await bootstrapPool.query<{ can_insert_operator: boolean }>(`
    SELECT has_table_privilege('classhub_app', 'operators', 'INSERT') AS can_insert_operator
  `);
  expect(legacyPrivilege.rows[0]?.can_insert_operator).toBe(true);

  await runner({
    count: 2,
    databaseUrl: migratorDatabaseUrl,
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });

  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (email_normalized, credential_hash)
    VALUES ('operator@example.com', decode(repeat('aa', 32), 'hex'))
    RETURNING id
  `);
  operatorId = operator.rows[0]!.id;

  const teacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'teacher@example.com', '담임 교사', 'argon2-placeholder', now()
    ) RETURNING id
  `);
  teacherUserId = teacher.rows[0]!.id;

  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        user_id, temporary_password_must_change, created_by_operator_id
      ) VALUES ($1, false, $2)
    `,
    [teacherUserId, operatorId],
  );
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, school_code, school_name, school_kind, region_name, edu_office_name
    ) VALUES ('B10', '7010123', '우리학교', 'high', '서울특별시', '서울특별시교육청')
  `);

  const client = await bootstrapPool.connect();
  try {
    await client.query("BEGIN");
    const activeClass = await client.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('1반', 2026, 1, 'B10', '7010123', 30, $1)
        RETURNING id
      `,
      [teacherUserId],
    );
    activeClassId = activeClass.rows[0]!.id;
    const teacherMember = await client.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
        RETURNING id
      `,
      [activeClassId, teacherUserId],
    );
    teacherMemberId = teacherMember.rows[0]!.id;
    await client.query(
      `
        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status, actor_user_id, actor_member_id
        ) VALUES ($1, $2, NULL, 'approved', $3, $1)
      `,
      [teacherMemberId, activeClassId, teacherUserId],
    );
    await client.query(
      `
        INSERT INTO class_invite_codes (
          class_id, code, expires_at, created_by_member_id
        ) VALUES ($1, 'ABCDEFG2', now() + interval '14 days', $2)
      `,
      [activeClassId, teacherMemberId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const suspendedClass = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO classes (
        name, academic_year, grade, edu_office_code, school_code,
        expected_student_count, status, created_by_user_id,
        suspended_reason, suspended_at, suspended_by_operator_id
      ) VALUES (
        '중지반', 2026, 1, 'B10', '7010123', 30, 'suspended', $1,
        '통합 테스트', now(), $2
      ) RETURNING id
    `,
    [teacherUserId, operatorId],
  );
  suspendedClassId = suspendedClass.rows[0]!.id;
});

afterAll(async () => {
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
});

describe("identity foundation migration", () => {
  it("creates the PRD identity tables through the migrator role", async () => {
    const result = await bootstrapPool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'operators',
          'teacher_profiles',
          'schools',
          'classes',
          'class_members',
          'class_member_status_history',
          'class_invite_codes',
          'operator_audit_logs',
          'school_import_logs',
          'meal_import_logs',
          'audit_logs',
          'security_audit_logs',
          'notices',
          'notice_reads',
          'supplies',
          'supply_checks',
          'schedules',
          'meals',
          'users',
          'user_consents',
          'email_verification_tokens',
          'password_reset_tokens',
          'sessions',
          'api_idempotency_keys'
        )
      ORDER BY tablename
    `);

    expect(result.rows.map((row) => row.tablename)).toEqual([
      "api_idempotency_keys",
      "audit_logs",
      "class_invite_codes",
      "class_member_status_history",
      "class_members",
      "classes",
      "email_verification_tokens",
      "meal_import_logs",
      "meals",
      "notice_reads",
      "notices",
      "operator_audit_logs",
      "operators",
      "password_reset_tokens",
      "schedules",
      "school_import_logs",
      "schools",
      "security_audit_logs",
      "sessions",
      "supplies",
      "supply_checks",
      "teacher_profiles",
      "user_consents",
      "users",
    ]);
  });

  it("commits an active class only with one active approved teacher", async () => {
    const result = await bootstrapPool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM class_members
        WHERE class_id = $1 AND role = 'teacher' AND status = 'approved'
      `,
      [activeClassId],
    );
    expect(result.rows[0]?.count).toBe("1");

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO classes (
            name, academic_year, grade, edu_office_code, school_code,
            expected_student_count, created_by_user_id
          ) VALUES ('교사없는반', 2026, 1, 'B10', '7010123', 30, $1)
        `,
        [teacherUserId],
      ),
      "P0001",
    );
  });

  it("prevents one user from holding two current memberships", async () => {
    const student = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
      VALUES ('current@example.com', '현재 학생', 'argon2-placeholder', now())
      RETURNING id
    `);
    const studentId = student.rows[0]!.id;
    await bootstrapPool.query(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'student', 'pending')
      `,
      [suspendedClassId, studentId],
    );

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO class_members (class_id, user_id, role, status)
          VALUES ($1, $2, 'student', 'approved')
        `,
        [activeClassId, studentId],
      ),
      "23505",
    );
  });

  it("rejects an invalid initial student status history", async () => {
    const student = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
      VALUES ('history@example.com', '이력 학생', 'argon2-placeholder', now())
      RETURNING id
    `);
    const member = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'student', 'pending')
        RETURNING id
      `,
      [suspendedClassId, student.rows[0]!.id],
    );

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO class_member_status_history (
            member_id, class_id, from_status, to_status, actor_user_id
          ) VALUES ($1, $2, NULL, 'approved', $3)
        `,
        [member.rows[0]!.id, suspendedClassId, student.rows[0]!.id],
      ),
      "P0001",
    );
  });

  it("enforces content class boundaries, check state, and meal school references", async () => {
    const notice = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO notices (class_id, title, content, created_by_member_id)
        VALUES ($1, '중요 안내', '공지 본문', $2)
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    expect(notice.rowCount).toBe(1);

    const outsider = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
      VALUES ('outsider@example.com', '외부 학생', 'argon2-placeholder', now())
      RETURNING id
    `);
    const outsiderMember = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'student', 'pending')
        RETURNING id
      `,
      [suspendedClassId, outsider.rows[0]!.id],
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO notices (class_id, title, content, created_by_member_id)
          VALUES ($1, '위조 공지', '다른 반 actor', $2)
        `,
        [activeClassId, outsiderMember.rows[0]!.id],
      ),
      "23503",
    );

    const supply = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO supplies (class_id, title, needed_on, created_by_member_id)
        VALUES ($1, '체육복', CURRENT_DATE, $2)
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO supply_checks (
            class_id, supply_id, member_id, is_checked, checked_at, confirmed_revision
          ) VALUES ($1, $2, $3, true, NULL, 1)
        `,
        [activeClassId, supply.rows[0]!.id, teacherMemberId],
      ),
      "23514",
    );

    await expectPostgresError(
      bootstrapPool.query(`
        INSERT INTO meals (
          edu_office_code, school_code, meal_date, meal_type,
          menu_json, source_updated_at
        ) VALUES (
          'B10', '7999999', CURRENT_DATE, 'lunch',
          '[{"name":"급식","allergens":[]}]'::jsonb, now()
        )
      `),
      "23503",
    );
  });

  it("enforces audit action, JSON allowlist, actor class, and immutability grants", async () => {
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_user_id, actor_member_id,
            actor_display_name_snapshot, actor_role_snapshot,
            action, target_type, target_id, after_json, request_id
          ) VALUES (
            $1, $2, $3, '담임 교사', 'teacher',
            'notice.created', 'notice', '1',
            '{"notice_id":1,"content":"금지 본문"}'::jsonb,
            '00000000-0000-4000-8000-000000000001'
          )
        `,
        [activeClassId, teacherUserId, teacherMemberId],
      ),
      "23514",
    );

    const outsider = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
      VALUES ('audit-outsider@example.com', '감사 외부인', 'argon2-placeholder', now())
      RETURNING id
    `);
    const outsiderMember = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'student', 'pending')
        RETURNING id
      `,
      [suspendedClassId, outsider.rows[0]!.id],
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_user_id, actor_member_id,
            actor_display_name_snapshot, actor_role_snapshot,
            action, target_type, target_id, after_json, request_id
          ) VALUES (
            $1, $2, $3, '감사 외부인', 'student',
            'member.requested', 'member', '2',
            '{"member_id":2,"role":"student","status":"pending"}'::jsonb,
            '00000000-0000-4000-8000-000000000002'
          )
        `,
        [activeClassId, outsider.rows[0]!.id, outsiderMember.rows[0]!.id],
      ),
      "P0001",
    );

    const privileges = await bootstrapPool.query<{
      can_delete: boolean;
      can_insert: boolean;
      can_update: boolean;
    }>(`
      SELECT
        has_table_privilege('classhub_app', 'audit_logs', 'INSERT') AS can_insert,
        has_table_privilege('classhub_app', 'audit_logs', 'UPDATE') AS can_update,
        has_table_privilege('classhub_app', 'audit_logs', 'DELETE') AS can_delete
    `);
    expect(privileges.rows[0]).toEqual({
      can_delete: false,
      can_insert: true,
      can_update: false,
    });
  });

  it("keeps the app role non-DDL while granting required table access", async () => {
    const appPool = new Pool({
      connectionString: databaseUrl("classhub_app", "local_app_password"),
    });

    try {
      const result = await appPool.query<{ current_user: string }>("SELECT current_user");
      expect(result.rows[0]?.current_user).toBe("classhub_app");
      await expectPostgresError(
        appPool.query("CREATE TABLE forbidden_by_app (id bigint)"),
        "42501",
      );

      const inserted = await appPool.query<{ id: string }>(`
        INSERT INTO users (email_normalized, display_name, password_hash)
        VALUES ('app-privilege-probe@example.com', '권한 확인', 'argon2-placeholder')
        RETURNING id
      `);
      await expectPostgresError(
        appPool.query("DELETE FROM users WHERE id = $1", [inserted.rows[0]!.id]),
        "42501",
      );
      await expectPostgresError(
        appPool.query(`
          INSERT INTO operators (email_normalized, credential_hash)
          VALUES ('forbidden-operator@example.com', decode(repeat('bb', 32), 'hex'))
        `),
        "42501",
      );
      await expectPostgresError(
        appPool.query(
          `
          INSERT INTO teacher_profiles (
            user_id, temporary_password_must_change, created_by_operator_id
          ) VALUES ($1, false, $2)
        `,
          [inserted.rows[0]!.id, operatorId],
        ),
        "42501",
      );

      await appPool.query(
        `UPDATE teacher_profiles
         SET temporary_password_must_change = false,
             temporary_password_expires_at = NULL
         WHERE user_id = $1`,
        [teacherUserId],
      );
      await expectPostgresError(
        appPool.query("UPDATE teacher_profiles SET status = 'revoked' WHERE user_id = $1", [
          teacherUserId,
        ]),
        "42501",
      );

      await appPool.query(`
        SELECT school_kind
        FROM schools
        WHERE edu_office_code = 'B10' AND school_code = '7010123'
        FOR UPDATE
      `);
      await expectPostgresError(
        appPool.query(`
          UPDATE schools
          SET school_name = 'forbidden'
          WHERE edu_office_code = 'B10' AND school_code = '7010123'
        `),
        "42501",
      );
    } finally {
      await appPool.end();
    }
  });

  it("applies the runtime table and sequence privilege whitelist", async () => {
    const forbiddenTables = [
      "meal_import_logs",
      "operator_audit_logs",
      "operators",
      "school_import_logs",
      "security_audit_logs",
    ];
    for (const table of forbiddenTables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const result = await bootstrapPool.query<{ granted: boolean }>(
          "SELECT has_table_privilege('classhub_app', $1, $2) AS granted",
          [table, privilege],
        );
        expect(result.rows[0]?.granted, `${table} ${privilege}`).toBe(false);
      }
    }

    for (const table of ["meals", "schools", "teacher_profiles"]) {
      const result = await bootstrapPool.query<{
        can_delete: boolean;
        can_insert: boolean;
        can_select: boolean;
        can_update: boolean;
      }>(
        `SELECT
           has_table_privilege('classhub_app', $1, 'SELECT') AS can_select,
           has_table_privilege('classhub_app', $1, 'INSERT') AS can_insert,
           has_table_privilege('classhub_app', $1, 'UPDATE') AS can_update,
           has_table_privilege('classhub_app', $1, 'DELETE') AS can_delete`,
        [table],
      );
      expect(result.rows[0], table).toEqual({
        can_delete: false,
        can_insert: false,
        can_select: true,
        can_update: false,
      });
    }

    const schoolColumns = await bootstrapPool.query<{
      can_update_kind: boolean;
      can_update_name: boolean;
      can_update_timestamp: boolean;
    }>(`
      SELECT
        has_column_privilege('classhub_app', 'schools', 'school_kind', 'UPDATE') AS can_update_kind,
        has_column_privilege('classhub_app', 'schools', 'school_name', 'UPDATE') AS can_update_name,
        has_column_privilege('classhub_app', 'schools', 'updated_at', 'UPDATE') AS can_update_timestamp
    `);
    expect(schoolColumns.rows[0]).toEqual({
      can_update_kind: false,
      can_update_name: false,
      can_update_timestamp: true,
    });

    const teacherProfileColumns = await bootstrapPool.query<{
      can_update_expires_at: boolean;
      can_update_must_change: boolean;
      can_update_status: boolean;
    }>(`
      SELECT
        has_column_privilege(
          'classhub_app', 'teacher_profiles', 'temporary_password_expires_at', 'UPDATE'
        ) AS can_update_expires_at,
        has_column_privilege(
          'classhub_app', 'teacher_profiles', 'temporary_password_must_change', 'UPDATE'
        ) AS can_update_must_change,
        has_column_privilege(
          'classhub_app', 'teacher_profiles', 'status', 'UPDATE'
        ) AS can_update_status
    `);
    expect(teacherProfileColumns.rows[0]).toEqual({
      can_update_expires_at: true,
      can_update_must_change: true,
      can_update_status: false,
    });

    const sequences = await bootstrapPool.query<{
      app_audit: boolean;
      app_pgmigrations: boolean;
      app_security: boolean;
      worker_security: boolean;
    }>(`
      SELECT
        has_sequence_privilege('classhub_app', 'audit_logs_id_seq', 'USAGE') AS app_audit,
        has_sequence_privilege('classhub_app', 'pgmigrations_id_seq', 'USAGE') AS app_pgmigrations,
        has_sequence_privilege('classhub_app', 'security_audit_logs_id_seq', 'USAGE') AS app_security,
        has_sequence_privilege('classhub_worker', 'security_audit_logs_id_seq', 'USAGE') AS worker_security
    `);
    expect(sequences.rows[0]).toEqual({
      app_audit: true,
      app_pgmigrations: false,
      app_security: false,
      worker_security: true,
    });

    const localAdmin = await bootstrapPool.query<{
      can_delete_user: boolean;
      can_read_operator_hash: boolean;
      can_read_operator_id: boolean;
    }>(`
      SELECT
        has_table_privilege('classhub_local_admin', 'users', 'DELETE') AS can_delete_user,
        has_column_privilege('classhub_local_admin', 'operators', 'id', 'SELECT') AS can_read_operator_id,
        has_column_privilege('classhub_local_admin', 'operators', 'credential_hash', 'SELECT') AS can_read_operator_hash
    `);
    expect(localAdmin.rows[0]).toEqual({
      can_delete_user: true,
      can_read_operator_hash: false,
      can_read_operator_id: true,
    });
  });

  it("lets the dedicated local-admin role manage only disposable test accounts", async () => {
    const localAdminPool = new Pool({
      connectionString: databaseUrl("classhub_local_admin", "local_admin_db_password"),
    });

    try {
      const identity = await localAdminPool.query<{ current_user: string }>("SELECT current_user");
      expect(identity.rows[0]?.current_user).toBe("classhub_local_admin");

      const inserted = await localAdminPool.query<{ id: string }>(`
        INSERT INTO users (email_normalized, display_name, password_hash)
        VALUES ('local-admin-privilege-probe@example.com', 'Test account', 'argon2-placeholder')
        RETURNING id
      `);
      const userId = inserted.rows[0]!.id;
      await localAdminPool.query(
        `INSERT INTO user_consents (
           user_id, consent_type, policy_version, accepted_at, ip_address
         ) VALUES ($1, 'terms', 'test-v1', now(), '127.0.0.1')`,
        [userId],
      );

      await expectPostgresError(
        localAdminPool.query("UPDATE users SET display_name = 'Forbidden' WHERE id = $1", [userId]),
        "42501",
      );
      await expectPostgresError(
        localAdminPool.query("SELECT credential_hash FROM operators LIMIT 1"),
        "42501",
      );
      await expectPostgresError(localAdminPool.query("SELECT * FROM pgmigrations"), "42501");

      const deleted = await localAdminPool.query("DELETE FROM users WHERE id = $1 RETURNING id", [
        userId,
      ]);
      expect(deleted.rowCount).toBe(1);
    } finally {
      await localAdminPool.end();
    }
  });

  it("keeps future migrator-owned objects inaccessible by default", async () => {
    const migratorPool = new Pool({ connectionString: migratorDatabaseUrl });
    try {
      await migratorPool.query("CREATE TABLE runtime_privilege_probe (id bigint)");
      await migratorPool.query("CREATE SEQUENCE runtime_privilege_probe_seq");

      const result = await bootstrapPool.query<{
        can_select_table: boolean;
        can_use_sequence: boolean;
      }>(`
        SELECT
          has_table_privilege('classhub_app', 'runtime_privilege_probe', 'SELECT') AS can_select_table,
          has_sequence_privilege('classhub_app', 'runtime_privilege_probe_seq', 'USAGE') AS can_use_sequence
      `);
      expect(result.rows[0]).toEqual({ can_select_table: false, can_use_sequence: false });
    } finally {
      await migratorPool.query("DROP TABLE IF EXISTS runtime_privilege_probe");
      await migratorPool.query("DROP SEQUENCE IF EXISTS runtime_privilege_probe_seq");
      await migratorPool.end();
    }
  });

  it("enforces active email uniqueness while allowing reuse after deletion", async () => {
    const first = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash)
      VALUES ('student@example.com', '학생 하나', 'argon2-placeholder')
      RETURNING id
    `);

    await expectPostgresError(
      bootstrapPool.query(`
        INSERT INTO users (email_normalized, display_name, password_hash)
        VALUES ('student@example.com', '학생 둘', 'argon2-placeholder')
      `),
      "23505",
    );

    await bootstrapPool.query(
      `UPDATE users SET is_active = false, deleted_at = now(), anonymized_at = now() WHERE id = $1`,
      [first.rows[0]?.id],
    );

    const replacement = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash)
      VALUES ('student@example.com', '학생 둘', 'argon2-placeholder')
      RETURNING id
    `);
    expect(replacement.rowCount).toBe(1);
  });

  it("allows one open verification token and rejects an impossible terminal state", async () => {
    const user = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash)
      VALUES ('token@example.com', '토큰 학생', 'argon2-placeholder')
      RETURNING id
    `);
    const userId = user.rows[0]?.id;

    await bootstrapPool.query(
      `
        INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
        VALUES ($1, decode(repeat('01', 32), 'hex'), now() + interval '24 hours')
      `,
      [userId],
    );

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
          VALUES ($1, decode(repeat('02', 32), 'hex'), now() + interval '24 hours')
        `,
        [userId],
      ),
      "23505",
    );

    await bootstrapPool.query(
      `UPDATE email_verification_tokens SET invalidated_at = now() WHERE user_id = $1`,
      [userId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
        VALUES ($1, decode(repeat('02', 32), 'hex'), now() + interval '24 hours')
      `,
      [userId],
    );

    await expectPostgresError(
      bootstrapPool.query(
        `
          UPDATE email_verification_tokens
          SET used_at = now(), invalidated_at = now()
          WHERE user_id = $1 AND invalidated_at IS NULL
        `,
        [userId],
      ),
      "23514",
    );
  });

  it("enforces the two valid consent retention states", async () => {
    const user = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO users (email_normalized, display_name, password_hash)
      VALUES ('consent@example.com', '동의 학생', 'argon2-placeholder')
      RETURNING id
    `);
    const userId = user.rows[0]?.id;

    await bootstrapPool.query(
      `
        INSERT INTO user_consents (
          user_id, consent_type, policy_version, accepted_at, ip_address
        ) VALUES ($1, 'terms', 'v1', now(), '127.0.0.1')
      `,
      [userId],
    );

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO user_consents (
            user_id, consent_type, policy_version, accepted_at, withdrawn_at, ip_address
          ) VALUES ($1, 'privacy', 'v1', now(), now(), '127.0.0.1')
        `,
        [userId],
      ),
      "23514",
    );
  });

  it("can roll the migration back in the disposable test database", async () => {
    for (let migration = 0; migration < 6; migration += 1) {
      await runner({
        count: 1,
        databaseUrl: migratorDatabaseUrl,
        direction: "down",
        dir: migrationsDirectory,
        migrationsTable: "pgmigrations",
        verbose: false,
      });
    }

    const result = await bootstrapPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'users'
    `);
    expect(result.rows[0]?.count).toBe("0");
  });
});
