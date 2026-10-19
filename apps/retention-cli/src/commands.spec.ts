import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionDatabase } from "./database.js";
import { assertRetentionTargetAvailable, runRetentionCommand } from "./commands.js";
const mocks = vi.hoisted(() => ({
  attendance: vi.fn(),
  guardian: vi.fn(),
  layout: vi.fn(),
  assessments: vi.fn(),
  reminder: vi.fn(),
  mariaDelete: vi.fn(),
  mariaClassArchives: vi.fn(),
  mariaReminder: vi.fn(),
  mailEnvironment: vi.fn(),
  mailer: vi.fn(),
}));
vi.mock("./attendance-notification-retention.js", () => ({
  runAttendanceNotificationRetention: mocks.attendance,
}));
vi.mock("./guardian-consent-request-retention.js", () => ({
  runGuardianConsentRequestRetention: mocks.guardian,
}));
vi.mock("./layout-draft-autosave-retention.js", () => ({
  runLayoutDraftAutosaveRetention: mocks.layout,
}));
vi.mock("./student-assessment-retention.js", () => ({
  runStudentAssessmentRetention: mocks.assessments,
}));
vi.mock("./temporary-password-reminder.js", () => ({
  runTemporaryPasswordReminder: mocks.reminder,
}));
vi.mock("./mariadb/retention.js", () => ({ runMariaDbDeletionRetention: mocks.mariaDelete }));
vi.mock("./mariadb/class-archive-retention.js", () => ({
  runMariaDbClassArchiveRetention: mocks.mariaClassArchives,
}));
vi.mock("./mariadb/temporary-password-reminder.js", () => ({
  runMariaDbTemporaryPasswordReminder: mocks.mariaReminder,
}));
vi.mock("./environment.js", () => ({ loadReminderMailEnvironment: mocks.mailEnvironment }));
vi.mock("./temporary-password-reminder-mailer.js", () => ({
  SmtpTemporaryPasswordReminderMailer: mocks.mailer,
}));
const database = {} as RetentionDatabase;
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue({ capped: false });
});
const targets = [
  ["attendance-notifications", "attendance_notifications", mocks.attendance],
  ["guardian-consent-requests", "guardian_consent_requests", mocks.guardian],
  ["student-assessments", "student_assessment_records", mocks.assessments],
] as const;
describe("actual retention command dispatch", () => {
  it("dispatches class archive retention only for MariaDB", async () => {
    const command = { target: "class-archives", mode: "dry-run" } as const;
    expect(() => assertRetentionTargetAvailable(command, "postgres")).toThrow();
    await expect(runRetentionCommand(database, command, "postgres")).rejects.toThrow();
    await expect(runRetentionCommand(database, command, "mariadb")).rejects.toThrow();
    await runRetentionCommand(database, command, "mariadb", {
      classArchivesGrantProfile: "active",
    });
    expect(mocks.mariaClassArchives).toHaveBeenCalledExactlyOnceWith(database, { mode: "dry-run" });
    expect(mocks.mariaDelete).not.toHaveBeenCalled();
  });
  it("rejects retired MariaDB layout retention before opening or querying a database", async () => {
    const command = { target: "layout-draft-autosaves", mode: "execute" } as const;
    expect(() => assertRetentionTargetAvailable(command, "mariadb")).toThrow();
    await expect(runRetentionCommand(database, command, "mariadb")).rejects.toMatchObject({
      code: "RETENTION_MARIADB_FAILED",
      reason: "configuration",
    });
    expect(mocks.mariaDelete).not.toHaveBeenCalled();
    expect(mocks.layout).not.toHaveBeenCalled();
  });

  it("preserves retention for historical PostgreSQL layout data", async () => {
    await runRetentionCommand(
      database,
      { target: "layout-draft-autosaves", mode: "dry-run" },
      "postgres",
    );
    expect(mocks.layout).toHaveBeenCalledExactlyOnceWith(database, { mode: "dry-run" });
  });
  it.each(targets)(
    "routes %s to MariaDB without invoking the PG job",
    async (target, table, pg) => {
      await runRetentionCommand(database, { target, mode: "execute" }, "mariadb");
      expect(mocks.mariaDelete).toHaveBeenCalledExactlyOnceWith(database, table, {
        mode: "execute",
      });
      expect(pg).not.toHaveBeenCalled();
      expect(mocks.mailEnvironment).not.toHaveBeenCalled();
    },
  );
  it.each(targets)("preserves the original PG %s path", async (target, _table, pg) => {
    await runRetentionCommand(database, { target, mode: "dry-run" }, "postgres");
    expect(pg).toHaveBeenCalledExactlyOnceWith(database, { mode: "dry-run" });
    expect(mocks.mariaDelete).not.toHaveBeenCalled();
  });
  it.each(["postgres", "mariadb"] as const)(
    "keeps SMTP lazy for %s reminder dispatch",
    async (engine) => {
      await runRetentionCommand(
        database,
        { target: "temporary-password-reminders", mode: "dry-run" },
        engine,
      );
      const selected = engine === "mariadb" ? mocks.mariaReminder : mocks.reminder;
      expect(selected).toHaveBeenCalledExactlyOnceWith(database, {
        createMailer: expect.any(Function),
        mode: "dry-run",
      });
      expect(mocks.mailEnvironment).not.toHaveBeenCalled();
      expect(mocks.mailer).not.toHaveBeenCalled();
    },
  );
  it("sanitizes MariaDB errors at the actual command boundary without fallback or retry", async () => {
    mocks.mariaDelete.mockRejectedValue(
      Object.assign(new Error("private SQL secret"), { errno: 1213 }),
    );
    const error = await runRetentionCommand(
      database,
      { target: "student-assessments", mode: "execute" },
      "mariadb",
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "RETENTION_MARIADB_FAILED", reason: "job" });
    expect(String(error) + JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(mocks.mariaDelete).toHaveBeenCalledTimes(1);
    expect(mocks.assessments).not.toHaveBeenCalled();
  });
});
