import { runAttendanceNotificationRetention } from "./attendance-notification-retention.js";
import type { RetentionDatabase } from "./database.js";
import type { RetentionCommand } from "./cli-arguments.js";
import { loadReminderMailEnvironment, type RetentionEnvironment } from "./environment.js";
import { runGuardianConsentRequestRetention } from "./guardian-consent-request-retention.js";
import { runLayoutDraftAutosaveRetention } from "./layout-draft-autosave-retention.js";
import { runStudentAssessmentRetention } from "./student-assessment-retention.js";
import { SmtpTemporaryPasswordReminderMailer } from "./temporary-password-reminder-mailer.js";
import { runTemporaryPasswordReminder } from "./temporary-password-reminder.js";
import { runMariaDbDeletionRetention } from "./mariadb/retention.js";
import { runMariaDbPolicyRetention } from "./mariadb/policy-retention.js";
import { runMariaDbTemporaryPasswordReminder } from "./mariadb/temporary-password-reminder.js";
import { RetentionMariaDbError } from "./mariadb/errors.js";
import { runMariaDbClassArchiveRetention } from "./mariadb/class-archive-retention.js";

const mariaTables = {
  "attendance-notifications": "attendance_notifications",
  "guardian-consent-requests": "guardian_consent_requests",
  "student-assessments": "student_assessment_records",
} as const;

export function assertRetentionTargetAvailable(
  command: RetentionCommand,
  engine: RetentionEnvironment["databaseEngine"],
): void {
  if (engine === "mariadb" && command.target === "layout-draft-autosaves") {
    throw new RetentionMariaDbError("configuration");
  }
  // 처리방침 보관기간 작업(2026-10-03)은 운영 DB인 MariaDB에만 만들었다.
  if (engine !== "mariadb" && ["policy-records", "class-archives"].includes(command.target)) {
    throw new RetentionMariaDbError("configuration");
  }
}

export async function runRetentionCommand(
  database: RetentionDatabase,
  command: RetentionCommand,
  engine: RetentionEnvironment["databaseEngine"],
  options: {
    mailLogsGrantInstalled?: boolean;
    auditConsentsGrantInstalled?: boolean;
    adminRecordsGrantInstalled?: boolean;
    classArchivesGrantProfile?: "none" | "active" | "legacy";
  } = {},
) {
  // This factory is invoked only in reminder execute, after the read; dry-run needs no SMTP env.
  const reminderOptions = {
    createMailer: () => new SmtpTemporaryPasswordReminderMailer(loadReminderMailEnvironment()),
    mode: command.mode,
  };
  if (engine === "mariadb") {
    // P-016 removes layout drafts from the MariaDB product and its retention jobs.
    if (command.target === "layout-draft-autosaves")
      throw new RetentionMariaDbError("configuration");
    try {
      if (command.target === "class-archives") {
        if (
          options.classArchivesGrantProfile !== "active" &&
          options.classArchivesGrantProfile !== "legacy"
        )
          throw new RetentionMariaDbError("configuration");
        return await runMariaDbClassArchiveRetention(database, { mode: command.mode });
      }
      if (command.target === "policy-records")
        return await runMariaDbPolicyRetention(database, {
          mode: command.mode,
          includeMailLogs: options.mailLogsGrantInstalled === true,
          includeAuditConsents: options.auditConsentsGrantInstalled === true,
          includeAdminRecords: options.adminRecordsGrantInstalled === true,
        });
      return command.target === "temporary-password-reminders"
        ? await runMariaDbTemporaryPasswordReminder(database, reminderOptions)
        : await runMariaDbDeletionRetention(database, mariaTables[command.target], {
            mode: command.mode,
          });
    } catch {
      // main/failure audit receives no native SQL text, identifier, URL or diagnostic cause.
      throw new RetentionMariaDbError("job");
    }
  }
  if (
    engine !== "postgres" ||
    command.target === "policy-records" ||
    command.target === "class-archives"
  )
    throw new RetentionMariaDbError("configuration");
  if (command.target === "attendance-notifications")
    return runAttendanceNotificationRetention(database, { mode: command.mode });
  if (command.target === "guardian-consent-requests")
    return runGuardianConsentRequestRetention(database, { mode: command.mode });
  if (command.target === "layout-draft-autosaves")
    return runLayoutDraftAutosaveRetention(database, { mode: command.mode });
  if (command.target === "temporary-password-reminders")
    return runTemporaryPasswordReminder(database, reminderOptions);
  return runStudentAssessmentRetention(database, { mode: command.mode });
}
