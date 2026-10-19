import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openRetentionDatabase, type RetentionDatabase } from "./database.js";
import { runAttendanceNotificationRetention } from "./attendance-notification-retention.js";
import { recordJobFailure } from "./job-audit.js";
import { runStudentAssessmentRetention } from "./student-assessment-retention.js";
import type { TemporaryPasswordReminderMailer } from "./temporary-password-reminder-mailer.js";
import { runTemporaryPasswordReminder } from "./temporary-password-reminder.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let container: StartedNativeTestService;
let retentionDatabase: RetentionDatabase;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(databaseUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql`
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )
    `.execute(migrator);
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9-]+\.sql$/u.test(name))
      .sort();
    for (const name of migrationNames) {
      const migration = await readFile(`${migrationsDirectory}/${name}`, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  bootstrapDatabase = createDatabase<DB>(
    databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();
  retentionDatabase = await openRetentionDatabase(
    databaseUrl("classhub_retention", "local_retention_password"),
  );
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([retentionDatabase?.destroy(), bootstrapDatabase?.destroy()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("student assessment retention executor", () => {
  it("requires the attested retention role", async () => {
    await expect(
      openRetentionDatabase(databaseUrl("classhub_app", "local_app_password")),
    ).rejects.toThrow("classhub_retention");
  });

  it("keeps dry-run read-only, deletes in capped batches, and audits without student data", async () => {
    const owner = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "보존기간 학생",
        email_normalized: "retention-assessment@example.com",
        email_verified_at: sql<Date>`clock_timestamp()`,
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const privateMarker = "PRIVATE-SCORE-MARKER";
    for (let index = 0; index < 3; index += 1) {
      await bootstrapDatabase
        .insertInto("student_assessment_records")
        .values({
          created_at: sql<Date>`clock_timestamp() - interval '60 days'`,
          expires_at: sql<Date>`clock_timestamp() - interval '1 day'`,
          owner_user_id: owner.id,
          score_hundredths: 9_000 + index,
          subject: privateMarker,
          title: `만료 평가 ${index}`,
          updated_at: sql<Date>`clock_timestamp() - interval '1 day'`,
        })
        .execute();
    }
    await bootstrapDatabase
      .insertInto("student_assessment_records")
      .values({
        expires_at: sql<Date>`clock_timestamp() + interval '1 day'`,
        owner_user_id: owner.id,
        subject: "유효 기록",
        title: "삭제되면 안 되는 평가",
      })
      .execute();

    const dryRun = await runStudentAssessmentRetention(retentionDatabase, {
      mode: "dry-run",
    });
    expect(dryRun).toMatchObject({
      capped: false,
      deleted_count: 0,
      eligible_count: 3,
      mode: "dry-run",
      remaining_eligible_count: 3,
      run_id: null,
    });
    const afterDryRun = await bootstrapDatabase
      .selectFrom("student_assessment_records")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("owner_user_id", "=", owner.id)
      .executeTakeFirstOrThrow();
    expect(afterDryRun.count).toBe("4");

    const firstRun = await runStudentAssessmentRetention(retentionDatabase, {
      batchSize: 2,
      maxBatches: 1,
      mode: "execute",
      runId: "20000000-0000-4000-8000-000000000001",
    });
    expect(firstRun).toMatchObject({
      capped: true,
      deleted_count: 2,
      eligible_count: 3,
      remaining_eligible_count: 1,
    });

    const secondRun = await runStudentAssessmentRetention(retentionDatabase, {
      mode: "execute",
      runId: "20000000-0000-4000-8000-000000000002",
    });
    expect(secondRun).toMatchObject({
      capped: false,
      deleted_count: 1,
      eligible_count: 1,
      remaining_eligible_count: 0,
    });

    const [remainingRecords, audits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("student_assessment_records")
        .select(["subject", "title"])
        .where("owner_user_id", "=", owner.id)
        .execute(),
      bootstrapDatabase
        .selectFrom("operator_audit_logs")
        .select([
          "action",
          "actor_type",
          "after_json",
          "before_json",
          "operator_id",
          "target_id",
          "target_type",
        ])
        .where("run_id", "in", [
          "20000000-0000-4000-8000-000000000001",
          "20000000-0000-4000-8000-000000000002",
        ])
        .orderBy("run_id")
        .execute(),
    ]);
    expect(remainingRecords).toEqual([{ subject: "유효 기록", title: "삭제되면 안 되는 평가" }]);
    expect(audits).toHaveLength(2);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "retention.executed",
        actor_type: "system",
        after_json: expect.objectContaining({
          deleted_count: 2,
          table_name: "student_assessment_records",
        }),
        before_json: null,
        operator_id: null,
        target_id: "student_assessment_records",
        target_type: "retention",
      }),
      expect.objectContaining({
        action: "retention.executed",
        actor_type: "system",
        after_json: expect.objectContaining({
          deleted_count: 1,
          table_name: "student_assessment_records",
        }),
      }),
    ]);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(privateMarker);
    expect(serializedAudits).not.toContain("retention-assessment@example.com");
    expect(serializedAudits).not.toContain("owner_user_id");
    for (const audit of audits) {
      expect(Object.keys(audit.after_json as Record<string, unknown>).sort()).toEqual([
        "cutoff_at",
        "deleted_count",
        "table_name",
      ]);
    }
  });
});

describe.sequential("attendance notification retention executor", () => {
  it("fixes one KST cutoff, keeps dry-run read-only, and preserves the exact 365-day boundary", async () => {
    const fixture = await bootstrapDatabase.transaction().execute(async (transaction) => {
      const studentUser = await transaction
        .insertInto("users")
        .values({
          display_name: "출결 보존 학생",
          email_normalized: "retention-attendance@example.com",
          email_verified_at: sql<Date>`clock_timestamp()`,
          password_hash: "fixture-password-hash",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const teacherUser = await transaction
        .insertInto("users")
        .values({
          display_name: "출결 보존 교사",
          email_normalized: "retention-attendance-teacher@example.com",
          email_verified_at: sql<Date>`clock_timestamp()`,
          password_hash: "fixture-password-hash",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const operator = await transaction
        .insertInto("operators")
        .values({
          credential_hash: createHash("sha256").update("retention-attendance-operator").digest(),
          email_normalized: "retention-attendance-operator@example.com",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("teacher_profiles")
        .values({
          created_by_operator_id: operator.id,
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
          user_id: teacherUser.id,
        })
        .execute();
      await transaction
        .insertInto("schools")
        .values({
          edu_office_code: "B10",
          edu_office_name: "보존 테스트 교육청",
          region_name: "서울",
          school_code: "8999999",
          school_kind: "high",
          school_name: "출결 보존 테스트 학교",
        })
        .execute();
      const targetClass = await transaction
        .insertInto("classes")
        .values({
          academic_year: 2026,
          created_by_user_id: teacherUser.id,
          edu_office_code: "B10",
          expected_student_count: 1,
          grade: 2,
          name: "출결 보존반",
          school_code: "8999999",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("class_members")
        .values({
          class_id: targetClass.id,
          role: "teacher",
          status: "approved",
          user_id: teacherUser.id,
        })
        .execute();
      const member = await transaction
        .insertInto("class_members")
        .values({
          class_id: targetClass.id,
          role: "student",
          status: "approved",
          student_number: 1,
          user_id: studentUser.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { classId: targetClass.id, memberId: member.id };
    });

    for (const [daysAgo, notificationType, expectedTime] of [
      [367, "late", "08:10"],
      [366, "absent", null],
      [365, "early", "14:10"],
      [364, "late", "08:20"],
    ] as const) {
      await bootstrapDatabase
        .insertInto("attendance_notifications")
        .values({
          class_id: fixture.classId,
          expected_time: expectedTime,
          member_id: fixture.memberId,
          notification_date: sql<Date>`
            (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date - ${daysAgo}::integer
          `,
          notification_type: notificationType,
        })
        .execute();
    }

    const expectedClock = await bootstrapDatabase
      .selectNoFrom([
        sql<string>`to_char(
          (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,
          'YYYY-MM-DD'
        )`.as("job_server_today"),
        sql<string>`to_char(
          (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date - 365,
          'YYYY-MM-DD'
        )`.as("cutoff_at"),
      ])
      .executeTakeFirstOrThrow();

    const dryRun = await runAttendanceNotificationRetention(retentionDatabase, {
      mode: "dry-run",
    });
    expect(dryRun).toMatchObject({
      capped: false,
      cutoff_at: expectedClock.cutoff_at,
      deleted_count: 0,
      eligible_count: 2,
      job_server_today: expectedClock.job_server_today,
      mode: "dry-run",
      remaining_eligible_count: 2,
      run_id: null,
      table_name: "attendance_notifications",
    });
    expect(
      await bootstrapDatabase
        .selectFrom("attendance_notifications")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("class_id", "=", fixture.classId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "4" });

    const firstRun = await runAttendanceNotificationRetention(retentionDatabase, {
      batchSize: 1,
      maxBatches: 1,
      mode: "execute",
      runId: "30000000-0000-4000-8000-000000000001",
    });
    expect(firstRun).toMatchObject({
      capped: true,
      cutoff_at: expectedClock.cutoff_at,
      deleted_count: 1,
      eligible_count: 2,
      remaining_eligible_count: 1,
    });

    const secondRun = await runAttendanceNotificationRetention(retentionDatabase, {
      mode: "execute",
      runId: "30000000-0000-4000-8000-000000000002",
    });
    expect(secondRun).toMatchObject({
      capped: false,
      cutoff_at: expectedClock.cutoff_at,
      deleted_count: 1,
      eligible_count: 1,
      remaining_eligible_count: 0,
    });

    const [remainingRows, audits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("attendance_notifications")
        .select([
          sql<string>`to_char(notification_date, 'YYYY-MM-DD')`.as("notification_date"),
          "notification_type",
        ])
        .where("class_id", "=", fixture.classId)
        .orderBy("notification_date", "asc")
        .execute(),
      bootstrapDatabase
        .selectFrom("operator_audit_logs")
        .select(["action", "after_json", "target_id", "target_type"])
        .where("run_id", "in", [
          "30000000-0000-4000-8000-000000000001",
          "30000000-0000-4000-8000-000000000002",
        ])
        .orderBy("run_id")
        .execute(),
    ]);
    expect(remainingRows).toEqual([
      {
        notification_date: expect.any(String),
        notification_type: "early",
      },
      {
        notification_date: expect.any(String),
        notification_type: "late",
      },
    ]);
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        action: "retention.executed",
        after_json: {
          cutoff_at: expectedClock.cutoff_at,
          deleted_count: 1,
          table_name: "attendance_notifications",
        },
        target_id: "attendance_notifications",
        target_type: "retention",
      });
      expect(Object.keys(audit.after_json as Record<string, unknown>).sort()).toEqual([
        "cutoff_at",
        "deleted_count",
        "table_name",
      ]);
    }
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain("retention-attendance@example.com");
    expect(serializedAudits).not.toContain("notification_type");
    expect(serializedAudits).not.toContain("expected_time");
  });
});

describe.sequential("temporary password reminder executor", () => {
  // 메일러를 인터페이스로 받으므로 SMTP 컨테이너 없이 발송을 관찰할 수 있다.
  class RecordingMailer implements TemporaryPasswordReminderMailer {
    readonly sent: { email: string; expiresAt: Date }[] = [];

    constructor(private readonly rejectFor: readonly string[] = []) {}

    async sendExpiryReminder(email: string, expiresAt: Date): Promise<void> {
      if (this.rejectFor.includes(email)) throw new Error("smtp refused the recipient");
      this.sent.push({ email, expiresAt });
    }
  }

  async function createOperator(): Promise<string> {
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        // operators_credential_hash_check가 정확히 32바이트를 요구한다.
        credential_hash: createHash("sha256").update("reminder-operator").digest(),
        email_normalized: "reminder-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return operator.id;
  }

  async function createTeacher(
    email: string,
    expiresAt: Date,
    operatorId: string,
  ): Promise<string> {
    const user = await bootstrapDatabase
      .insertInto("users")
      .values({
        // users_display_name_check가 2~20자를 요구하므로 이메일을 붙이지 않는다.
        display_name: "임시비번 담임",
        email_normalized: email,
        email_verified_at: sql<Date>`clock_timestamp()`,
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operatorId,
        temporary_password_expires_at: expiresAt,
        temporary_password_must_change: true,
        user_id: user.id,
      })
      .execute();
    return String(user.id);
  }

  async function reminderSentAt(userId: string): Promise<Date | null> {
    const profile = await bootstrapDatabase
      .selectFrom("teacher_profiles")
      .select("temporary_password_reminder_sent_at")
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    return profile.temporary_password_reminder_sent_at;
  }

  it("reminds once inside the window, ignores expired and distant teachers, and retries a refused send", async () => {
    const now = new Date();
    const hours = (count: number): Date => new Date(now.getTime() + count * 60 * 60 * 1_000);
    const operatorId = await createOperator();

    // 창 안(6시간 뒤 만료) — 대상.
    const soonUserId = await createTeacher("reminder-soon@example.com", hours(6), operatorId);
    // 창 밖(48시간 뒤) — 아직 알릴 때가 아니다.
    const distantUserId = await createTeacher(
      "reminder-distant@example.com",
      hours(48),
      operatorId,
    );
    // 이미 만료 — 안내해봐야 할 수 있는 일이 없으므로 대상이 아니다.
    const expiredUserId = await createTeacher(
      "reminder-expired@example.com",
      hours(-2),
      operatorId,
    );
    // 창 안이지만 SMTP가 거절할 주소.
    const refusedUserId = await createTeacher("reminder-refused@example.com", hours(5), operatorId);

    const dryRunMailer = new RecordingMailer();
    const dryRun = await runTemporaryPasswordReminder(retentionDatabase, {
      createMailer: () => dryRunMailer,
      mode: "dry-run",
      now,
    });
    expect(dryRun).toMatchObject({ eligible_count: 2, failed_count: 0, sent_count: 0 });
    expect(dryRunMailer.sent).toHaveLength(0);
    // dry-run은 읽기 전용이어야 한다 — 표시가 남으면 실제 안내가 영영 안 간다.
    expect(await reminderSentAt(soonUserId)).toBeNull();

    const executeMailer = new RecordingMailer(["reminder-refused@example.com"]);
    const executed = await runTemporaryPasswordReminder(retentionDatabase, {
      createMailer: () => executeMailer,
      mode: "execute",
      now,
    });
    expect(executed).toMatchObject({ eligible_count: 2, failed_count: 1, sent_count: 1 });
    expect(executeMailer.sent.map((message) => message.email)).toEqual([
      "reminder-soon@example.com",
    ]);
    expect(await reminderSentAt(soonUserId)).not.toBeNull();
    expect(await reminderSentAt(distantUserId)).toBeNull();
    expect(await reminderSentAt(expiredUserId)).toBeNull();
    // 거절된 교사는 표시하지 않아야 다음 실행에서 다시 시도된다.
    expect(await reminderSentAt(refusedUserId)).toBeNull();

    const retryMailer = new RecordingMailer();
    const retried = await runTemporaryPasswordReminder(retentionDatabase, {
      createMailer: () => retryMailer,
      mode: "execute",
      now,
    });
    // 이미 보낸 교사는 빠지고 거절됐던 교사만 남는다 — 반복 발송 방지.
    expect(retried).toMatchObject({ eligible_count: 1, failed_count: 0, sent_count: 1 });
    expect(retryMailer.sent.map((message) => message.email)).toEqual([
      "reminder-refused@example.com",
    ]);
    expect(await reminderSentAt(refusedUserId)).not.toBeNull();

    // 지금까지 이 잡은 아무 기록도 남기지 않아, SMTP 설정이 만료돼 전량 실패해도
    // 알 사람이 없었다. dry-run은 남기지 않고 실제 발송만 남아야 한다.
    const audits = await bootstrapDatabase
      .selectFrom("operator_audit_logs")
      .select(["after_json", "actor_type", "target_id", "target_type"])
      .where("action", "=", "reminder.executed")
      .orderBy("id", "asc")
      .execute();
    expect(audits).toEqual([
      {
        actor_type: "system",
        after_json: {
          eligible_count: 2,
          failed_count: 1,
          sent_count: 1,
          window_ends_at: expect.any(String),
        },
        target_id: "temporary_password_reminders",
        target_type: "retention",
      },
      {
        actor_type: "system",
        after_json: {
          eligible_count: 1,
          failed_count: 0,
          sent_count: 1,
          window_ends_at: expect.any(String),
        },
        target_id: "temporary_password_reminders",
        target_type: "retention",
      },
    ]);
    // 받는 사람 주소가 감사에 새면 안 된다 — 건수만으로 사고를 알 수 있다.
    expect(JSON.stringify(audits)).not.toContain("reminder-soon@example.com");
  });

  // "돌았는데 실패"와 "아예 안 돎"을 구분할 수 있어야 한다는 것이 이 기록의 목적이다.
  it("leaves a trace when a job fails instead of vanishing with the rollback", async () => {
    await recordJobFailure(retentionDatabase, "attendance-notifications", new TypeError("boom"));

    const failures = await bootstrapDatabase
      .selectFrom("operator_audit_logs")
      .select(["after_json", "actor_type", "target_id", "target_type"])
      .where("action", "=", "job.failed")
      .execute();
    expect(failures).toEqual([
      {
        actor_type: "system",
        after_json: { error_name: "TypeError", job_name: "attendance-notifications" },
        target_id: "attendance-notifications",
        target_type: "retention",
      },
    ]);
    // 예외 메시지 원문은 남기지 않는다 — 내부 경로·식별자가 새는 경로가 된다.
    expect(JSON.stringify(failures)).not.toContain("boom");
  });
});
