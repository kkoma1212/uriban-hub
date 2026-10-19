import { sql } from "kysely";
import type { RetentionDatabase } from "../database.js";
import type {
  TemporaryPasswordReminderOptions,
  TemporaryPasswordReminderResult,
} from "../temporary-password-reminder.js";
import { RetentionMariaDbError } from "./errors.js";
import { recordMariaDbReminderRun } from "./job-audit.js";
import { dateValue, positiveInteger, sqlDate } from "./values.js";

/** Preserve the original host-clock window and send-then-mark policy; no transaction spans SMTP. */
export async function runMariaDbTemporaryPasswordReminder(
  database: RetentionDatabase,
  options: TemporaryPasswordReminderOptions,
): Promise<TemporaryPasswordReminderResult> {
  const windowHours = positiveInteger(options.windowHours ?? 24, "windowHours");
  const maxRecipients = positiveInteger(options.maxRecipients ?? 500, "maxRecipients");
  const now = new Date((options.now ?? new Date()).getTime());
  const windowEndsAt = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(windowEndsAt.getTime()) ||
    !Number.isSafeInteger(maxRecipients + 1)
  )
    throw new RetentionMariaDbError("invalid_input");
  if (options.mode !== "dry-run" && options.mode !== "execute")
    throw new RetentionMariaDbError("invalid_mode");
  const candidates = await sql<{ email_normalized: string; expires_at: string; user_id: string }>`
    SELECT users.email_normalized,
      DATE_FORMAT(teacher_profiles.temporary_password_expires_at, '%Y-%m-%d %H:%i:%s.%f') AS expires_at,
      CAST(teacher_profiles.user_id AS CHAR) AS user_id
    FROM teacher_profiles JOIN users ON users.id=teacher_profiles.user_id
    WHERE teacher_profiles.status='active' AND teacher_profiles.temporary_password_must_change=TRUE
      AND teacher_profiles.temporary_password_expires_at IS NOT NULL
      AND teacher_profiles.temporary_password_expires_at > ${sqlDate(now)}
      AND teacher_profiles.temporary_password_expires_at <= ${sqlDate(windowEndsAt)}
      AND teacher_profiles.temporary_password_reminder_sent_at IS NULL
      AND users.is_active=TRUE AND users.deleted_at IS NULL
    ORDER BY teacher_profiles.temporary_password_expires_at ASC LIMIT ${maxRecipients + 1}
  `.execute(database);
  const capped = candidates.rows.length > maxRecipients;
  const recipients = candidates.rows.slice(0, maxRecipients).map((row) => {
    if (
      typeof row.email_normalized !== "string" ||
      typeof row.user_id !== "string" ||
      !/^[1-9]\d*$/u.test(row.user_id) ||
      BigInt(row.user_id) > 9223372036854775807n
    )
      throw new RetentionMariaDbError("invalid_result");
    return { ...row, expires_at: dateValue(row.expires_at) };
  });
  const result: TemporaryPasswordReminderResult = {
    capped,
    eligible_count: recipients.length,
    failed_count: 0,
    mode: options.mode,
    sent_count: 0,
    table_name: "teacher_profiles",
    window_ends_at: windowEndsAt.toISOString(),
  };
  if (options.mode === "dry-run") return result;
  const mailer = options.createMailer();
  for (const recipient of recipients) {
    try {
      await mailer.sendExpiryReminder(recipient.email_normalized, recipient.expires_at);
    } catch {
      result.failed_count += 1;
      continue;
    }
    await sql`UPDATE teacher_profiles SET temporary_password_reminder_sent_at=${sqlDate(now)}
      WHERE user_id=${recipient.user_id} AND temporary_password_reminder_sent_at IS NULL`.execute(
      database,
    );
    result.sent_count += 1;
  }
  await recordMariaDbReminderRun(database, {
    eligibleCount: result.eligible_count,
    failedCount: result.failed_count,
    sentCount: result.sent_count,
    windowEndsAt: result.window_ends_at,
  });
  return result;
}
