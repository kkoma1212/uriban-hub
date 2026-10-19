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
let studentMemberId: string;
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

async function createPoll(
  title: string,
  targetClassId = classId,
  creatorMemberId = teacherMemberId,
): Promise<{ id: string; optionIds: string[] }> {
  const poll = await appPool.query<{ id: string }>(
    `
      INSERT INTO polls (
        class_id, created_by_member_id, title, description, option_count, closes_at
      ) VALUES ($1, $2, $3, '통합 테스트 설명', 2, clock_timestamp() + interval '1 day')
      RETURNING id
    `,
    [targetClassId, creatorMemberId, title],
  );
  const options = await appPool.query<{ id: string }>(
    `
      INSERT INTO poll_options (poll_id, position, label)
      VALUES ($1, 1, '첫 번째'), ($1, 2, '두 번째')
      RETURNING id
    `,
    [poll.rows[0]!.id],
  );
  return { id: poll.rows[0]!.id, optionIds: options.rows.map(({ id }) => id) };
}

async function deletePoll(pollId: string): Promise<void> {
  await appPool.query("DELETE FROM poll_votes WHERE poll_id = $1", [pollId]);
  await appPool.query("DELETE FROM poll_options WHERE poll_id = $1", [pollId]);
  await appPool.query("DELETE FROM polls WHERE id = $1", [pollId]);
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
  await migrate("up", 17);

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
    VALUES ('poll-operator@example.com', decode(repeat('61', 32), 'hex'))
    RETURNING id
  `);
  const users = await bootstrapPool.query<{ id: string; email_normalized: string }>(`
    INSERT INTO users (email_normalized, display_name, password_hash, email_verified_at)
    VALUES
      ('poll-teacher@example.com', '투표 담임', 'argon2-placeholder', now()),
      ('poll-other-teacher@example.com', '다른 반 담임', 'argon2-placeholder', now()),
      ('poll-student@example.com', '투표 학생', 'argon2-placeholder', now()),
      ('poll-other-student@example.com', '다른 반 학생', 'argon2-placeholder', now())
    RETURNING id, email_normalized
  `);
  const userId = (email: string): string =>
    users.rows.find(({ email_normalized }) => email_normalized === email)!.id;
  const teacherUserId = userId("poll-teacher@example.com");
  const otherTeacherUserId = userId("poll-other-teacher@example.com");
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
    ) VALUES ('J10', '7530999', '투표학교', 'high', '경기도', '경기도교육청')
  `);
  const classClient = await bootstrapPool.connect();
  try {
    await classClient.query("BEGIN");
    const activeClass = await classClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('투표반', 2026, 1, 'J10', '7530999', 30, $1)
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
    const studentMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status, student_number)
        VALUES ($1, $2, 'student', 'approved', 1)
        RETURNING id
      `,
      [classId, userId("poll-student@example.com")],
    );
    studentMemberId = studentMember.rows[0]!.id;

    const otherClass = await classClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('다른반', 2026, 2, 'J10', '7530999', 30, $1)
        RETURNING id
      `,
      [otherTeacherUserId],
    );
    otherClassId = otherClass.rows[0]!.id;
    await classClient.query(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
      `,
      [otherClassId, otherTeacherUserId],
    );
    const otherStudentMember = await classClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status, student_number)
        VALUES ($1, $2, 'student', 'approved', 1)
        RETURNING id
      `,
      [otherClassId, userId("poll-other-student@example.com")],
    );
    otherStudentMemberId = otherStudentMember.rows[0]!.id;
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

describe.sequential("class polls migration", () => {
  it("allows app-owned create, single vote, read, and explicit hard delete", async () => {
    const poll = await createPoll("급훈을 골라 주세요");
    const vote = await appPool.query<{ id: string }>(
      `
        INSERT INTO poll_votes (poll_id, class_id, option_id, member_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [poll.id, classId, poll.optionIds[0], studentMemberId],
    );
    expect(vote.rows).toHaveLength(1);
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO poll_votes (poll_id, class_id, option_id, member_id)
          VALUES ($1, $2, $3, $4)
        `,
        [poll.id, classId, poll.optionIds[1], studentMemberId],
      ),
      "23505",
    );
    const result = await appPool.query<{ label: string; vote_count: string }>(
      `
        SELECT option.label, count(vote.id)::text AS vote_count
        FROM poll_options AS option
        LEFT JOIN poll_votes AS vote ON vote.option_id = option.id
        WHERE option.poll_id = $1
        GROUP BY option.id, option.label, option.position
        ORDER BY option.position
      `,
      [poll.id],
    );
    expect(result.rows).toEqual([
      { label: "첫 번째", vote_count: "1" },
      { label: "두 번째", vote_count: "0" },
    ]);
    await deletePoll(poll.id);
  });

  it("rejects cross-poll and cross-class votes plus invalid creation contracts", async () => {
    const first = await createPoll("첫 번째 투표");
    const second = await createPoll("두 번째 투표");
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO poll_votes (poll_id, class_id, option_id, member_id)
          VALUES ($1, $2, $3, $4)
        `,
        [first.id, classId, second.optionIds[0], studentMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO poll_votes (poll_id, class_id, option_id, member_id)
          VALUES ($1, $2, $3, $4)
        `,
        [first.id, classId, first.optionIds[0], otherStudentMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO polls (
            class_id, created_by_member_id, title, option_count, closes_at
          ) VALUES ($1, $2, '너무 빠른 마감', 2, clock_timestamp() + interval '4 minutes')
        `,
        [classId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO polls (
            class_id, created_by_member_id, title, option_count, closes_at
          ) VALUES ($1, $2, '옵션 수 오류', 11, clock_timestamp() + interval '1 day')
        `,
        [classId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO poll_options (poll_id, position, label)
          VALUES ($1, 3, '  첫 번째  ')
        `,
        [first.id],
      ),
      "23514",
    );
    await deletePoll(first.id);
    await deletePoll(second.id);
  });

  it("keeps exact app privileges and denies unrelated runtime roles", async () => {
    const privileges = await bootstrapPool.query<{
      app_delete: boolean;
      app_insert: boolean;
      app_select: boolean;
      app_update: boolean;
      operator_select: boolean;
      retention_select: boolean;
      worker_select: boolean;
    }>(`
      SELECT
        bool_and(has_table_privilege('classhub_app', table_name, 'SELECT')) AS app_select,
        bool_and(has_table_privilege('classhub_app', table_name, 'INSERT')) AS app_insert,
        bool_and(has_table_privilege('classhub_app', table_name, 'DELETE')) AS app_delete,
        bool_or(has_table_privilege('classhub_app', table_name, 'UPDATE')) AS app_update,
        bool_or(has_table_privilege('classhub_operator', table_name, 'SELECT'))
          AS operator_select,
        bool_or(has_table_privilege('classhub_retention', table_name, 'SELECT'))
          AS retention_select,
        bool_or(has_table_privilege('classhub_worker', table_name, 'SELECT'))
          AS worker_select
      FROM unnest(ARRAY['polls', 'poll_options', 'poll_votes']) AS table_name
    `);
    expect(privileges.rows[0]).toEqual({
      app_delete: true,
      app_insert: true,
      app_select: true,
      app_update: false,
      operator_select: false,
      retention_select: false,
      worker_select: false,
    });
    await expectPostgresError(operatorPool.query("SELECT id FROM polls LIMIT 1"), "42501");
    await expectPostgresError(retentionPool.query("SELECT id FROM poll_votes LIMIT 1"), "42501");
    await expectPostgresError(workerPool.query("SELECT id FROM poll_options LIMIT 1"), "42501");
  });

  it("allows only aggregate-safe poll audit keys", async () => {
    const poll = await createPoll("감사 로그 투표");
    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_user_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, request_id
        ) VALUES (
          $1, NULL, $2, 'teacher', '투표 담임', 'poll.created', 'poll', $3,
          jsonb_build_object(
            'poll_id', $3::text,
            'title', '감사 로그 투표',
            'closes_at', '2026-08-01T00:00:00.000Z',
            'option_count', 2,
            'vote_count', 0,
            'deleted_at', NULL
          ),
          $4
        )
      `,
      [classId, teacherMemberId, poll.id, randomUUID()],
    );
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_member_id, actor_role_snapshot,
            actor_display_name_snapshot, action, target_type, target_id,
            after_json, request_id
          ) VALUES (
            $1, $2, 'teacher', '투표 담임', 'poll.created', 'poll', $3,
            jsonb_build_object('poll_id', $3::text, 'member_id', '1'),
            $4
          )
        `,
        [classId, teacherMemberId, poll.id, randomUUID()],
      ),
      "23514",
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action LIKE 'poll.%'");
    await deletePoll(poll.id);
  });

  it("refuses destructive down with data or audit history and restores cleanly", async () => {
    const poll = await createPoll("롤백 보호 투표");
    await expect(migrate("down", 1)).rejects.toThrow(
      /class polls rollback requires polls, poll_options, and poll_votes to be empty/u,
    );
    await deletePoll(poll.id);

    await appPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_member_id, actor_role_snapshot,
          actor_display_name_snapshot, action, target_type, target_id,
          after_json, request_id
        ) VALUES (
          $1, $2, 'teacher', '투표 담임', 'poll.deleted', 'poll', '999',
          jsonb_build_object('poll_id', '999', 'vote_count', 0, 'deleted_at', now()),
          $3
        )
      `,
      [classId, teacherMemberId, randomUUID()],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /class polls rollback requires poll audit rows to be empty/u,
    );
    await bootstrapPool.query("DELETE FROM audit_logs WHERE action LIKE 'poll.%'");
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{ latest: string; table_count: string }>(`
      SELECT
        (SELECT max(name) FROM pgmigrations) AS latest,
        (
          SELECT count(*)::text
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('polls', 'poll_options', 'poll_votes')
        ) AS table_count
    `);
    expect(restored.rows[0]).toEqual({
      latest: "1783700015000_student-assessment-records",
      table_count: "0",
    });
    await migrate("up", 1);
  });

  it("adds safe poll visibility defaults, checks values, and guards lossy rollback", async () => {
    // 이 시험의 대상은 21000(poll-visibility)이지 "가장 최근 마이그레이션"이 아니다.
    // 끝까지 올리면 뒤에 새 마이그레이션이 생길 때마다 아래 down 1이 엉뚱한 것을
    // 되돌린다. beforeAll이 17까지 올려두므로 5걸음이 21000에 정확히 닿는다.
    await migrate("up", 5);
    const head = await bootstrapPool.query<{ count: string; latest: string }>(`
      SELECT count(*)::text AS count, max(name) AS latest
      FROM pgmigrations
    `);
    expect(head.rows[0]).toEqual({
      count: "22",
      latest: "1783700021000_poll-visibility-and-results-policy",
    });

    const compatible = await createPoll("기존 호환 기본 공개 정책");
    const defaults = await appPool.query<{
      ballot_visibility: string;
      results_policy: string;
    }>(`SELECT ballot_visibility, results_policy FROM polls WHERE id = $1`, [compatible.id]);
    expect(defaults.rows[0]).toEqual({
      ballot_visibility: "private",
      results_policy: "after_vote",
    });
    await expectPostgresError(
      appPool.query(
        `
          INSERT INTO polls (
            class_id, created_by_member_id, title, option_count, closes_at,
            ballot_visibility, results_policy
          ) VALUES (
            $1, $2, '잘못된 공개 정책', 2, clock_timestamp() + interval '1 day',
            'public', 'immediate'
          )
        `,
        [classId, teacherMemberId],
      ),
      "23514",
    );

    await deletePoll(compatible.id);
    const nonDefault = await appPool.query<{ id: string }>(
      `
        INSERT INTO polls (
          class_id, created_by_member_id, title, option_count, closes_at,
          ballot_visibility, results_policy
        ) VALUES (
          $1, $2, '기명 마감 후 투표', 2, clock_timestamp() + interval '1 day',
          'teacher_visible', 'after_close'
        )
        RETURNING id
      `,
      [classId, teacherMemberId],
    );
    await expect(migrate("down", 1)).rejects.toThrow(
      /poll visibility rollback requires every poll to use private and after_vote defaults/u,
    );
    await deletePoll(nonDefault.rows[0]!.id);

    const backfilled = await createPoll("롤백 후 재적용 호환 투표");
    await migrate("down", 1);
    const removedColumns = await bootstrapPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'polls'
        AND column_name IN ('ballot_visibility', 'results_policy')
    `);
    expect(removedColumns.rows[0]!.count).toBe("0");
    await migrate("up", 1);
    const restoredDefaults = await appPool.query<{
      ballot_visibility: string;
      results_policy: string;
    }>(`SELECT ballot_visibility, results_policy FROM polls WHERE id = $1`, [backfilled.id]);
    expect(restoredDefaults.rows[0]).toEqual({
      ballot_visibility: "private",
      results_policy: "after_vote",
    });
    await deletePoll(backfilled.id);
  });
});
