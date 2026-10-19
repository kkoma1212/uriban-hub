import { randomUUID } from "node:crypto";
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
let classId: string;
let otherClassId: string;
let teacherMemberId: string;
let otherTeacherMemberId: string;
let studentMemberId: string;
let secondStudentMemberId: string;
let otherStudentMemberId: string;

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

interface CreatedDraw {
  groupIds: string[];
  id: string;
}

async function createDraw(
  title: string,
  targetClassId = classId,
  creatorMemberId = teacherMemberId,
  assignedMemberIds = [studentMemberId, secondStudentMemberId],
): Promise<CreatedDraw> {
  const draw = await appPool.query<{ id: string }>(
    `
      INSERT INTO team_draws (
        class_id, created_by_member_id, title, group_count,
        initial_assigned_count, excluded_student_count
      ) VALUES ($1, $2, $3, 2, $4, 0)
      RETURNING id
    `,
    [targetClassId, creatorMemberId, title, assignedMemberIds.length],
  );
  const drawId = draw.rows[0]!.id;
  const groups = await appPool.query<{ group_index: number; id: string }>(
    `
      INSERT INTO team_draw_groups (team_draw_id, class_id, group_index)
      VALUES ($1, $2, 1), ($1, $2, 2)
      RETURNING id, group_index
    `,
    [drawId, targetClassId],
  );
  for (const [index, memberId] of assignedMemberIds.entries()) {
    await appPool.query(
      `
        INSERT INTO team_draw_assignments (
          team_draw_id, class_id, team_group_id, member_id,
          display_name_snapshot, student_number_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [drawId, targetClassId, groups.rows[index]!.id, memberId, `학생 ${index + 1}`, index + 1],
    );
  }
  return { groupIds: groups.rows.map(({ id }) => id), id: drawId };
}

async function deleteDraw(drawId: string): Promise<void> {
  await appPool.query("DELETE FROM team_draw_assignments WHERE team_draw_id = $1", [drawId]);
  await appPool.query("DELETE FROM team_draw_groups WHERE team_draw_id = $1", [drawId]);
  await appPool.query("DELETE FROM team_draws WHERE id = $1", [drawId]);
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
  await migrate("up", 19);

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

  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (email_normalized, credential_hash)
    VALUES ('team-operator@example.com', decode(repeat('61', 32), 'hex'))
    RETURNING id
  `);
  const users = await bootstrapPool.query<{ email_normalized: string; id: string }>(`
    INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
    VALUES
      ('team-teacher@example.com', '모둠 담임', 'argon2-placeholder', now()),
      ('team-other-teacher@example.com', '다른 모둠 담임', 'argon2-placeholder', now()),
      ('team-student@example.com', '모둠 학생', 'argon2-placeholder', now()),
      ('team-second-student@example.com', '두 번째 학생', 'argon2-placeholder', now()),
      ('team-other-student@example.com', '다른 반 학생', 'argon2-placeholder', now())
    RETURNING id, email_normalized
  `);
  const userId = (email: string): string =>
    users.rows.find(({ email_normalized }) => email_normalized === email)!.id;
  const teacherUserId = userId("team-teacher@example.com");
  const otherTeacherUserId = userId("team-other-teacher@example.com");
  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        user_id, temporary_password_must_change, created_by_operator_id
      ) VALUES ($1, false, $3), ($2, false, $3)
    `,
    [teacherUserId, otherTeacherUserId, operator.rows[0]!.id],
  );
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, school_code, school_name, school_kind, region_name, edu_office_name
    ) VALUES ('J10', '7530998', '모둠학교', 'high', '경기도', '경기도교육청')
  `);

  const classClient = await bootstrapPool.connect();
  try {
    await classClient.query("BEGIN");
    const activeClass = await classClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('모둠반', 2026, 1, 'J10', '7530998', 30, $1)
        RETURNING id
      `,
      [teacherUserId],
    );
    classId = activeClass.rows[0]!.id;
    const teacherMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
        RETURNING id
      `,
      [classId, teacherUserId],
    );
    teacherMemberId = teacherMember.rows[0]!.id;
    const students = await classClient.query<{ id: string; student_number: number }>(
      `
        INSERT INTO class_members (
          class_id, user_id, role, status, student_number
        ) VALUES
          ($1, $2, 'student', 'approved', 1),
          ($1, $3, 'student', 'approved', 2)
        RETURNING id, student_number
      `,
      [classId, userId("team-student@example.com"), userId("team-second-student@example.com")],
    );
    studentMemberId = students.rows.find(({ student_number }) => student_number === 1)!.id;
    secondStudentMemberId = students.rows.find(({ student_number }) => student_number === 2)!.id;

    const otherClass = await classClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('다른 모둠반', 2026, 2, 'J10', '7530998', 30, $1)
        RETURNING id
      `,
      [otherTeacherUserId],
    );
    otherClassId = otherClass.rows[0]!.id;
    const otherTeacherMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
        RETURNING id
      `,
      [otherClassId, otherTeacherUserId],
    );
    otherTeacherMemberId = otherTeacherMember.rows[0]!.id;
    const otherStudent = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status, student_number)
        VALUES ($1, $2, 'student', 'approved', 1)
        RETURNING id
      `,
      [otherClassId, userId("team-other-student@example.com")],
    );
    otherStudentMemberId = otherStudent.rows[0]!.id;
    await classClient.query("COMMIT");
  } catch (error) {
    await classClient.query("ROLLBACK");
    throw error;
  } finally {
    classClient.release();
  }
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

describe.sequential("team draws migration", () => {
  it("stores exact groups and assignments with one current publication", async () => {
    const first = await createDraw("8월 모둠 배치");
    const stored = await appPool.query<{
      assignment_count: string;
      group_count: string;
    }>(
      `
        SELECT
          (SELECT count(*)::text FROM team_draw_groups WHERE team_draw_id = $1)
            AS group_count,
          (SELECT count(*)::text FROM team_draw_assignments WHERE team_draw_id = $1)
            AS assignment_count
      `,
      [first.id],
    );
    expect(stored.rows[0]).toEqual({ assignment_count: "2", group_count: "2" });
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO team_draw_assignments (
            team_draw_id, class_id, team_group_id, member_id,
            display_name_snapshot, student_number_snapshot
          ) VALUES ($1, $2, $3, $4, '모둠 학생', 1)
        `,
        [first.id, classId, first.groupIds[1], studentMemberId],
      ),
      "23505",
    );
    await appPool.query(
      `
        UPDATE team_draws
        SET status = 'published', published_at = clock_timestamp(), row_version = row_version + 1
        WHERE id = $1
      `,
      [first.id],
    );

    const second = await createDraw("9월 모둠 배치");
    await expectPostgresError(
      appPool.query(
        `
          UPDATE team_draws
          SET status = 'published', published_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1
        `,
        [second.id],
      ),
      "23505",
    );
    const publishClient = await appPool.connect();
    try {
      await publishClient.query("BEGIN");
      await publishClient.query(
        `
          UPDATE team_draws
          SET status = 'superseded', superseded_at = clock_timestamp(),
              row_version = row_version + 1
          WHERE id = $1
        `,
        [first.id],
      );
      await publishClient.query(
        `
          UPDATE team_draws
          SET status = 'published', published_at = clock_timestamp(),
              row_version = row_version + 1
          WHERE id = $1
        `,
        [second.id],
      );
      await publishClient.query("COMMIT");
    } catch (error) {
      await publishClient.query("ROLLBACK");
      throw error;
    } finally {
      publishClient.release();
    }
    const statuses = await appPool.query<{ status: string }>(
      "SELECT status FROM team_draws WHERE id IN ($1, $2) ORDER BY id",
      [first.id, second.id],
    );
    expect(statuses.rows.map(({ status }) => status)).toEqual(["superseded", "published"]);
    await deleteDraw(first.id);
    await deleteDraw(second.id);
  });

  it("rejects out-of-range groups and cross-class relationships", async () => {
    const draw = await createDraw("제약 검증 모둠");
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO team_draw_groups (team_draw_id, class_id, group_index)
          VALUES ($1, $2, 3)
        `,
        [draw.id, classId],
      ),
      "23514",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO team_draw_assignments (
            team_draw_id, class_id, team_group_id, member_id,
            display_name_snapshot, student_number_snapshot
          ) VALUES ($1, $2, $3, $4, '다른 반 학생', 1)
        `,
        [draw.id, classId, draw.groupIds[0], otherStudentMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO team_draws (
            class_id, created_by_member_id, title, group_count,
            initial_assigned_count, excluded_student_count
          ) VALUES ($1, $2, '다른 반 교사', 2, 2, 0)
        `,
        [classId, otherTeacherMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO team_draw_groups (team_draw_id, class_id, group_index)
          VALUES ($1, $2, 1)
        `,
        [draw.id, otherClassId],
      ),
      "23503",
    );
    await deleteDraw(draw.id);
  });

  it("keeps exact app privileges and denies unrelated runtime roles", async () => {
    const privileges = await bootstrapPool.query<{
      delete_privilege: boolean;
      insert_privilege: boolean;
      select_privilege: boolean;
      table_name: string;
      update_privilege: boolean;
    }>(`
      SELECT
        table_name,
        has_table_privilege('classhub_app', table_name, 'SELECT') AS select_privilege,
        has_table_privilege('classhub_app', table_name, 'INSERT') AS insert_privilege,
        has_table_privilege('classhub_app', table_name, 'UPDATE') AS update_privilege,
        has_table_privilege('classhub_app', table_name, 'DELETE') AS delete_privilege
      FROM unnest(
        ARRAY['team_draw_assignments', 'team_draw_groups', 'team_draws']
      ) AS table_name
      ORDER BY table_name
    `);
    expect(privileges.rows).toEqual([
      {
        delete_privilege: true,
        insert_privilege: true,
        select_privilege: true,
        table_name: "team_draw_assignments",
        update_privilege: false,
      },
      {
        delete_privilege: true,
        insert_privilege: true,
        select_privilege: true,
        table_name: "team_draw_groups",
        update_privilege: false,
      },
      {
        delete_privilege: true,
        insert_privilege: true,
        select_privilege: true,
        table_name: "team_draws",
        update_privilege: true,
      },
    ]);
    await expectPostgresError(operatorPool.query("SELECT id FROM team_draws LIMIT 1"), "42501");
    await expectPostgresError(
      retentionPool.query("SELECT id FROM team_draw_assignments LIMIT 1"),
      "42501",
    );
    await expectPostgresError(workerPool.query("SELECT id FROM team_draw_groups LIMIT 1"), "42501");
  });

  it("allows aggregate-safe audit keys and rejects member identities", async () => {
    const draw = await createDraw("감사 로그 모둠");
    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, request_id
        ) VALUES (
          $1, $2, 'teacher', '모둠 담임', 'team_draw.created', 'team_draw', $3,
          jsonb_build_object(
            'team_draw_id', $3::text,
            'title', '감사 로그 모둠',
            'group_count', 2,
            'assigned_student_count', 2,
            'excluded_student_count', 0,
            'status', 'draft',
            'published_at', NULL,
            'superseded_at', NULL,
            'deleted_at', NULL
          ),
          $4
        )
      `,
      [classId, teacherMemberId, draw.id, randomUUID()],
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_member_id, actor_role_snapshot,
            actor_display_name_snapshot, action, target_type, target_id,
            after_json, request_id
          ) VALUES (
            $1, $2, 'teacher', '모둠 담임', 'team_draw.created', 'team_draw', $3,
            jsonb_build_object('team_draw_id', $3::text, 'member_id', '1'),
            $4
          )
        `,
        [classId, teacherMemberId, draw.id, randomUUID()],
      ),
      "23514",
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action LIKE 'team_draw.%'");
    await deleteDraw(draw.id);
  });

  it("refuses destructive down with data or audit history and restores cleanly", async () => {
    const draw = await createDraw("롤백 보호 모둠");
    await expect(migrate("down", 1)).rejects.toThrow(
      /team draws rollback requires team_draws, team_draw_groups, and team_draw_assignments to be empty/u,
    );
    await deleteDraw(draw.id);

    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, request_id
        ) VALUES (
          $1, $2, 'teacher', '모둠 담임', 'team_draw.deleted', 'team_draw', '999',
          jsonb_build_object(
            'team_draw_id', '999',
            'assigned_student_count', 0,
            'status', 'draft',
            'deleted_at', now()
          ),
          $3
        )
      `,
      [classId, teacherMemberId, randomUUID()],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /team draws rollback requires team draw audit rows to be empty/u,
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action LIKE 'team_draw.%'");
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{ latest: string; table_count: string }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        (
          SELECT count(*)::text
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'team_draws', 'team_draw_groups', 'team_draw_assignments'
            )
        ) AS table_count
    `);
    expect(restored.rows[0]).toEqual({
      latest: "1783700017000_seat-draws",
      table_count: "0",
    });
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_member_id, actor_role_snapshot,
            actor_display_name_snapshot, action, target_type, target_id,
            request_id
          ) VALUES (
            $1, $2, 'teacher', '모둠 담임',
            'team_draw.deleted', 'team_draw', '999', $3
          )
        `,
        [classId, teacherMemberId, randomUUID()],
      ),
      "23514",
    );
    await migrate("up", 1);
  });

  it("adds seat adjustment audit action and refuses rollback while its history remains", async () => {
    await migrate("up", 1);
    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, reason, request_id
        ) VALUES (
          $1, $2, 'teacher', '모둠 담임',
          'seat_draw.adjusted', 'seat_draw', '999',
          jsonb_build_object(
            'seat_draw_id', '999',
            'assigned_student_count', 2,
            'status', 'draft',
            'deleted_at', NULL
          ),
          'teacher_swap_assignments', $3
        )
      `,
      [classId, teacherMemberId, randomUUID()],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /seat draw adjustment audit rollback requires adjusted audit rows to be empty/u,
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action = 'seat_draw.adjusted'");
    await migrate("down", 1);
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_member_id, actor_role_snapshot,
            actor_display_name_snapshot, action, target_type, target_id,
            request_id
          ) VALUES (
            $1, $2, 'teacher', '모둠 담임',
            'seat_draw.adjusted', 'seat_draw', '999', $3
          )
        `,
        [classId, teacherMemberId, randomUUID()],
      ),
      "23514",
    );
    await migrate("up", 1);
  });

  it("adds team adjustment audit action and refuses rollback while its history remains", async () => {
    await migrate("up", 1);
    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, reason, request_id
        ) VALUES (
          $1, $2, 'teacher', '모둠 담임',
          'team_draw.adjusted', 'team_draw', '999',
          jsonb_build_object(
            'team_draw_id', '999',
            'group_count', 2,
            'assigned_student_count', 2,
            'excluded_student_count', 0,
            'status', 'draft',
            'published_at', NULL,
            'superseded_at', NULL,
            'deleted_at', NULL
          ),
          'teacher_swap_assignments', $3
        )
      `,
      [classId, teacherMemberId, randomUUID()],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /team draw adjustment audit rollback requires adjusted audit rows to be empty/u,
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action = 'team_draw.adjusted'");
    await migrate("down", 1);
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_member_id, actor_role_snapshot,
            actor_display_name_snapshot, action, target_type, target_id,
            request_id
          ) VALUES (
            $1, $2, 'teacher', '모둠 담임',
            'team_draw.adjusted', 'team_draw', '999', $3
          )
        `,
        [classId, teacherMemberId, randomUUID()],
      ),
      "23514",
    );
    await migrate("up", 1);
  });
});
