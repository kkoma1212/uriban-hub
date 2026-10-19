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

let activeClassId: string;
let appPool: Pool;
let bootstrapPool: Pool;
let container: StartedNativeTestService;
let legacyNoticeId: string;
let legacySupplyId: string;
let migratorDatabaseUrl: string;
let outsiderMemberId: string;
let selectedNoticeId: string;
let selectedSupplyId: string;
let studentMemberId: string;
let teacherMemberId: string;
let teacherUserId: string;

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

async function seedV9Fixture(): Promise<void> {
  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (email_normalized, credential_hash)
    VALUES ('audience-operator@example.com', decode(repeat('91', 32), 'hex'))
    RETURNING id
  `);
  const teacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'audience-teacher@example.com', '대상 담임',
      'argon2-placeholder', now()
    )
    RETURNING id
  `);
  teacherUserId = teacher.rows[0]!.id;
  const students = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES
      ('audience-student@example.com', '대상 학생', 'argon2-placeholder', now()),
      ('audience-outsider@example.com', '다른 반 학생', 'argon2-placeholder', now()),
      ('audience-outsider-teacher@example.com', '다른 반 담임', 'argon2-placeholder', now())
    RETURNING id
  `);
  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        user_id, temporary_password_must_change, created_by_operator_id
      ) VALUES
        ($1, false, $3),
        ($2, false, $3)
    `,
    [teacherUserId, students.rows[2]!.id, operator.rows[0]!.id],
  );
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, school_code, school_name, school_kind,
      region_name, edu_office_name
    ) VALUES (
      'B10', '7060900', '대상 통합 학교', 'middle',
      '서울특별시', '서울특별시교육청'
    )
  `);

  const fixtureClient = await bootstrapPool.connect();
  try {
    await fixtureClient.query("BEGIN");
    const activeClass = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('대상반', 2026, 2, 'B10', '7060900', 30, $1)
        RETURNING id
      `,
      [teacherUserId],
    );
    activeClassId = activeClass.rows[0]!.id;
    const outsiderClass = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES ('다른반', 2026, 2, 'B10', '7060900', 30, $1)
        RETURNING id
      `,
      [students.rows[2]!.id],
    );
    const members = await fixtureClient.query<{
      class_id: string;
      id: string;
      role: string;
    }>(
      `
        INSERT INTO class_members (
          class_id, user_id, role, status, student_number,
          display_name_in_class, status_changed_at
        ) VALUES
          ($1, $2, 'teacher', 'approved', NULL, NULL, now()),
          ($1, $3, 'student', 'approved', 1, '대상 학생', now()),
          ($4, $5, 'teacher', 'approved', NULL, NULL, now()),
          ($4, $6, 'student', 'approved', 1, '다른 반 학생', now())
        RETURNING id, class_id, role
      `,
      [
        activeClassId,
        teacherUserId,
        students.rows[0]!.id,
        outsiderClass.rows[0]!.id,
        students.rows[2]!.id,
        students.rows[1]!.id,
      ],
    );
    teacherMemberId = members.rows.find(
      (row) => row.class_id === activeClassId && row.role === "teacher",
    )!.id;
    studentMemberId = members.rows.find(
      (row) => row.class_id === activeClassId && row.role === "student",
    )!.id;
    outsiderMemberId = members.rows.find(
      (row) => row.class_id !== activeClassId && row.role === "student",
    )!.id;
    await fixtureClient.query("COMMIT");
  } catch (error) {
    await fixtureClient.query("ROLLBACK");
    throw error;
  } finally {
    fixtureClient.release();
  }

  const notice = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO notices (
        class_id, title, content, created_by_member_id
      ) VALUES ($1, '기존 공지', '기존 공지 내용', $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  legacyNoticeId = notice.rows[0]!.id;
  const supply = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO supplies (
        class_id, title, needed_on, created_by_member_id
      ) VALUES ($1, '기존 준비물', DATE '2026-08-10', $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  legacySupplyId = supply.rows[0]!.id;
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
  appPool = new Pool({
    connectionString: databaseUrl("classhub_app", "local_app_password"),
  });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), bootstrapPool?.end()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("content audience migration", () => {
  it("applies cleanly, rolls an empty v10 back, and upgrades populated v9 without loss", async () => {
    await migrate("up", 10);
    const clean = await bootstrapPool.query<{
      count: string;
      latest: string;
      notice_recipients: string | null;
      supply_recipients: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        to_regclass('public.notice_recipients')::text AS notice_recipients,
        to_regclass('public.supply_recipients')::text AS supply_recipients
    `);
    expect(clean.rows[0]).toEqual({
      count: "10",
      latest: "1783700009000_content-audiences",
      notice_recipients: "notice_recipients",
      supply_recipients: "supply_recipients",
    });

    await migrate("down", 1);
    await seedV9Fixture();
    const before = await bootstrapPool.query<{ notices: string; supplies: string }>(`
      SELECT
        (SELECT count(*)::text FROM notices) AS notices,
        (SELECT count(*)::text FROM supplies) AS supplies
    `);
    await migrate("up", 1);
    const after = await bootstrapPool.query<{
      notice_audience: string;
      notice_category: string;
      notices: string;
      supplies: string;
      supply_audience: string;
    }>(
      `
        SELECT
          (SELECT count(*)::text FROM notices) AS notices,
          (SELECT count(*)::text FROM supplies) AS supplies,
          (SELECT audience_mode FROM notices WHERE id = $1) AS notice_audience,
          (SELECT category FROM notices WHERE id = $1) AS notice_category,
          (SELECT audience_mode FROM supplies WHERE id = $2) AS supply_audience
      `,
      [legacyNoticeId, legacySupplyId],
    );
    expect(before.rows[0]).toEqual({ notices: "1", supplies: "1" });
    expect(after.rows[0]).toEqual({
      notice_audience: "legacy_class",
      notice_category: "general",
      notices: "1",
      supplies: "1",
      supply_audience: "legacy_class",
    });
  });

  it("creates constrained composite recipient tables and target-aware indexes", async () => {
    const columns = await bootstrapPool.query<{
      column_default: string | null;
      column_name: string;
      is_nullable: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'notices' AND column_name IN ('audience_mode', 'category'))
          OR (table_name = 'supplies' AND column_name = 'audience_mode')
          OR table_name IN ('notice_recipients', 'supply_recipients')
        )
      ORDER BY table_name, ordinal_position
    `);
    expect(columns.rows).toContainEqual({
      column_default: "'legacy_class'::text",
      column_name: "audience_mode",
      is_nullable: "NO",
      table_name: "notices",
    });
    expect(columns.rows).toContainEqual({
      column_default: "'general'::text",
      column_name: "category",
      is_nullable: "NO",
      table_name: "notices",
    });
    expect(columns.rows).toContainEqual({
      column_default: "'legacy_class'::text",
      column_name: "audience_mode",
      is_nullable: "NO",
      table_name: "supplies",
    });

    const indexes = await bootstrapPool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'notice_recipients_member_content_index',
          'supply_recipients_member_content_index',
          'notices_category_updates_index',
          'supplies_updates_index'
        )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "notice_recipients_member_content_index",
      "notices_category_updates_index",
      "supplies_updates_index",
      "supply_recipients_member_content_index",
    ]);
  });

  it("allows only app SELECT/INSERT and enforces mode, category, class, and uniqueness", async () => {
    const notice = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO notices (
          class_id, title, content, category, audience_mode, created_by_member_id
        ) VALUES (
          $1, '지정 공지', '지정 공지 내용', 'performance',
          'selected_snapshot', $2
        )
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    selectedNoticeId = notice.rows[0]!.id;
    const supply = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO supplies (
          class_id, title, needed_on, audience_mode, created_by_member_id
        ) VALUES (
          $1, '지정 준비물', DATE '2026-08-11', 'selected_snapshot', $2
        )
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    selectedSupplyId = supply.rows[0]!.id;

    await appPool.query(
      `
        INSERT INTO notice_recipients (notice_id, class_id, member_id)
        VALUES ($1, $2, $3)
      `,
      [selectedNoticeId, activeClassId, studentMemberId],
    );
    await appPool.query(
      `
        INSERT INTO supply_recipients (supply_id, class_id, member_id)
        VALUES ($1, $2, $3)
      `,
      [selectedSupplyId, activeClassId, studentMemberId],
    );
    expect(
      (
        await appPool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM notice_recipients WHERE notice_id = $1",
          [selectedNoticeId],
        )
      ).rows[0]?.count,
    ).toBe("1");

    await expectPostgresError(
      appPool.query(
        `
          UPDATE notice_recipients SET created_at = now()
          WHERE notice_id = $1 AND member_id = $2
        `,
        [selectedNoticeId, studentMemberId],
      ),
      "42501",
    );
    await expectPostgresError(
      appPool.query("DELETE FROM supply_recipients WHERE supply_id = $1 AND member_id = $2", [
        selectedSupplyId,
        studentMemberId,
      ]),
      "42501",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO notice_recipients (notice_id, class_id, member_id)
          VALUES ($1, $2, $3)
        `,
        [selectedNoticeId, activeClassId, studentMemberId],
      ),
      "23505",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO notice_recipients (notice_id, class_id, member_id)
          VALUES ($1, $2, $3)
        `,
        [selectedNoticeId, activeClassId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query("UPDATE notices SET audience_mode = 'all_snapshot' WHERE id = $1", [
        selectedNoticeId,
      ]),
      "P0001",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO notices (
            class_id, title, content, category, audience_mode, created_by_member_id
          ) VALUES ($1, '잘못된 분류', '내용', 'exam', 'all_snapshot', $2)
        `,
        [activeClassId, teacherMemberId],
      ),
      "23514",
    );
  });

  it("accepts aggregate audience audit fields without recipient identity", async () => {
    const requestId = randomUUID();
    await bootstrapPool.query(
      `
        INSERT INTO audit_logs (
          class_id, actor_user_id, actor_member_id,
          actor_display_name_snapshot, actor_role_snapshot,
          action, target_type, target_id,
          target_snapshot, before_json, after_json, reason, request_id
        ) VALUES (
          $1, $2, $3, '대상 담임', 'teacher',
          'notice.created', 'notice', $4,
          NULL, NULL, $5::jsonb, NULL, $6
        )
      `,
      [
        activeClassId,
        teacherUserId,
        teacherMemberId,
        selectedNoticeId,
        JSON.stringify({
          audience_mode: "selected_snapshot",
          category: "performance",
          content_revision: "1",
          deleted_at: null,
          is_important: false,
          notice_id: selectedNoticeId,
          published_at: new Date().toISOString(),
          recipient_count: 1,
          title: "지정 공지",
        }),
        requestId,
      ],
    );
    const audit = await bootstrapPool.query<{
      after_json: Record<string, unknown>;
    }>("SELECT after_json FROM audit_logs WHERE request_id = $1", [requestId]);
    expect(audit.rows[0]?.after_json).toMatchObject({
      audience_mode: "selected_snapshot",
      category: "performance",
      recipient_count: 1,
    });
    expect(audit.rows[0]?.after_json).not.toHaveProperty("member_id");
    expect(audit.rows[0]?.after_json).not.toHaveProperty("recipient_ids");
  });

  it("refuses destructive down with audience data, then restores v9 when clean", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /content audience rollback requires all content to remain legacy/,
    );
    const stillApplied = await bootstrapPool.query<{ count: string; table_name: string | null }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        to_regclass('public.notice_recipients')::text AS table_name
    `);
    expect(stillApplied.rows[0]).toEqual({
      count: "10",
      table_name: "notice_recipients",
    });

    await bootstrapPool.query(
      `
        DELETE FROM audit_logs
        WHERE action IN ('notice.created', 'supply.created')
          AND (
            COALESCE(target_snapshot, '{}'::jsonb) ?| ARRAY[
              'category', 'audience_mode', 'recipient_count'
            ]
            OR COALESCE(before_json, '{}'::jsonb) ?| ARRAY[
              'category', 'audience_mode', 'recipient_count'
            ]
            OR COALESCE(after_json, '{}'::jsonb) ?| ARRAY[
              'category', 'audience_mode', 'recipient_count'
            ]
          )
      `,
    );
    await bootstrapPool.query("DELETE FROM notices WHERE id = $1", [selectedNoticeId]);
    await bootstrapPool.query("DELETE FROM supplies WHERE id = $1", [selectedSupplyId]);
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      count: string;
      latest: string;
      notice_audience: string | null;
      notice_recipients: string | null;
      notices: string;
      supplies: string;
      supply_recipients: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        (
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'notices'
            AND column_name = 'audience_mode'
        ) AS notice_audience,
        to_regclass('public.notice_recipients')::text AS notice_recipients,
        to_regclass('public.supply_recipients')::text AS supply_recipients,
        (SELECT count(*)::text FROM notices) AS notices,
        (SELECT count(*)::text FROM supplies) AS supplies
    `);
    expect(restored.rows[0]).toEqual({
      count: "9",
      latest: "1783700008000_in-app-reminders",
      notice_audience: null,
      notice_recipients: null,
      notices: "1",
      supplies: "1",
      supply_recipients: null,
    });

    await migrate("up", 1);
  });
});
