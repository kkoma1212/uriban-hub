import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { expect } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
export const migrationsDirectory = fileURLToPath(
  new URL("../../../db/migrations", import.meta.url),
);
export const existingScheduleRequestId = "00000000-0000-4000-8000-000000006100";
export const retentionRunId = "00000000-0000-4000-8000-000000006301";

let container: StartedNativeTestService;
export let bootstrapPool: Pool;
export let migratorDatabaseUrl: string;
export let operatorId: string;
export let teacherUserId: string;
export let teacherMemberId: string;
export let studentMemberId: string;
export let outsiderMemberId: string;
export let activeClassId: string;

export function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

export async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

export async function insertAttendanceAudit(
  action: string,
  requestId: string,
  targetId: string,
  options: {
    actorMemberId?: string;
    actorRole?: "student" | "teacher";
    actorUserId?: string;
    after?: Record<string, unknown>;
    before?: Record<string, unknown>;
    reason?: string | null;
    target?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const actorUserId = options.actorUserId ?? teacherUserId;
  const actorMemberId = options.actorMemberId ?? teacherMemberId;
  const actorRole = options.actorRole ?? "teacher";
  await bootstrapPool.query(
    `
      INSERT INTO audit_logs (
        class_id, actor_user_id, actor_member_id,
        actor_display_name_snapshot, actor_role_snapshot,
        action, target_type, target_id,
        target_snapshot, before_json, after_json, reason, request_id
      ) VALUES (
        $1, $2, $3, '출결 감사', $4,
        $5, 'attendance_notification', $6,
        $7::jsonb, $8::jsonb, $9::jsonb, $10, $11
      )
    `,
    [
      activeClassId,
      actorUserId,
      actorMemberId,
      actorRole,
      action,
      targetId,
      options.target === undefined ? null : JSON.stringify(options.target),
      options.before === undefined ? null : JSON.stringify(options.before),
      options.after === undefined ? null : JSON.stringify(options.after),
      options.reason ?? null,
      requestId,
    ],
  );
}

export async function setupAttendanceMigrationTestHarness(): Promise<void> {
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
  await runner({
    count: 6,
    databaseUrl: migratorDatabaseUrl,
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });

  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (email_normalized, credential_hash)
    VALUES ('attendance-operator@example.com', decode(repeat('61', 32), 'hex'))
    RETURNING id
  `);
  operatorId = operator.rows[0]!.id;

  const teacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
    VALUES ('attendance-teacher@example.com', '출결 담임', 'argon2-placeholder', now())
    RETURNING id
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
    ) VALUES ('B10', '7060001', '출결학교', 'high', '서울특별시', '서울특별시교육청')
  `);

  const student = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
    VALUES ('attendance-student@example.com', '출결 학생', 'argon2-placeholder', now())
    RETURNING id
  `);
  const studentUserId = student.rows[0]!.id;

  const classClient = await bootstrapPool.connect();
  try {
    await classClient.query("BEGIN");
    const activeClass = await classClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('출결반', 2026, 1, 'B10', '7060001', 30, $1)
        RETURNING id
      `,
      [teacherUserId],
    );
    activeClassId = activeClass.rows[0]!.id;

    const teacherMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
        RETURNING id
      `,
      [activeClassId, teacherUserId],
    );
    teacherMemberId = teacherMember.rows[0]!.id;
    await classClient.query(
      `
        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status, actor_user_id, actor_member_id
        ) VALUES ($1, $2, NULL, 'approved', $3, $1)
      `,
      [teacherMemberId, activeClassId, teacherUserId],
    );

    const studentMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status, student_number)
        VALUES ($1, $2, 'student', 'pending', NULL)
        RETURNING id
      `,
      [activeClassId, studentUserId],
    );
    studentMemberId = studentMember.rows[0]!.id;
    await classClient.query(
      `
        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status, actor_user_id
        ) VALUES ($1, $2, NULL, 'pending', $3)
      `,
      [studentMemberId, activeClassId, studentUserId],
    );
    await classClient.query(
      `
        UPDATE class_members
        SET status = 'approved', student_number = 7,
            status_changed_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE id = $1
      `,
      [studentMemberId],
    );
    await classClient.query(
      `
        INSERT INTO class_member_status_history (
          member_id, class_id, from_status, to_status, actor_user_id,
          actor_member_id
        ) VALUES ($1, $2, 'pending', 'approved', $3, $4)
      `,
      [studentMemberId, activeClassId, teacherUserId, teacherMemberId],
    );
    await classClient.query("COMMIT");
  } catch (error) {
    await classClient.query("ROLLBACK");
    throw error;
  } finally {
    classClient.release();
  }

  const outsider = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
    VALUES ('attendance-outsider@example.com', '다른 반 학생', 'argon2-placeholder', now())
    RETURNING id
  `);
  const outsiderClass = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO classes (
        name, academic_year, grade, edu_office_code, school_code,
        expected_student_count, status, created_by_user_id,
        suspended_reason, suspended_at, suspended_by_operator_id
      ) VALUES (
        '다른 출결반', 2026, 1, 'B10', '7060001', 30, 'suspended', $1,
        '통합 테스트', now(), $2
      ) RETURNING id
    `,
    [teacherUserId, operatorId],
  );
  const outsiderMember = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO class_members (class_id, user_id, role, status)
      VALUES ($1, $2, 'student', 'pending')
      RETURNING id
    `,
    [outsiderClass.rows[0]!.id, outsider.rows[0]!.id],
  );
  outsiderMemberId = outsiderMember.rows[0]!.id;
  await bootstrapPool.query(
    `
      INSERT INTO class_member_status_history (
        member_id, class_id, from_status, to_status, actor_user_id
      ) VALUES ($1, $2, NULL, 'pending', $3)
    `,
    [outsiderMemberId, outsiderClass.rows[0]!.id, outsider.rows[0]!.id],
  );

  await bootstrapPool.query(
    `
      INSERT INTO notices (
        class_id, title, content, is_important, created_by_member_id
      ) VALUES
        ($1, '기존 중요 공지', '중요 공지 본문', true, $2),
        ($1, '기존 일반 공지', '일반 공지 본문', false, $2)
    `,
    [activeClassId, teacherMemberId],
  );
  const schedule = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO schedules (
        class_id, title, schedule_type, due_date, created_by_member_id
      ) VALUES ($1, '기존 일정', 'exam', DATE '2026-07-20', $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  await bootstrapPool.query(
    `
      INSERT INTO audit_logs (
        class_id, actor_user_id, actor_member_id,
        actor_display_name_snapshot, actor_role_snapshot,
        action, target_type, target_id, after_json, request_id
      ) VALUES (
        $1, $2, $3, '출결 담임', 'teacher',
        'schedule.created', 'schedule', $4::text,
        jsonb_build_object(
          'schedule_id', ($4::text)::bigint, 'title', '기존 일정',
          'schedule_type', 'exam', 'due_date', '2026-07-20'
        ), $5
      )
    `,
    [
      activeClassId,
      teacherUserId,
      teacherMemberId,
      schedule.rows[0]!.id,
      existingScheduleRequestId,
    ],
  );

  await runner({
    count: 1,
    databaseUrl: migratorDatabaseUrl,
    direction: "up",
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
}

export async function teardownAttendanceMigrationTestHarness(): Promise<void> {
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
}
