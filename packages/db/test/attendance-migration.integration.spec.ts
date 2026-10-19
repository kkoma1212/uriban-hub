import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activeClassId,
  bootstrapPool,
  databaseUrl,
  existingScheduleRequestId,
  expectPostgresError,
  insertAttendanceAudit,
  migrationsDirectory,
  migratorDatabaseUrl,
  outsiderMemberId,
  retentionRunId,
  setupAttendanceMigrationTestHarness,
  studentMemberId,
  teacherMemberId,
  teacherUserId,
  teardownAttendanceMigrationTestHarness,
} from "./attendance-migration-test-harness.js";

beforeAll(setupAttendanceMigrationTestHarness, 120_000);

afterAll(teardownAttendanceMigrationTestHarness);

describe.sequential("attendance notifications migration", () => {
  it("migrates existing data and creates the exact table and indexes", async () => {
    const ledger = await bootstrapPool.query<{ count: string; latest: string }>(`
      SELECT count(*)::text AS count, max(name) AS latest FROM pgmigrations
    `);
    expect(ledger.rows[0]).toEqual({
      count: "7",
      latest: "1783700006000_attendance-notifications",
    });

    const columns = await bootstrapPool.query<{
      column_name: string;
      data_type: string;
      datetime_precision: number | null;
      is_identity: string;
      is_nullable: string;
    }>(`
      SELECT column_name, data_type, datetime_precision, is_identity, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'attendance_notifications'
      ORDER BY ordinal_position
    `);
    expect(columns.rows.map((column) => column.column_name)).toEqual([
      "id",
      "class_id",
      "member_id",
      "notification_date",
      "notification_type",
      "expected_time",
      "status",
      "row_version",
      "submitted_at",
      "acknowledged_by_member_id",
      "acknowledged_at",
      "created_at",
      "updated_at",
    ]);
    expect(columns.rows.find((column) => column.column_name === "id")).toMatchObject({
      data_type: "bigint",
      is_identity: "YES",
      is_nullable: "NO",
    });
    expect(columns.rows.find((column) => column.column_name === "expected_time")).toMatchObject({
      data_type: "time without time zone",
      datetime_precision: 0,
      is_nullable: "YES",
    });
    expect(
      columns.rows.filter((column) =>
        ["submitted_at", "created_at", "updated_at"].includes(column.column_name),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "submitted_at", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "created_at", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "updated_at", is_nullable: "NO" }),
      ]),
    );

    const constraints = await bootstrapPool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'attendance_notifications'::regclass
      ORDER BY conname
    `);
    expect(constraints.rows.map((constraint) => constraint.conname)).toEqual(
      expect.arrayContaining([
        "attendance_notifications_acknowledgement_check",
        "attendance_notifications_class_member_date_unique",
        "attendance_notifications_expected_time_check",
        "attendance_notifications_expected_time_seconds_check",
        "attendance_notifications_row_version_check",
        "attendance_notifications_status_check",
        "attendance_notifications_type_check",
      ]),
    );

    const indexes = await bootstrapPool.query<{ indexdef: string; indexname: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'attendance_notifications_class_date_status_index',
          'attendance_notifications_member_date_index',
          'notices_importance_index'
        )
      ORDER BY indexname
    `);
    expect(
      indexes.rows.find(
        (index) => index.indexname === "attendance_notifications_class_date_status_index",
      )?.indexdef,
    ).toContain("(class_id, notification_date, status, id)");
    expect(
      indexes.rows.find((index) => index.indexname === "attendance_notifications_member_date_index")
        ?.indexdef,
    ).toContain("(member_id, notification_date DESC)");
    expect(
      indexes.rows.find((index) => index.indexname === "notices_importance_index")?.indexdef,
    ).toContain("(class_id, is_important DESC, published_at DESC, id DESC)");

    const preserved = await bootstrapPool.query<{
      notices: string;
      schedule_audits: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM notices) AS notices,
        (
          SELECT count(*)::text FROM audit_logs
          WHERE request_id = '${existingScheduleRequestId}'
        ) AS schedule_audits
    `);
    expect(preserved.rows[0]).toEqual({ notices: "2", schedule_audits: "1" });
  });

  it("enforces type, minute precision, acknowledgement, unique, and class boundaries", async () => {
    const valid = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO attendance_notifications (
          class_id, member_id, notification_date, notification_type, expected_time
        ) VALUES ($1, $2, DATE '2026-07-16', 'late', TIME '08:30')
        RETURNING id
      `,
      [activeClassId, studentMemberId],
    );
    expect(valid.rowCount).toBe(1);

    await bootstrapPool.query(
      `
        INSERT INTO attendance_notifications (
          class_id, member_id, notification_date, notification_type, expected_time
        ) VALUES ($1, $2, DATE '2026-07-17', 'absent', NULL)
      `,
      [activeClassId, studentMemberId],
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-18', 'late', NULL)
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-18', 'absent', TIME '08:30')
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-18', 'early', TIME '14:30:01')
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-18', 'unknown', NULL)
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type,
            expected_time, row_version
          ) VALUES ($1, $2, DATE '2026-07-18', 'absent', NULL, 0)
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type,
            expected_time, status
          ) VALUES ($1, $2, DATE '2026-07-18', 'absent', NULL, 'acknowledged')
        `,
        [activeClassId, studentMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type,
            expected_time, status, acknowledged_by_member_id, acknowledged_at
          ) VALUES (
            $1, $2, DATE '2026-07-18', 'absent', NULL,
            'pending', $3, now()
          )
        `,
        [activeClassId, studentMemberId, teacherMemberId],
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-18', 'absent', NULL)
        `,
        [activeClassId, outsiderMemberId],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-07-16', 'late', TIME '09:00')
        `,
        [activeClassId, studentMemberId],
      ),
      "23505",
    );

    await bootstrapPool.query(
      `
        UPDATE attendance_notifications
        SET status = 'acknowledged', acknowledged_by_member_id = $1,
            acknowledged_at = now(), updated_at = now(), row_version = row_version + 1
        WHERE id = $2
      `,
      [teacherMemberId, valid.rows[0]!.id],
    );
    const crossClassCandidate = await bootstrapPool.query<{ id: string }>(
      `
        INSERT INTO attendance_notifications (
          class_id, member_id, notification_date, notification_type, expected_time
        ) VALUES ($1, $2, DATE '2026-07-19', 'early', TIME '15:00')
        RETURNING id
      `,
      [activeClassId, studentMemberId],
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          UPDATE attendance_notifications
          SET status = 'acknowledged', acknowledged_by_member_id = $1,
              acknowledged_at = now()
          WHERE id = $2
        `,
        [outsiderMemberId, crossClassCandidate.rows[0]!.id],
      ),
      "23503",
    );
    await expectPostgresError(
      bootstrapPool.query("DELETE FROM class_members WHERE id = $1", [studentMemberId]),
      "23503",
    );
  });

  it("accepts four attendance audit actions and rejects sensitive keys", async () => {
    const base = {
      attendance_notification_id: 1,
      notification_date: "2026-07-16",
      notification_type: "late",
      status: "pending",
    };
    await insertAttendanceAudit(
      "attendance_notification.created",
      "00000000-0000-4000-8000-000000006201",
      "1",
      { after: base },
    );
    await insertAttendanceAudit(
      "attendance_notification.updated",
      "00000000-0000-4000-8000-000000006202",
      "1",
      {
        before: { notification_type: "late" },
        after: { notification_type: "early" },
      },
    );
    await insertAttendanceAudit(
      "attendance_notification.canceled",
      "00000000-0000-4000-8000-000000006203",
      "1",
      { before: { status: "pending" }, after: { status: "canceled" } },
    );
    await insertAttendanceAudit(
      "attendance_notification.acknowledged",
      "00000000-0000-4000-8000-000000006204",
      "1",
      { before: { status: "pending" }, after: { status: "acknowledged" } },
    );

    await expectPostgresError(
      insertAttendanceAudit(
        "attendance_notification.created",
        "00000000-0000-4000-8000-000000006205",
        "2",
        { after: { ...base, expected_time: "08:30" } },
      ),
      "23514",
    );
    await expectPostgresError(
      insertAttendanceAudit(
        "attendance_notification.updated",
        "00000000-0000-4000-8000-000000006206",
        "2",
        { after: { submitted_at: "2026-07-16T00:00:00Z" } },
      ),
      "23514",
    );
    await expectPostgresError(
      insertAttendanceAudit(
        "attendance_notification.created",
        "00000000-0000-4000-8000-000000006208",
        "2",
        { after: base, reason: "출결 자유 사유" },
      ),
      "23514",
    );
    await expectPostgresError(
      bootstrapPool.query(
        `
          INSERT INTO audit_logs (
            class_id, actor_user_id, actor_member_id,
            actor_display_name_snapshot, actor_role_snapshot,
            action, target_type, target_id, after_json, request_id
          ) VALUES (
            $1, $2, $3, '출결 담임', 'teacher',
            'schedule.created', 'schedule', '99',
            '{"attendance_notification_id":99}'::jsonb,
            '00000000-0000-4000-8000-000000006207'
          )
        `,
        [activeClassId, teacherUserId, teacherMemberId],
      ),
      "23514",
    );

    const attendanceAudits = await bootstrapPool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM audit_logs
      WHERE action LIKE 'attendance_notification.%'
    `);
    expect(attendanceAudits.rows[0]?.count).toBe("4");
  });

  it("grants only the application and retention capabilities required by the PRD", async () => {
    const privileges = await bootstrapPool.query<{
      app_delete: boolean;
      app_insert: boolean;
      app_operator_audit_insert: boolean;
      app_references: boolean;
      app_select: boolean;
      app_sequence_select: boolean;
      app_sequence_usage: boolean;
      app_sequence_update: boolean;
      app_trigger: boolean;
      app_truncate: boolean;
      app_update: boolean;
      local_admin_sequence_any: boolean;
      local_admin_table_any: boolean;
      retention_delete: boolean;
      retention_insert: boolean;
      retention_operator_audit_insert: boolean;
      retention_operator_audit_sequence_select: boolean;
      retention_operator_audit_sequence_usage: boolean;
      retention_operator_audit_sequence_update: boolean;
      retention_operator_audit_update: boolean;
      retention_references: boolean;
      retention_select: boolean;
      retention_sequence_select: boolean;
      retention_sequence_usage: boolean;
      retention_sequence_update: boolean;
      retention_trigger: boolean;
      retention_truncate: boolean;
      retention_update: boolean;
      worker_sequence_any: boolean;
      worker_table_any: boolean;
    }>(`
      SELECT
        has_table_privilege('classhub_app', 'attendance_notifications', 'SELECT') AS app_select,
        has_table_privilege('classhub_app', 'attendance_notifications', 'INSERT') AS app_insert,
        has_table_privilege('classhub_app', 'attendance_notifications', 'UPDATE') AS app_update,
        has_table_privilege('classhub_app', 'attendance_notifications', 'DELETE') AS app_delete,
        has_table_privilege('classhub_app', 'attendance_notifications', 'TRUNCATE') AS app_truncate,
        has_table_privilege('classhub_app', 'attendance_notifications', 'REFERENCES') AS app_references,
        has_table_privilege('classhub_app', 'attendance_notifications', 'TRIGGER') AS app_trigger,
        has_sequence_privilege(
          'classhub_app', 'attendance_notifications_id_seq', 'USAGE'
        ) AS app_sequence_usage,
        has_sequence_privilege(
          'classhub_app', 'attendance_notifications_id_seq', 'SELECT'
        ) AS app_sequence_select,
        has_sequence_privilege(
          'classhub_app', 'attendance_notifications_id_seq', 'UPDATE'
        ) AS app_sequence_update,
        has_table_privilege(
          'classhub_app', 'operator_audit_logs', 'INSERT'
        ) AS app_operator_audit_insert,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'SELECT'
        ) AS retention_select,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'INSERT'
        ) AS retention_insert,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'UPDATE'
        ) AS retention_update,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'DELETE'
        ) AS retention_delete,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'TRUNCATE'
        ) AS retention_truncate,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'REFERENCES'
        ) AS retention_references,
        has_table_privilege(
          'classhub_retention', 'attendance_notifications', 'TRIGGER'
        ) AS retention_trigger,
        has_sequence_privilege(
          'classhub_retention', 'attendance_notifications_id_seq', 'USAGE'
        ) AS retention_sequence_usage,
        has_sequence_privilege(
          'classhub_retention', 'attendance_notifications_id_seq', 'SELECT'
        ) AS retention_sequence_select,
        has_sequence_privilege(
          'classhub_retention', 'attendance_notifications_id_seq', 'UPDATE'
        ) AS retention_sequence_update,
        has_table_privilege(
          'classhub_retention', 'operator_audit_logs', 'INSERT'
        ) AS retention_operator_audit_insert,
        has_table_privilege(
          'classhub_retention', 'operator_audit_logs', 'UPDATE'
        ) AS retention_operator_audit_update,
        has_sequence_privilege(
          'classhub_retention', 'operator_audit_logs_id_seq', 'USAGE'
        ) AS retention_operator_audit_sequence_usage,
        has_sequence_privilege(
          'classhub_retention', 'operator_audit_logs_id_seq', 'SELECT'
        ) AS retention_operator_audit_sequence_select,
        has_sequence_privilege(
          'classhub_retention', 'operator_audit_logs_id_seq', 'UPDATE'
        ) AS retention_operator_audit_sequence_update,
        (
          has_table_privilege('classhub_worker', 'attendance_notifications', 'SELECT')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'INSERT')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'UPDATE')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'DELETE')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'TRUNCATE')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'REFERENCES')
          OR has_table_privilege('classhub_worker', 'attendance_notifications', 'TRIGGER')
        ) AS worker_table_any,
        (
          has_sequence_privilege('classhub_worker', 'attendance_notifications_id_seq', 'USAGE')
          OR has_sequence_privilege('classhub_worker', 'attendance_notifications_id_seq', 'SELECT')
          OR has_sequence_privilege('classhub_worker', 'attendance_notifications_id_seq', 'UPDATE')
        ) AS worker_sequence_any,
        (
          has_table_privilege('classhub_local_admin', 'attendance_notifications', 'SELECT')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'INSERT')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'UPDATE')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'DELETE')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'TRUNCATE')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'REFERENCES')
          OR has_table_privilege('classhub_local_admin', 'attendance_notifications', 'TRIGGER')
        ) AS local_admin_table_any,
        (
          has_sequence_privilege('classhub_local_admin', 'attendance_notifications_id_seq', 'USAGE')
          OR has_sequence_privilege('classhub_local_admin', 'attendance_notifications_id_seq', 'SELECT')
          OR has_sequence_privilege('classhub_local_admin', 'attendance_notifications_id_seq', 'UPDATE')
        ) AS local_admin_sequence_any
    `);
    expect(privileges.rows[0]).toEqual({
      app_delete: false,
      app_insert: true,
      app_operator_audit_insert: false,
      app_references: false,
      app_select: true,
      app_sequence_select: false,
      app_sequence_usage: true,
      app_sequence_update: false,
      app_trigger: false,
      app_truncate: false,
      app_update: true,
      local_admin_sequence_any: false,
      local_admin_table_any: false,
      retention_delete: true,
      retention_insert: false,
      retention_operator_audit_insert: true,
      retention_operator_audit_sequence_select: false,
      retention_operator_audit_sequence_usage: true,
      retention_operator_audit_sequence_update: false,
      retention_operator_audit_update: false,
      retention_references: false,
      retention_select: true,
      retention_sequence_select: false,
      retention_sequence_usage: false,
      retention_sequence_update: false,
      retention_trigger: false,
      retention_truncate: false,
      retention_update: false,
      worker_sequence_any: false,
      worker_table_any: false,
    });

    const appPool = new Pool({
      connectionString: databaseUrl("classhub_app", "local_app_password"),
    });
    const retentionPool = new Pool({
      connectionString: databaseUrl("classhub_retention", "local_retention_password"),
    });
    try {
      const appInsert = await appPool.query<{ id: string }>(
        `
          INSERT INTO attendance_notifications (
            class_id, member_id, notification_date, notification_type, expected_time
          ) VALUES ($1, $2, DATE '2026-08-01', 'late', TIME '08:10')
          RETURNING id
        `,
        [activeClassId, studentMemberId],
      );
      await appPool.query(
        `
          UPDATE attendance_notifications
          SET notification_type = 'early', expected_time = TIME '14:10',
              updated_at = now(), row_version = row_version + 1
          WHERE id = $1
        `,
        [appInsert.rows[0]!.id],
      );
      await expectPostgresError(
        appPool.query("DELETE FROM attendance_notifications WHERE id = $1", [
          appInsert.rows[0]!.id,
        ]),
        "42501",
      );
      await expectPostgresError(
        appPool.query(
          `
            INSERT INTO operator_audit_logs (
              actor_type, action, target_type, target_id, after_json, run_id
            ) VALUES (
              'system', 'retention.executed', 'retention', 'global',
              '{"cutoff_at":"2026-06-16","table_name":"attendance_notifications","deleted_count":1}'::jsonb,
              '00000000-0000-4000-8000-000000006302'
            )
          `,
        ),
        "42501",
      );

      const retained = await retentionPool.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM attendance_notifications
          WHERE id = $1
        `,
        [appInsert.rows[0]!.id],
      );
      expect(retained.rows[0]?.count).toBe("1");
      await retentionPool.query("DELETE FROM attendance_notifications WHERE id = $1", [
        appInsert.rows[0]!.id,
      ]);
      await expectPostgresError(
        retentionPool.query(
          `
            INSERT INTO attendance_notifications (
              class_id, member_id, notification_date, notification_type, expected_time
            ) VALUES ($1, $2, DATE '2026-08-02', 'absent', NULL)
          `,
          [activeClassId, studentMemberId],
        ),
        "42501",
      );
      const retentionAudit = await retentionPool.query<{ id: string }>(
        `
          INSERT INTO operator_audit_logs (
            actor_type, action, target_type, target_id, after_json, run_id
          ) VALUES (
            'system', 'retention.executed', 'retention', 'global',
            '{"cutoff_at":"2026-06-16","table_name":"attendance_notifications","deleted_count":1}'::jsonb,
            $1
          ) RETURNING id
        `,
        [retentionRunId],
      );
      expect(retentionAudit.rowCount).toBe(1);
    } finally {
      await appPool.end();
      await retentionPool.end();
    }
  });

  it("refuses destructive down migration until rows are empty, then restores prior state", async () => {
    await expect(
      runner({
        count: 1,
        databaseUrl: migratorDatabaseUrl,
        direction: "down",
        dir: migrationsDirectory,
        migrationsTable: "pgmigrations",
        verbose: false,
      }),
    ).rejects.toThrow(/attendance_notifications to be empty/);

    const stillApplied = await bootstrapPool.query<{ count: string; table_name: string | null }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        to_regclass('public.attendance_notifications')::text AS table_name
    `);
    expect(stillApplied.rows[0]).toEqual({
      count: "7",
      table_name: "attendance_notifications",
    });

    await bootstrapPool.query("DELETE FROM attendance_notifications");
    await expect(
      runner({
        count: 1,
        databaseUrl: migratorDatabaseUrl,
        direction: "down",
        dir: migrationsDirectory,
        migrationsTable: "pgmigrations",
        verbose: false,
      }),
    ).rejects.toThrow(/attendance notification audit rows to be empty/);

    await bootstrapPool.query(
      "DELETE FROM audit_logs WHERE action LIKE 'attendance_notification.%'",
    );
    await runner({
      count: 1,
      databaseUrl: migratorDatabaseUrl,
      direction: "down",
      dir: migrationsDirectory,
      migrationsTable: "pgmigrations",
      verbose: false,
    });

    const restored = await bootstrapPool.query<{
      attendance_sequence: string | null;
      attendance_table: string | null;
      count: string;
      latest: string;
      notices: string;
      schedule_audits: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM pgmigrations) AS count,
        (SELECT max(name) FROM pgmigrations) AS latest,
        to_regclass('public.attendance_notifications')::text AS attendance_table,
        to_regclass('public.attendance_notifications_id_seq')::text AS attendance_sequence,
        (SELECT count(*)::text FROM notices) AS notices,
        (
          SELECT count(*)::text FROM audit_logs
          WHERE request_id = '${existingScheduleRequestId}'
        ) AS schedule_audits
    `);
    expect(restored.rows[0]).toEqual({
      attendance_sequence: null,
      attendance_table: null,
      count: "6",
      latest: "1783700005000_account-password-runtime-privilege",
      notices: "2",
      schedule_audits: "1",
    });

    const noticeIndex = await bootstrapPool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'notices_importance_index'
    `);
    expect(noticeIndex.rows[0]?.indexdef).toContain(
      "(class_id, is_important, published_at DESC, id DESC)",
    );
    expect(noticeIndex.rows[0]?.indexdef).not.toContain("is_important DESC");

    const retentionPrivileges = await bootstrapPool.query<{
      can_insert: boolean;
      can_use_sequence: boolean;
    }>(`
      SELECT
        has_table_privilege(
          'classhub_retention', 'operator_audit_logs', 'INSERT'
        ) AS can_insert,
        has_sequence_privilege(
          'classhub_retention', 'operator_audit_logs_id_seq', 'USAGE'
        ) AS can_use_sequence
    `);
    expect(retentionPrivileges.rows[0]).toEqual({
      can_insert: false,
      can_use_sequence: false,
    });

    await expectPostgresError(
      insertAttendanceAudit(
        "attendance_notification.created",
        "00000000-0000-4000-8000-000000006299",
        "99",
        {
          after: {
            attendance_notification_id: 99,
            notification_date: "2026-07-16",
            notification_type: "late",
            status: "pending",
          },
        },
      ),
      "23514",
    );
  });
});
