import { randomUUID } from "node:crypto";

import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RetentionDatabase } from "./database.js";
import type { RetentionMode } from "./student-assessment-retention.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;
const RETENTION_LOCK_KEY = "classhub.attendance_notifications.retention.v1";
type RetentionQueryDatabase = Kysely<DB> | Transaction<DB>;

export interface AttendanceNotificationRetentionOptions {
  batchSize?: number;
  maxBatches?: number;
  mode: RetentionMode;
  runId?: string;
}

export interface AttendanceNotificationRetentionResult {
  capped: boolean;
  cutoff_at: string;
  deleted_count: number;
  eligible_count: number;
  job_server_today: string;
  mode: RetentionMode;
  remaining_eligible_count: number;
  run_id: string | null;
  table_name: "attendance_notifications";
}

interface AttendanceRetentionClock {
  cutoff_at: string;
  job_server_today: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

async function databaseClock(
  database: RetentionQueryDatabase,
  transactionClock: boolean,
): Promise<AttendanceRetentionClock> {
  const timestampExpression = transactionClock
    ? sql`transaction_timestamp()`
    : sql`clock_timestamp()`;
  const result = await sql<AttendanceRetentionClock>`
    WITH job_clock AS (
      SELECT (${timestampExpression} AT TIME ZONE 'Asia/Seoul')::date AS job_server_today
    )
    SELECT
      to_char(job_server_today, 'YYYY-MM-DD') AS job_server_today,
      to_char(job_server_today - 365, 'YYYY-MM-DD') AS cutoff_at
    FROM job_clock
  `.execute(database);
  return result.rows[0]!;
}

async function eligibleCount(
  database: RetentionQueryDatabase,
  cutoffDate: string,
): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM attendance_notifications
    WHERE notification_date < ${cutoffDate}::date
  `.execute(database);
  return Number(result.rows[0]!.count);
}

export async function runAttendanceNotificationRetention(
  database: RetentionDatabase,
  options: AttendanceNotificationRetentionOptions,
): Promise<AttendanceNotificationRetentionResult> {
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = positiveInteger(options.maxBatches ?? DEFAULT_MAX_BATCHES, "maxBatches");

  if (options.mode === "dry-run") {
    const clock = await databaseClock(database, false);
    const count = await eligibleCount(database, clock.cutoff_at);
    return {
      capped: false,
      cutoff_at: clock.cutoff_at,
      deleted_count: 0,
      eligible_count: count,
      job_server_today: clock.job_server_today,
      mode: "dry-run",
      remaining_eligible_count: count,
      run_id: null,
      table_name: "attendance_notifications",
    };
  }

  const runId = options.runId ?? randomUUID();
  return database.transaction().execute(async (transaction) => {
    await sql`
      SELECT pg_advisory_xact_lock(hashtext(${RETENTION_LOCK_KEY}))
    `.execute(transaction);
    const clock = await databaseClock(transaction, true);
    const initialEligible = await eligibleCount(transaction, clock.cutoff_at);
    let deletedCount = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await sql<{ deleted_count: string }>`
        WITH candidates AS (
          SELECT id
          FROM attendance_notifications
          WHERE notification_date < ${clock.cutoff_at}::date
          ORDER BY notification_date, id
          LIMIT ${batchSize}
        ),
        deleted AS (
          DELETE FROM attendance_notifications AS notifications
          USING candidates
          WHERE notifications.id = candidates.id
            AND notifications.notification_date < ${clock.cutoff_at}::date
          RETURNING notifications.id
        )
        SELECT count(*)::text AS deleted_count
        FROM deleted
      `.execute(transaction);
      const batchDeleted = Number(result.rows[0]!.deleted_count);
      deletedCount += batchDeleted;
      if (batchDeleted < batchSize) break;
    }

    const remainingEligible = await eligibleCount(transaction, clock.cutoff_at);
    await sql`
      INSERT INTO operator_audit_logs (
        actor_type,
        action,
        target_type,
        target_id,
        after_json,
        run_id
      ) VALUES (
        'system',
        'retention.executed',
        'retention',
        'attendance_notifications',
        jsonb_build_object(
          'cutoff_at', ${clock.cutoff_at}::text,
          'table_name', 'attendance_notifications',
          'deleted_count', ${deletedCount}::integer
        ),
        ${runId}::uuid
      )
    `.execute(transaction);

    return {
      capped: remainingEligible > 0,
      cutoff_at: clock.cutoff_at,
      deleted_count: deletedCount,
      eligible_count: initialEligible,
      job_server_today: clock.job_server_today,
      mode: "execute",
      remaining_eligible_count: remainingEligible,
      run_id: runId,
      table_name: "attendance_notifications",
    };
  });
}
