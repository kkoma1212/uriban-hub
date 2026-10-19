import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { RetentionDatabase } from "./database.js";
import { recordMariaDbJobFailure } from "./mariadb/job-audit.js";

/*
 * 잡이 실패한 흔적을 남긴다.
 *
 * 삭제 잡의 성공 기록은 삭제와 같은 트랜잭션 안에 있다 — 그래야 "지웠다"는 기록과
 * 실제 삭제가 어긋나지 않는다. 그런데 그 때문에 롤백되면 기록도 함께 사라져서,
 * "돌았는데 실패"와 "아예 안 돎"이 구분되지 않았다. 실패 기록은 트랜잭션 밖에서
 * 따로 남겨야 남는다.
 *
 * 예외 메시지 원문은 넣지 않는다. 내부 경로·식별자·연결 문자열이 새는 경로가 되고,
 * "어느 잡이 어떤 종류의 오류로 죽었나"는 이름만으로 답이 된다.
 */
export async function recordJobFailure(
  database: RetentionDatabase,
  jobName: string,
  error: unknown,
  engine: "postgres" | "mariadb" = "postgres",
): Promise<void> {
  if (engine === "mariadb") return recordMariaDbJobFailure(database, jobName, error);
  const errorName = error instanceof Error ? error.name : "UnknownError";
  await sql`
    INSERT INTO operator_audit_logs (
      actor_type, action, target_type, target_id, after_json, run_id
    ) VALUES (
      'system', 'job.failed', 'retention', ${jobName}::text,
      jsonb_build_object('job_name', ${jobName}::text, 'error_name', ${errorName}::text),
      ${randomUUID()}::uuid
    )
  `.execute(database);
}

export interface ReminderRunAudit {
  eligibleCount: number;
  failedCount: number;
  sentCount: number;
  windowEndsAt: string;
}

/*
 * 안내 메일 잡의 결과를 남긴다. 이 잡은 지금까지 아무 기록도 남기지 않아서, SMTP
 * 설정이 만료돼 전량 실패해도 알 사람이 없었다. 받는 사람 주소나 교사 신원은 넣지
 * 않는다 — 건수만으로 "보낼 사람이 있었는데 하나도 못 보냈다"가 드러난다.
 */
export async function recordReminderRun(
  database: RetentionDatabase,
  audit: ReminderRunAudit,
): Promise<void> {
  await sql`
    INSERT INTO operator_audit_logs (
      actor_type, action, target_type, target_id, after_json, run_id
    ) VALUES (
      'system', 'reminder.executed', 'retention', 'temporary_password_reminders',
      jsonb_build_object(
        'eligible_count', ${audit.eligibleCount}::integer,
        'sent_count', ${audit.sentCount}::integer,
        'failed_count', ${audit.failedCount}::integer,
        'window_ends_at', ${audit.windowEndsAt}::text
      ),
      ${randomUUID()}::uuid
    )
  `.execute(database);
}
