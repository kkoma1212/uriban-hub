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
let activeNoticeId: string;
let activeSupplyId: string;
let appPool: Pool;
let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;
let outsiderClassId: string;
let outsiderMemberId: string;
let scheduleAuditRequestId: string;
let studentMemberId: string;
let teacherMemberId: string;
let teacherUserId: string;

const noticeBatchId = randomUUID();
const repeatedNoticeBatchId = randomUUID();
const supplyBatchId = randomUUID();

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function expectPostgresError(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
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

async function seedCurrentV7Fixture(): Promise<void> {
  const operator = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO operators (email_normalized, credential_hash)
    VALUES (
      'reminder-operator@example.com',
      decode(repeat('71', 32), 'hex')
    )
    RETURNING id
  `);
  await bootstrapPool.query(`
    INSERT INTO schools (
      edu_office_code, school_code, school_name, school_kind,
      region_name, edu_office_name
    ) VALUES (
      'B10', '7060002', '재알림 통합 학교', 'elementary',
      '서울특별시', '서울특별시교육청'
    )
  `);

  const teacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'reminder-teacher@example.com', '재알림 교사',
      'argon2-placeholder', now()
    ) RETURNING id
  `);
  teacherUserId = teacher.rows[0]!.id;

  const student = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'reminder-student@example.com', '재알림 학생',
      'argon2-placeholder', now()
    ) RETURNING id
  `);
  const outsider = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'reminder-outsider@example.com', '다른 반 학생',
      'argon2-placeholder', now()
    ) RETURNING id
  `);
  const outsiderTeacher = await bootstrapPool.query<{ id: string }>(`
    INSERT INTO users (
      email_normalized, display_name, password_hash, email_verified_at
    ) VALUES (
      'reminder-outsider-teacher@example.com', '다른 반 교사',
      'argon2-placeholder', now()
    ) RETURNING id
  `);
  await bootstrapPool.query(
    `
      INSERT INTO teacher_profiles (
        user_id, temporary_password_must_change, created_by_operator_id
      ) VALUES
        ($1, false, $3),
        ($2, false, $3)
    `,
    [teacherUserId, outsiderTeacher.rows[0]!.id, operator.rows[0]!.id],
  );

  const fixtureClient = await bootstrapPool.connect();
  try {
    await fixtureClient.query("BEGIN");
    const activeClass = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES (
          '재알림 통합반', 2026, 1, 'B10', '7060002', 30, $1
        ) RETURNING id
      `,
      [teacherUserId],
    );
    activeClassId = activeClass.rows[0]!.id;

    const outsiderClass = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO classes (
          name, academic_year, grade, edu_office_code, school_code,
          expected_student_count, created_by_user_id
        ) VALUES (
          '다른 통합반', 2026, 2, 'B10', '7060002', 25, $1
        ) RETURNING id
      `,
      [outsiderTeacher.rows[0]!.id],
    );
    outsiderClassId = outsiderClass.rows[0]!.id;

    const teacherMember = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
        RETURNING id
      `,
      [activeClassId, teacherUserId],
    );
    teacherMemberId = teacherMember.rows[0]!.id;
    await fixtureClient.query(
      `
        INSERT INTO class_members (class_id, user_id, role, status)
        VALUES ($1, $2, 'teacher', 'approved')
      `,
      [outsiderClassId, outsiderTeacher.rows[0]!.id],
    );

    const studentMember = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO class_members (
          class_id, user_id, role, status, student_number
        ) VALUES ($1, $2, 'student', 'approved', 7)
        RETURNING id
      `,
      [activeClassId, student.rows[0]!.id],
    );
    studentMemberId = studentMember.rows[0]!.id;

    const outsiderMember = await fixtureClient.query<{ id: string }>(
      `
        INSERT INTO class_members (
          class_id, user_id, role, status, student_number
        ) VALUES ($1, $2, 'student', 'approved', 8)
        RETURNING id
      `,
      [outsiderClassId, outsider.rows[0]!.id],
    );
    outsiderMemberId = outsiderMember.rows[0]!.id;
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
        class_id, title, content, is_important, created_by_member_id
      ) VALUES ($1, '재알림 공지', '공지 본문', true, $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  activeNoticeId = notice.rows[0]!.id;

  const supply = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO supplies (
        class_id, title, description, needed_on, created_by_member_id
      ) VALUES ($1, '재알림 준비물', '준비물 설명', DATE '2026-08-01', $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  activeSupplyId = supply.rows[0]!.id;

  const schedule = await bootstrapPool.query<{ id: string }>(
    `
      INSERT INTO schedules (
        class_id, title, schedule_type, due_date, created_by_member_id
      ) VALUES ($1, '보존 일정', 'other', DATE '2026-08-02', $2)
      RETURNING id
    `,
    [activeClassId, teacherMemberId],
  );
  scheduleAuditRequestId = randomUUID();
  await bootstrapPool.query(
    `
      INSERT INTO audit_logs (
        class_id, actor_user_id, actor_member_id,
        actor_display_name_snapshot, actor_role_snapshot,
        action, target_type, target_id, after_json, request_id
      ) VALUES (
        $1, $2, $3, '재알림 교사', 'teacher',
        'schedule.created', 'schedule', $4::text,
        jsonb_build_object(
          'schedule_id', $4::bigint, 'title', '보존 일정',
          'schedule_type', 'other', 'due_date', '2026-08-02'
        ), $5
      )
    `,
    [activeClassId, teacherUserId, teacherMemberId, schedule.rows[0]!.id, scheduleAuditRequestId],
  );
}

interface ReminderAuditOptions {
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
  reason?: string | null;
  target?: Record<string, unknown>;
  targetId?: string;
  targetType?: string;
}

async function insertReminderAudit(
  action: "notice.reminder_created" | "supply.reminder_created",
  options: ReminderAuditOptions = {},
): Promise<void> {
  const noticeAction = action === "notice.reminder_created";
  await bootstrapPool.query(
    `
      INSERT INTO audit_logs (
        class_id, actor_user_id, actor_member_id,
        actor_display_name_snapshot, actor_role_snapshot,
        action, target_type, target_id,
        target_snapshot, before_json, after_json, reason, request_id
      ) VALUES (
        $1, $2, $3, '재알림 교사', 'teacher',
        $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11
      )
    `,
    [
      activeClassId,
      teacherUserId,
      teacherMemberId,
      action,
      options.targetType ?? (noticeAction ? "notice" : "supply"),
      options.targetId ?? (noticeAction ? activeNoticeId : activeSupplyId),
      options.target === undefined ? null : JSON.stringify(options.target),
      options.before === undefined ? null : JSON.stringify(options.before),
      options.after === undefined ? null : JSON.stringify(options.after),
      options.reason ?? null,
      randomUUID(),
    ],
  );
}

function reminderAuditAfter(batchId: string): Record<string, unknown> {
  return {
    content_revision: "1",
    cooldown_suppressed_count: 1,
    created_count: 2,
    current_unresolved_count: 3,
    reminder_batch_id: batchId,
  };
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
  // Keep this migration-specific suite pinned to the v9 boundary.
  await migrate("up", 9);
  appPool = new Pool({
    connectionString: databaseUrl("classhub_app", "local_app_password"),
  });
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([appPool?.end(), bootstrapPool?.end()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("in-app reminder migration", () => {
  it("applies cleanly from an empty database", async () => {
    const state = await bootstrapPool.query<{
      batches: string | null;
      count: string;
      latest: string;
      recipients: string | null;
      sequence: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        to_regclass('public.in_app_reminder_batches')::text AS batches,
        to_regclass('public.in_app_reminder_recipients')::text AS recipients,
        to_regclass('public.in_app_reminder_batches_id_seq')::text AS sequence
    `);
    expect(state.rows[0]).toEqual({
      batches: "in_app_reminder_batches",
      count: "9",
      latest: "1783700008000_in-app-reminders",
      recipients: "in_app_reminder_recipients",
      sequence: null,
    });
  });

  it("rolls an empty schema back and upgrades a populated v7 schema without data loss", async () => {
    await migrate("down", 1);
    const emptyDown = await bootstrapPool.query<{
      batches: string | null;
      count: string;
      recipients: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        to_regclass('public.in_app_reminder_batches')::text AS batches,
        to_regclass('public.in_app_reminder_recipients')::text AS recipients
    `);
    expect(emptyDown.rows[0]).toEqual({
      batches: null,
      count: "8",
      recipients: null,
    });

    await seedCurrentV7Fixture();
    const before = await bootstrapPool.query<{
      audits: string;
      notices: string;
      supplies: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM notices) AS notices,
        (SELECT count(*)::text FROM supplies) AS supplies,
        (
          SELECT count(*)::text FROM audit_logs
          WHERE request_id = '${scheduleAuditRequestId}'
        ) AS audits
    `);
    await migrate("up", 1);
    const after = await bootstrapPool.query<{
      audits: string;
      notices: string;
      supplies: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM notices) AS notices,
        (SELECT count(*)::text FROM supplies) AS supplies,
        (
          SELECT count(*)::text FROM audit_logs
          WHERE request_id = '${scheduleAuditRequestId}'
        ) AS audits
    `);
    expect(before.rows[0]).toEqual({ audits: "1", notices: "1", supplies: "1" });
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("creates the UUID/composite-key schema and required partial indexes", async () => {
    const columns = await bootstrapPool.query<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: string;
      table_name: string;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'in_app_reminder_batches', 'in_app_reminder_recipients'
        )
      ORDER BY table_name, ordinal_position
    `);
    expect(columns.rows).toEqual([
      {
        column_default: null,
        column_name: "id",
        data_type: "uuid",
        is_nullable: "NO",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "class_id",
        data_type: "bigint",
        is_nullable: "NO",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "notice_id",
        data_type: "bigint",
        is_nullable: "YES",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "supply_id",
        data_type: "bigint",
        is_nullable: "YES",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "content_revision",
        data_type: "bigint",
        is_nullable: "NO",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "created_by_member_id",
        data_type: "bigint",
        is_nullable: "NO",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: "now()",
        column_name: "created_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
        table_name: "in_app_reminder_batches",
      },
      {
        column_default: null,
        column_name: "batch_id",
        data_type: "uuid",
        is_nullable: "NO",
        table_name: "in_app_reminder_recipients",
      },
      {
        column_default: null,
        column_name: "class_id",
        data_type: "bigint",
        is_nullable: "NO",
        table_name: "in_app_reminder_recipients",
      },
      {
        column_default: null,
        column_name: "member_id",
        data_type: "bigint",
        is_nullable: "NO",
        table_name: "in_app_reminder_recipients",
      },
      {
        column_default: "now()",
        column_name: "created_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
        table_name: "in_app_reminder_recipients",
      },
      {
        column_default: null,
        column_name: "resolved_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        table_name: "in_app_reminder_recipients",
      },
    ]);

    const constraints = await bootstrapPool.query<{ definition: string; name: string }>(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'in_app_reminder_batches'::regclass,
        'in_app_reminder_recipients'::regclass
      )
    `);
    const byName = new Map(
      constraints.rows.map((constraint) => [constraint.name, constraint.definition]),
    );
    expect(byName.get("in_app_reminder_recipients_pkey")).toBe("PRIMARY KEY (batch_id, member_id)");
    expect(byName.get("in_app_reminder_batches_notice_id_class_id_fkey")).toContain(
      "FOREIGN KEY (notice_id, class_id) REFERENCES notices(id, class_id) ON DELETE CASCADE",
    );
    expect(byName.get("in_app_reminder_batches_supply_id_class_id_fkey")).toContain(
      "FOREIGN KEY (supply_id, class_id) REFERENCES supplies(id, class_id) ON DELETE CASCADE",
    );
    expect(byName.get("in_app_reminder_batches_created_by_member_id_class_id_fkey")).toContain(
      "ON DELETE RESTRICT",
    );
    expect(byName.get("in_app_reminder_recipients_batch_id_class_id_fkey")).toContain(
      "ON DELETE CASCADE",
    );
    expect(byName.get("in_app_reminder_recipients_member_id_class_id_fkey")).toContain(
      "ON DELETE RESTRICT",
    );

    const indexes = await bootstrapPool.query<{ indexdef: string; indexname: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE 'in_app_reminder_%_index'
      ORDER BY indexname
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "in_app_reminder_batches_notice_revision_index",
      "in_app_reminder_batches_supply_revision_index",
      "in_app_reminder_recipients_home_unresolved_index",
      "in_app_reminder_recipients_member_batch_unresolved_index",
    ]);
    expect(indexes.rows[0]!.indexdef).toContain(
      "(class_id, notice_id, content_revision, created_at DESC, id DESC)",
    );
    expect(indexes.rows[0]!.indexdef).toContain("WHERE (notice_id IS NOT NULL)");
    expect(indexes.rows[1]!.indexdef).toContain(
      "(class_id, supply_id, content_revision, created_at DESC, id DESC)",
    );
    expect(indexes.rows[1]!.indexdef).toContain("WHERE (supply_id IS NOT NULL)");
    expect(indexes.rows[2]!.indexdef).toContain("(class_id, member_id, created_at DESC, batch_id)");
    expect(indexes.rows[2]!.indexdef).toContain("WHERE (resolved_at IS NULL)");
    expect(indexes.rows[3]!.indexdef).toContain("(member_id, batch_id)");
    expect(indexes.rows[3]!.indexdef).toContain("WHERE (resolved_at IS NULL)");
  });

  it("enforces one resource, revision, class isolation, recipient identity, and repeats", async () => {
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, notice_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [noticeBatchId, activeClassId, activeNoticeId, teacherMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, notice_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [repeatedNoticeBatchId, activeClassId, activeNoticeId, teacherMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, supply_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [supplyBatchId, activeClassId, activeSupplyId, teacherMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_recipients (
          batch_id, class_id, member_id
        ) VALUES ($1, $2, $3)
      `,
      [noticeBatchId, activeClassId, studentMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_recipients (
          batch_id, class_id, member_id
        ) VALUES ($1, $2, $3)
      `,
      [supplyBatchId, activeClassId, studentMemberId],
    );

    const repeated = await bootstrapPool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM in_app_reminder_batches
        WHERE class_id = $1 AND notice_id = $2 AND content_revision = 1
      `,
      [activeClassId, activeNoticeId],
    );
    expect(repeated.rows[0]?.count).toBe("2");

    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_batches (
            id, class_id, content_revision, created_by_member_id
          ) VALUES ($1, $2, 1, $3)
        `,
        [randomUUID(), activeClassId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_batches (
            id, class_id, notice_id, supply_id,
            content_revision, created_by_member_id
          ) VALUES ($1, $2, $3, $4, 1, $5)
        `,
        [randomUUID(), activeClassId, activeNoticeId, activeSupplyId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_batches (
            id, class_id, notice_id, content_revision, created_by_member_id
          ) VALUES ($1, $2, $3, 0, $4)
        `,
        [randomUUID(), activeClassId, activeNoticeId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_batches (
            id, class_id, notice_id, content_revision, created_by_member_id
          ) VALUES ($1, $2, $3, 1, $4)
        `,
        [randomUUID(), outsiderClassId, activeNoticeId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_batches (
            id, class_id, notice_id, content_revision, created_by_member_id
          ) VALUES ($1, $2, $3, 1, $4)
        `,
        [randomUUID(), activeClassId, activeNoticeId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_recipients (
            batch_id, class_id, member_id
          ) VALUES ($1, $2, $3)
        `,
        [noticeBatchId, outsiderClassId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_recipients (
            batch_id, class_id, member_id
          ) VALUES ($1, $2, $3)
        `,
        [noticeBatchId, activeClassId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_recipients (
            batch_id, class_id, member_id
          ) VALUES ($1, $2, $3)
        `,
        [noticeBatchId, activeClassId, studentMemberId],
      ),
      "23505",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO in_app_reminder_recipients (
            batch_id, class_id, member_id, created_at, resolved_at
          ) VALUES ($1, $2, $3, now(), now() - interval '1 second')
        `,
        [repeatedNoticeBatchId, activeClassId, studentMemberId],
      ),
      "23514",
    );
  });

  it("accepts only aggregate reminder audit metadata with the matching target type", async () => {
    await insertReminderAudit("notice.reminder_created", {
      after: reminderAuditAfter(noticeBatchId),
    });
    await insertReminderAudit("supply.reminder_created", {
      after: reminderAuditAfter(supplyBatchId),
    });

    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
        targetType: "supply",
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
        targetId: "not-an-id",
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: {
          ...reminderAuditAfter(noticeBatchId),
          recipient_member_ids: [studentMemberId],
        },
      }),
      "23514",
    );
    const missingKey = reminderAuditAfter(noticeBatchId);
    delete missingKey.cooldown_suppressed_count;
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", { after: missingKey }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: {
          ...reminderAuditAfter(noticeBatchId),
          reminder_batch_id: "1",
        },
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: {
          ...reminderAuditAfter(noticeBatchId),
          content_revision: 1,
        },
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: {
          ...reminderAuditAfter(noticeBatchId),
          created_count: -1,
        },
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
        reason: "수신자 이름",
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
        before: { current_unresolved_count: 4 },
      }),
      "23514",
    );
    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
        target: { title: "개인정보 없는 제목도 저장하지 않음" },
      }),
      "23514",
    );

    const audits = await bootstrapPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM audit_logs
      WHERE action IN ('notice.reminder_created', 'supply.reminder_created')
    `);
    expect(audits.rows[0]?.count).toBe("2");
  });

  it("grants app only insert/read and one-way resolved_at updates", async () => {
    const privileges = await bootstrapPool.query<{
      app_batch_delete: boolean;
      app_batch_insert: boolean;
      app_batch_select: boolean;
      app_batch_update: boolean;
      app_recipient_class_update: boolean;
      app_recipient_delete: boolean;
      app_recipient_insert: boolean;
      app_recipient_resolved_update: boolean;
      app_recipient_select: boolean;
      app_recipient_table_update: boolean;
      app_trigger_execute: boolean;
      public_trigger_execute: boolean;
      sequence_exists: string | null;
    }>(`
      SELECT
        has_table_privilege(
          'classhub_app', 'in_app_reminder_batches', 'SELECT'
        ) AS app_batch_select,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_batches', 'INSERT'
        ) AS app_batch_insert,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_batches', 'UPDATE'
        ) AS app_batch_update,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_batches', 'DELETE'
        ) AS app_batch_delete,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'SELECT'
        ) AS app_recipient_select,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'INSERT'
        ) AS app_recipient_insert,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'UPDATE'
        ) AS app_recipient_table_update,
        has_table_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'DELETE'
        ) AS app_recipient_delete,
        has_column_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'resolved_at', 'UPDATE'
        ) AS app_recipient_resolved_update,
        has_column_privilege(
          'classhub_app', 'in_app_reminder_recipients', 'class_id', 'UPDATE'
        ) AS app_recipient_class_update,
        has_function_privilege(
          'classhub_app',
          'enforce_in_app_reminder_recipient_resolution()',
          'EXECUTE'
        ) AS app_trigger_execute,
        COALESCE((
          SELECT bool_or(
            function_acl.grantee = 0
            AND function_acl.privilege_type = 'EXECUTE'
          )
          FROM pg_proc AS function_proc
          CROSS JOIN LATERAL aclexplode(function_proc.proacl) AS function_acl
          WHERE function_proc.oid =
            'enforce_in_app_reminder_recipient_resolution()'::regprocedure
        ), false) AS public_trigger_execute,
        to_regclass('public.in_app_reminder_batches_id_seq')::text AS sequence_exists
    `);
    expect(privileges.rows[0]).toEqual({
      app_batch_delete: false,
      app_batch_insert: true,
      app_batch_select: true,
      app_batch_update: false,
      app_recipient_class_update: false,
      app_recipient_delete: false,
      app_recipient_insert: true,
      app_recipient_resolved_update: true,
      app_recipient_select: true,
      app_recipient_table_update: false,
      app_trigger_execute: false,
      public_trigger_execute: false,
      sequence_exists: null,
    });

    const closedRoles = await bootstrapPool.query<{
      role_name: string;
      table_access: boolean;
    }>(`
      SELECT role_name, (
        has_table_privilege(
          role_name, 'in_app_reminder_batches',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        OR has_table_privilege(
          role_name, 'in_app_reminder_recipients',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      ) AS table_access
      FROM unnest(ARRAY[
        'classhub_worker', 'classhub_retention',
        'classhub_operator', 'classhub_local_admin'
      ]) AS role_name
      ORDER BY role_name
    `);
    expect(closedRoles.rows).toEqual([
      { role_name: "classhub_local_admin", table_access: false },
      { role_name: "classhub_operator", table_access: false },
      { role_name: "classhub_retention", table_access: false },
      { role_name: "classhub_worker", table_access: false },
    ]);

    const appBatchId = randomUUID();
    await appPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, notice_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [appBatchId, activeClassId, activeNoticeId, teacherMemberId],
    );
    await appPool.query(
      `
        INSERT INTO in_app_reminder_recipients (
          batch_id, class_id, member_id
        ) VALUES ($1, $2, $3)
      `,
      [appBatchId, activeClassId, studentMemberId],
    );

    const unresolved = await appPool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM in_app_reminder_recipients
        WHERE class_id = $1 AND member_id = $2 AND resolved_at IS NULL
      `,
      [activeClassId, studentMemberId],
    );
    expect(unresolved.rows[0]?.count).toBe("3");

    await appPool.query(
      `
        UPDATE in_app_reminder_recipients
        SET resolved_at = now()
        WHERE batch_id = $1 AND member_id = $2
      `,
      [appBatchId, studentMemberId],
    );
    await expectPostgresError(
      appPool.query(
        `
          UPDATE in_app_reminder_recipients
          SET resolved_at = NULL
          WHERE batch_id = $1 AND member_id = $2
        `,
        [appBatchId, studentMemberId],
      ),
      "P0001",
    );
    await expectPostgresError(
      appPool.query(
        `
          UPDATE in_app_reminder_recipients
          SET resolved_at = resolved_at + interval '1 second'
          WHERE batch_id = $1 AND member_id = $2
        `,
        [appBatchId, studentMemberId],
      ),
      "P0001",
    );
    await expectPostgresError(
      appPool.query(
        `
          UPDATE in_app_reminder_recipients
          SET class_id = $1
          WHERE batch_id = $2 AND member_id = $3
        `,
        [outsiderClassId, appBatchId, studentMemberId],
      ),
      "42501",
    );
    await expectPostgresError(
      appPool.query("DELETE FROM in_app_reminder_recipients WHERE batch_id = $1", [appBatchId]),
      "42501",
    );
    await expectPostgresError(
      appPool.query("UPDATE in_app_reminder_batches SET content_revision = 2 WHERE id = $1", [
        appBatchId,
      ]),
      "42501",
    );
    await expectPostgresError(
      appPool.query("DELETE FROM in_app_reminder_batches WHERE id = $1", [appBatchId]),
      "42501",
    );

    const resolved = await appPool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM in_app_reminder_recipients
        WHERE batch_id = $1 AND member_id = $2 AND resolved_at IS NULL
      `,
      [appBatchId, studentMemberId],
    );
    expect(resolved.rows[0]?.count).toBe("0");
  });

  it("cascades source deletion while retaining member deletion protection", async () => {
    const disposableNotice = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO notices (
          class_id, title, content, created_by_member_id
        ) VALUES ($1, '삭제 연동 공지', '삭제 연동 본문', $2)
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    const disposableNoticeBatch = randomUUID();
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, notice_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [disposableNoticeBatch, activeClassId, disposableNotice.rows[0]!.id, teacherMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_recipients (
          batch_id, class_id, member_id
        ) VALUES ($1, $2, $3)
      `,
      [disposableNoticeBatch, activeClassId, studentMemberId],
    );
    await bootstrapPool.query("DELETE FROM notices WHERE id = $1", [disposableNotice.rows[0]!.id]);

    const noticeCascade = await bootstrapPool.query<{
      batches: string;
      recipients: string;
    }>(
      `
        SELECT
          (
            SELECT count(*)::text FROM in_app_reminder_batches WHERE id = $1
          ) AS batches,
          (
            SELECT count(*)::text FROM in_app_reminder_recipients WHERE batch_id = $1
          ) AS recipients
      `,
      [disposableNoticeBatch],
    );
    expect(noticeCascade.rows[0]).toEqual({ batches: "0", recipients: "0" });

    const disposableSupply = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO supplies (
          class_id, title, needed_on, created_by_member_id
        ) VALUES ($1, '삭제 연동 준비물', DATE '2026-08-03', $2)
        RETURNING id
      `,
      [activeClassId, teacherMemberId],
    );
    const disposableSupplyBatch = randomUUID();
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_batches (
          id, class_id, supply_id, content_revision, created_by_member_id
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [disposableSupplyBatch, activeClassId, disposableSupply.rows[0]!.id, teacherMemberId],
    );
    await bootstrapPool.query(
      `
        INSERT INTO in_app_reminder_recipients (
          batch_id, class_id, member_id
        ) VALUES ($1, $2, $3)
      `,
      [disposableSupplyBatch, activeClassId, studentMemberId],
    );
    await bootstrapPool.query("DELETE FROM supplies WHERE id = $1", [disposableSupply.rows[0]!.id]);

    const supplyCascade = await bootstrapPool.query<{
      batches: string;
      recipients: string;
    }>(
      `
        SELECT
          (
            SELECT count(*)::text FROM in_app_reminder_batches WHERE id = $1
          ) AS batches,
          (
            SELECT count(*)::text FROM in_app_reminder_recipients WHERE batch_id = $1
          ) AS recipients
      `,
      [disposableSupplyBatch],
    );
    expect(supplyCascade.rows[0]).toEqual({ batches: "0", recipients: "0" });

    await expectPostgresError(
      bootstrapPool.query("DELETE FROM class_members WHERE id = $1", [studentMemberId]),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query("DELETE FROM class_members WHERE id = $1", [teacherMemberId]),
      "23503",
    );
  });

  it("refuses destructive down with table or audit data, then restores v7 when empty", async () => {
    await expect(migrate("down", 1)).rejects.toThrow(
      /in-app reminder rollback requires reminder tables to be empty/,
    );
    const afterTableRefusal = await bootstrapPool.query<{
      count: string;
      table_name: string | null;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        to_regclass('public.in_app_reminder_batches')::text AS table_name
    `);
    expect(afterTableRefusal.rows[0]).toEqual({
      count: "9",
      table_name: "in_app_reminder_batches",
    });

    await bootstrapPool.query("DELETE FROM in_app_reminder_batches");
    await expect(migrate("down", 1)).rejects.toThrow(
      /in-app reminder rollback requires reminder audit rows to be empty/,
    );

    await bootstrapPool.query(`
      DELETE FROM audit_logs
      WHERE action IN ('notice.reminder_created', 'supply.reminder_created')
    `);
    await migrate("down", 1);

    const restored = await bootstrapPool.query<{
      audits: string;
      batches: string | null;
      count: string;
      function_name: string | null;
      latest: string;
      notices: string;
      recipients: string | null;
      supplies: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        to_regclass('public.in_app_reminder_batches')::text AS batches,
        to_regclass('public.in_app_reminder_recipients')::text AS recipients,
        to_regprocedure(
          'public.enforce_in_app_reminder_recipient_resolution()'
        )::text AS function_name,
        (SELECT count(*)::text FROM notices) AS notices,
        (SELECT count(*)::text FROM supplies) AS supplies,
        (
          SELECT count(*)::text FROM audit_logs
          WHERE request_id = '${scheduleAuditRequestId}'
        ) AS audits
    `);
    expect(restored.rows[0]).toEqual({
      audits: "1",
      batches: null,
      count: "8",
      function_name: null,
      latest: "1783700007000_operator-runtime-privileges",
      notices: "1",
      recipients: null,
      supplies: "1",
    });

    await expectPostgresError(
      insertReminderAudit("notice.reminder_created", {
        after: reminderAuditAfter(noticeBatchId),
      }),
      "23514",
    );
    const oldConstraints = await bootstrapPool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'audit_logs'::regclass
        AND conname IN ('audit_logs_action_check', 'audit_logs_json_allowlist_check')
      ORDER BY conname
    `);
    expect(oldConstraints.rows).toHaveLength(2);
    for (const constraint of oldConstraints.rows) {
      expect(constraint.definition).not.toContain("reminder_created");
    }
  });
});
