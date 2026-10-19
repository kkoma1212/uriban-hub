import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type { RetentionDatabase } from "../database.js";
import type { StudentAssessmentRetentionOptions } from "../student-assessment-retention.js";
import { RetentionMariaDbError } from "./errors.js";
import { recordMariaDbAudit } from "./job-audit.js";
import {
  acquireRetentionLock,
  retentionLockDigest,
  type RetentionLockTable,
} from "./retention-lock.js";
import { countValue, dateValue, positiveInteger, sqlDate } from "./values.js";

type Clock = { started_at: string; cutoff_at: string; job_server_today?: string };
const columns = {
  attendance_notifications: "notification_date",
  guardian_consent_requests: "requested_at",
  student_assessment_records: "expires_at",
} as const;

async function databaseClock(
  database: RetentionDatabase,
  table: RetentionLockTable,
): Promise<Clock> {
  // First statement after BEGIN, before waiting for the lock. MariaDB has no native PG
  // transaction_timestamp: the BEGIN-to-first-SELECT gap remains an explicit QA boundary.
  if (table === "attendance_notifications") {
    const result = await sql<Clock>`SELECT
      DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS started_at,
      DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR, '%Y-%m-%d') AS job_server_today,
      DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR - INTERVAL 365 DAY, '%Y-%m-%d') AS cutoff_at`.execute(
      database,
    );
    const clock = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !clock ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(clock.cutoff_at) ||
      typeof clock.job_server_today !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(clock.job_server_today)
    )
      throw new RetentionMariaDbError("invalid_result");
    dateValue(clock.started_at);
    dateValue(`${clock.cutoff_at} 00:00:00.000000`);
    dateValue(`${clock.job_server_today} 00:00:00.000000`);
    return clock;
  }
  const age = table === "student_assessment_records" ? sql`` : sql`- INTERVAL 7 DAY`;
  const result = await sql<{ started_at: string; cutoff_at: string }>`SELECT
    DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS started_at,
    DATE_FORMAT(UTC_TIMESTAMP(6) ${age}, '%Y-%m-%d %H:%i:%s.%f') AS cutoff_at`.execute(database);
  if (result.rows.length !== 1) throw new RetentionMariaDbError("invalid_result");
  // Original PG parser returns Date; truncate only here to preserve its inclusive ms boundary.
  dateValue(result.rows[0]?.started_at);
  return {
    started_at: result.rows[0]!.started_at,
    cutoff_at: dateValue(result.rows[0]?.cutoff_at).toISOString(),
  };
}

function predicate(table: RetentionLockTable, clock: Clock): RawBuilder<unknown> {
  const cutoff =
    table === "attendance_notifications" ? clock.cutoff_at : sqlDate(new Date(clock.cutoff_at));
  const comparison = table === "attendance_notifications" ? sql`<` : sql`<=`;
  const unattached = table === "guardian_consent_requests" ? sql`user_id IS NULL AND` : sql``;
  return sql`${unattached} ${sql.ref(columns[table])} ${comparison} ${cutoff}`;
}

async function eligibleCount(
  database: RetentionDatabase,
  table: RetentionLockTable,
  clock: Clock,
): Promise<number> {
  const result = await sql<{
    count: string;
  }>`SELECT CAST(COUNT(*) AS CHAR) AS count FROM ${sql.table(table)} WHERE ${predicate(table, clock)}`.execute(
    database,
  );
  if (result.rows.length !== 1) throw new RetentionMariaDbError("invalid_result");
  return countValue(result.rows[0]?.count);
}

/** Three retained delete jobs, one transaction per execute, no retry or runtime seed writes. */
export async function runMariaDbDeletionRetention(
  database: RetentionDatabase,
  table: RetentionLockTable,
  options: StudentAssessmentRetentionOptions,
) {
  retentionLockDigest(table); // Reject unregistered table input before building identifiers.
  const batchSize = positiveInteger(options.batchSize ?? 500, "batchSize");
  const maxBatches = positiveInteger(options.maxBatches ?? 20, "maxBatches");
  if (options.mode !== "dry-run" && options.mode !== "execute")
    throw new RetentionMariaDbError("invalid_mode");
  if (options.mode === "dry-run") {
    const clock = await databaseClock(database, table);
    const { started_at: _startedAt, ...publicClock } = clock;
    const count = await eligibleCount(database, table, clock);
    return {
      ...publicClock,
      capped: false,
      deleted_count: 0,
      eligible_count: count,
      mode: options.mode,
      remaining_eligible_count: count,
      run_id: null,
      table_name: table,
    };
  }
  const runId = options.runId ?? randomUUID();
  return database.transaction().execute(async (transaction) => {
    const clock = await databaseClock(transaction, table);
    const { started_at: startedAt, ...publicClock } = clock;
    await acquireRetentionLock(transaction, table);
    const initialEligible = await eligibleCount(transaction, table, clock);
    let deletedCount = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Single-table ordered DELETE rechecks eligibility under row locks. No RETURNING/CTE
      // emulation or SKIP LOCKED: all batches and the audit commit or roll back together.
      // Native Maria UUID ordering is not PG UUID byte ordering. Canonical UUID text
      // keeps the original deterministic guardian tie-breaker; other IDs are BIGINT.
      const idOrder =
        table === "guardian_consent_requests" ? sql`CAST(id AS CHAR) COLLATE utf8mb4_bin` : sql`id`;
      const result = await sql`DELETE FROM ${sql.table(table)} WHERE ${predicate(table, clock)}
        ORDER BY ${sql.ref(columns[table])}, ${idOrder} LIMIT ${batchSize}`.execute(transaction);
      const deleted = countValue(result.numAffectedRows);
      if (deleted > batchSize) throw new RetentionMariaDbError("invalid_result");
      deletedCount += deleted;
      if (!Number.isSafeInteger(deletedCount)) throw new RetentionMariaDbError("invalid_result");
      if (deleted < batchSize) break;
    }
    const remainingEligible = await eligibleCount(transaction, table, clock);
    await recordMariaDbAudit(
      transaction,
      "retention.executed",
      table,
      { cutoff_at: clock.cutoff_at, table_name: table, deleted_count: deletedCount },
      runId,
      startedAt,
    );
    return {
      ...publicClock,
      capped: remainingEligible > 0,
      deleted_count: deletedCount,
      eligible_count: initialEligible,
      mode: options.mode,
      remaining_eligible_count: remainingEligible,
      run_id: runId,
      table_name: table,
    };
  });
}
