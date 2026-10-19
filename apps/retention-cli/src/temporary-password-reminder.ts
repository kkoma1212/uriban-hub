import { sql } from "kysely";

import type { RetentionDatabase } from "./database.js";
import { recordReminderRun } from "./job-audit.js";
import type { RetentionMode } from "./student-assessment-retention.js";
import type { TemporaryPasswordReminderMailer } from "./temporary-password-reminder-mailer.js";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_RECIPIENTS = 500;

export interface TemporaryPasswordReminderOptions {
  /*
   * 팩토리로 받는다. dry-run은 한 통도 보내지 않으므로 SMTP 설정이 없어도 돌아야
   * 하는데, 메일러를 미리 만들면 그 설정을 먼저 요구하게 된다 — 보내지도 않으면서.
   */
  createMailer: () => TemporaryPasswordReminderMailer;
  maxRecipients?: number;
  mode: RetentionMode;
  now?: Date;
  windowHours?: number;
}

export interface TemporaryPasswordReminderResult {
  capped: boolean;
  eligible_count: number;
  failed_count: number;
  mode: RetentionMode;
  sent_count: number;
  table_name: "teacher_profiles";
  window_ends_at: string;
}

interface ReminderCandidate {
  email_normalized: string;
  expires_at: Date;
  user_id: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

/*
 * 임시 비밀번호를 받고도 로그인하지 않은 교사에게 만료 전에 한 번 알린다.
 * 이미 만료된 교사는 대상이 아니다 — 그 시점의 유일한 복구 수단은 운영자
 * 재발급이고, 안내 메일은 할 수 있는 일이 없는 사람에게 가는 소음이 된다.
 *
 * 발송 후 표시(send-then-mark) 순서를 쓴다. 표시를 먼저 하면 발송이 실패했을 때
 * 영영 안 가지만, 반대 순서에서 최악은 중복 1회다. 알림은 안 가는 쪽이 더 나쁘다.
 * 표시는 교사 1명 단위로 즉시 하므로 한 명의 실패가 나머지를 막지 않는다.
 */
export async function runTemporaryPasswordReminder(
  database: RetentionDatabase,
  options: TemporaryPasswordReminderOptions,
): Promise<TemporaryPasswordReminderResult> {
  const windowHours = positiveInteger(options.windowHours ?? DEFAULT_WINDOW_HOURS, "windowHours");
  const maxRecipients = positiveInteger(
    options.maxRecipients ?? DEFAULT_MAX_RECIPIENTS,
    "maxRecipients",
  );
  const now = options.now ?? new Date();
  const windowEndsAt = new Date(now.getTime() + windowHours * 60 * 60 * 1_000);

  // 한 건 더 받아서 상한에 걸렸는지 판별한다(capped면 main이 exit code 2를 낸다).
  const candidates = await sql<ReminderCandidate>`
    SELECT
      users.email_normalized,
      teacher_profiles.temporary_password_expires_at AS expires_at,
      teacher_profiles.user_id::text AS user_id
    FROM teacher_profiles
    JOIN users ON users.id = teacher_profiles.user_id
    WHERE teacher_profiles.status = 'active'
      AND teacher_profiles.temporary_password_must_change = TRUE
      AND teacher_profiles.temporary_password_expires_at IS NOT NULL
      AND teacher_profiles.temporary_password_expires_at > ${now}
      AND teacher_profiles.temporary_password_expires_at <= ${windowEndsAt}
      AND teacher_profiles.temporary_password_reminder_sent_at IS NULL
      AND users.is_active = TRUE
      AND users.deleted_at IS NULL
    ORDER BY teacher_profiles.temporary_password_expires_at ASC
    LIMIT ${maxRecipients + 1}
  `.execute(database);

  const capped = candidates.rows.length > maxRecipients;
  const recipients = capped ? candidates.rows.slice(0, maxRecipients) : candidates.rows;

  // dry-run은 한 통도 보내지 않으므로 남길 실행도 없다.
  if (options.mode === "dry-run") {
    return {
      capped,
      eligible_count: recipients.length,
      failed_count: 0,
      mode: options.mode,
      sent_count: 0,
      table_name: "teacher_profiles",
      window_ends_at: windowEndsAt.toISOString(),
    };
  }

  const mailer = options.createMailer();
  let sentCount = 0;
  let failedCount = 0;
  for (const recipient of recipients) {
    try {
      await mailer.sendExpiryReminder(recipient.email_normalized, recipient.expires_at);
    } catch {
      // 주소 하나가 거절돼도 나머지는 계속 보낸다. 실패한 교사는 표시하지
      // 않으므로 다음 실행에서 다시 시도된다.
      failedCount += 1;
      continue;
    }

    await sql`
      UPDATE teacher_profiles
      SET temporary_password_reminder_sent_at = ${now}
      WHERE user_id = ${recipient.user_id}::bigint
        AND temporary_password_reminder_sent_at IS NULL
    `.execute(database);
    sentCount += 1;
  }

  // 발송을 마친 뒤 결과를 남긴다. 한 통도 못 보냈어도 "보낼 사람이 N명 있었는데
  // 0명에게 갔다"가 남아야 SMTP 만료 같은 사고가 드러난다.
  await recordReminderRun(database, {
    eligibleCount: recipients.length,
    failedCount,
    sentCount,
    windowEndsAt: windowEndsAt.toISOString(),
  });

  return {
    capped,
    eligible_count: recipients.length,
    failed_count: failedCount,
    mode: options.mode,
    sent_count: sentCount,
    table_name: "teacher_profiles",
    window_ends_at: windowEndsAt.toISOString(),
  };
}
