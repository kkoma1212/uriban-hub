import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { RetentionDatabase } from "../database.js";
import type { ReminderRunAudit } from "../job-audit.js";
import { RetentionMariaDbError } from "./errors.js";

export async function recordMariaDbAudit(
  database: RetentionDatabase,
  action: "retention.executed" | "job.failed" | "reminder.executed",
  target: string,
  after: object,
  runId: string = randomUUID(),
  createdAt?: string,
): Promise<void> {
  await sql`INSERT INTO operator_audit_logs (actor_type, action, target_type, target_id, after_json, run_id, created_at)
    VALUES ('system', ${action}, 'retention', ${target}, ${JSON.stringify(after)}, ${runId}, ${createdAt ?? sql`UTC_TIMESTAMP(6)`})`.execute(
    database,
  );
}

export async function recordMariaDbJobFailure(
  database: RetentionDatabase,
  jobName: string,
  error: unknown,
): Promise<void> {
  // Native names and accessors can contain SQL/paths; only local fixed names reach JSON.
  const errorName =
    error instanceof RetentionMariaDbError
      ? "RetentionMariaDbError"
      : error instanceof Error
        ? "Error"
        : "UnknownError";
  await recordMariaDbAudit(database, "job.failed", jobName, {
    job_name: jobName,
    error_name: errorName,
  });
}

export async function recordMariaDbReminderRun(
  database: RetentionDatabase,
  audit: ReminderRunAudit,
): Promise<void> {
  await recordMariaDbAudit(database, "reminder.executed", "temporary_password_reminders", {
    eligible_count: audit.eligibleCount,
    sent_count: audit.sentCount,
    failed_count: audit.failedCount,
    window_ends_at: audit.windowEndsAt,
  });
}
