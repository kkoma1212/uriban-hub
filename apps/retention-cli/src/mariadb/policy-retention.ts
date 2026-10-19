import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type { RetentionDatabase } from "../database.js";
import type { RetentionMode } from "../student-assessment-retention.js";
import { RetentionMariaDbError } from "./errors.js";
import { recordMariaDbAudit } from "./job-audit.js";
import { countValue, dateValue, positiveInteger, sqlDate } from "./values.js";

/*
 * 2026-10-03 사용자 승인(보관기간 ②, 총검수 I3-01·I5-03·A4-02·A2-04): 개인정보처리방침 4장에 적은
 * 기간이 지난 기록을 지운다. 이 PC DB에서 classhub_retention 계정에 DELETE 권한이 이미 있는 표만
 * 다룬다(2026-10-03 SHOW GRANTS로 확인). 권한이 없는 관리자 작업 감사 기록·탈퇴자 동의 증빙은
 * 권한 추가(별도 승인) 뒤에 더한다.
 * '끝난 시각'은 행마다 쓰기·폐기·만료 중 먼저 온 기준을 쓴다(예: 쓰인 링크는 쓴 시각부터 30일).
 * 잠금은 표마다 미리 넣어 둔 키 대신 MariaDB 이름 잠금(GET_LOCK)을 써서 DB 구조를 바꾸지 않는다.
 */
interface PolicyJob {
  /** 작업 기록·출력에 남는 고정 이름(표 이름과 같다). */
  readonly table: string;
  readonly ended: RawBuilder<unknown>;
  readonly days: number;
  /** 기간 외에 더 지켜야 할 조건(예: 아직 붙잡는 행이 없을 때만). */
  readonly also?: RawBuilder<unknown>;
  /** 나눠 지울 때의 순서 칸. 기본 id(패스키 표는 id가 없고 credential_id가 기본키다). */
  readonly orderBy?: string;
}

const POLICY_JOBS: readonly PolicyJob[] = [
  { table: "sessions", ended: sql`COALESCE(revoked_at, expires_at)`, days: 30 },
  { table: "admin_sessions", ended: sql`COALESCE(revoked_at, absolute_expires_at)`, days: 30 },
  {
    table: "email_verification_tokens",
    ended: sql`COALESCE(used_at, invalidated_at, expires_at)`,
    days: 30,
  },
  {
    table: "password_reset_tokens",
    ended: sql`COALESCE(used_at, invalidated_at, expires_at)`,
    days: 30,
  },
  { table: "api_idempotency_keys", ended: sql`created_at`, days: 1 },
  { table: "security_audit_logs", ended: sql`created_at`, days: 180 },
  { table: "audit_logs", ended: sql`created_at`, days: 365 },
  { table: "admin_auth_audit_logs", ended: sql`created_at`, days: 730 },
  { table: "school_import_logs", ended: sql`started_at`, days: 730 },
  { table: "meal_import_logs", ended: sql`started_at`, days: 730 },
  { table: "school_schedule_import_logs", ended: sql`started_at`, days: 730 },
];

/**
 * 메일 발송 기록: 발송 요청 시각부터 365일(처리방침 4장, 2026-10-03 사용자 결정). 정리 계정
 * 권한(0061)을 넣은 DB에서만 돌린다. 맨 끝에 두어 권한 문제로 실패해도 다른 표는 먼저 끝난다.
 */
const MAIL_LOG_JOB: PolicyJob = { table: "mail_delivery_logs", ended: sql`created_at`, days: 365 };

/**
 * 원장 105 권한이 있을 때만(처리방침 4장, 2026-10-03 사용자 승인):
 * 관리자 작업 기록은 생성일부터 730일, 동의 증빙은 탈퇴·철회 때 찍은 보관 만료 시각
 * (retention_expires_at = 그때부터 365일)이 지난 행. 이용 중인 동의는 만료 시각이 없어 대상이 아니다.
 */
const AUDIT_CONSENT_JOBS: readonly PolicyJob[] = [
  { table: "admin_operation_audit_logs", ended: sql`created_at`, days: 730 },
  { table: "user_consents", ended: sql`retention_expires_at`, days: 0 },
];

/**
 * 원장 106 권한이 있을 때만(처리방침 4장, 2026-10-04 사용자 결정):
 * - 끝난 관리자 가입 승인(사용·취소·만료 중 먼저 온 시각): 30일 뒤 이메일 원문·암호화 코드만 비운다.
 *   승인 처리 기록이 행을 삭제 금지(RESTRICT)로 붙잡아 행은 처리 기록과 함께 730일 뒤 지운다(처리 기록 먼저).
 * - 패스키는 폐기된 것만(used_at은 '마지막으로 쓴 시각'이라 쓰는 중인 패스키도 값이 있다) 폐기 30일 뒤,
 *   복구 코드는 쓰거나(일회용) 폐기한 30일 뒤, 문의는 처리 완료 365일 뒤. 값이 없는 행은 대상이 아니다.
 */
const APPROVAL_ENDED = sql`COALESCE(consumed_at, revoked_at, expires_at)`;
const APPROVAL_CONTACT_DAYS = 30;
const ADMIN_RECORD_JOBS: readonly PolicyJob[] = [
  { table: "admin_signup_approval_events", ended: sql`created_at`, days: 730 },
  {
    table: "admin_signup_approvals",
    ended: APPROVAL_ENDED,
    days: 730,
    also: sql`NOT EXISTS (SELECT 1 FROM admin_signup_approval_events AS event
      WHERE event.approval_id = admin_signup_approvals.id)`,
  },
  { table: "admin_passkeys", ended: sql`revoked_at`, days: 30, orderBy: "credential_id" },
  { table: "admin_recovery_codes", ended: sql`COALESCE(used_at, revoked_at)`, days: 30 },
  { table: "admin_inquiries", ended: sql`resolved_at`, days: 365 },
];

/** 탈퇴(익명화)한 학생의 보호자 동의 최소 증빙: 탈퇴 시각부터 365일. */
const DELETED_STUDENT_GUARDIAN_DAYS = 365;

export const policyRetentionTables = [
  ...POLICY_JOBS.map((job) => job.table),
  "guardian_consent_requests:deleted_students",
] as const;

interface PolicyJobResult {
  cutoff_at: string;
  deleted_count: number;
  eligible_count: number;
  remaining_eligible_count: number;
  capped: boolean;
  table_name: string;
}

function cutoff(now: Date, days: number): string {
  return sqlDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
}

function predicate(job: PolicyJob | "guardian", now: Date): RawBuilder<unknown> {
  if (job === "guardian")
    return sql`user_id IN (SELECT id FROM users WHERE deleted_at IS NOT NULL
      AND deleted_at <= ${cutoff(now, DELETED_STUDENT_GUARDIAN_DAYS)})`;
  const expired = sql`${job.ended} <= ${cutoff(now, job.days)}`;
  return job.also === undefined ? expired : sql`${expired} AND ${job.also}`;
}

/** 끝난 지 30일 지난 가입 승인 중 아직 이메일·코드가 남은 행(이것만 비운다). */
function approvalContactPredicate(now: Date): RawBuilder<unknown> {
  return sql`${APPROVAL_ENDED} <= ${cutoff(now, APPROVAL_CONTACT_DAYS)}
    AND (recipient_email IS NOT NULL OR code_encrypted IS NOT NULL)`;
}

async function count(
  database: RetentionDatabase,
  table: string,
  where: RawBuilder<unknown>,
): Promise<number> {
  const result = await sql<{
    count: string;
  }>`SELECT CAST(COUNT(*) AS CHAR) AS count FROM ${sql.table(table)} WHERE ${where}`.execute(
    database,
  );
  if (result.rows.length !== 1) throw new RetentionMariaDbError("invalid_result");
  return countValue(result.rows[0]?.count);
}

async function databaseNow(database: RetentionDatabase): Promise<Date> {
  const result = await sql<{
    now: string;
  }>`SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS now`.execute(database);
  if (result.rows.length !== 1) throw new RetentionMariaDbError("invalid_result");
  return dateValue(result.rows[0]?.now);
}

interface JobShape {
  /** 결과·작업 기록에 남는 이름. 지우는 작업은 표 이름, 칸만 비우는 작업은 '표:contact'. */
  readonly label?: string;
  readonly orderBy?: string;
  /** delete: 행 삭제. clear-contact: 가입 승인의 이메일 원문·암호화 코드만 NULL로 비운다. */
  readonly action?: "delete" | "clear-contact";
}

function batchStatement(
  table: string,
  where: RawBuilder<unknown>,
  limit: number,
  shape: JobShape,
): RawBuilder<unknown> {
  // 순서 칸은 위 고정 목록에서만 온다(입력값이 아님). 기존 표의 SQL을 그대로 두려고 raw로 잇는다.
  const order = sql.raw(shape.orderBy ?? "id");
  return shape.action === "clear-contact"
    ? sql`UPDATE ${sql.table(table)} SET recipient_email = NULL, code_encrypted = NULL
        WHERE ${where} ORDER BY ${order} LIMIT ${limit}`
    : sql`DELETE FROM ${sql.table(table)} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`;
}

async function runJob(
  database: RetentionDatabase,
  table: string,
  where: RawBuilder<unknown>,
  cutoffAt: string,
  options: { mode: RetentionMode; batchSize: number; maxBatches: number; runId: string },
  shape: JobShape = {},
): Promise<PolicyJobResult> {
  const label = shape.label ?? table;
  if (options.mode === "dry-run") {
    const eligible = await count(database, table, where);
    return {
      capped: false,
      cutoff_at: cutoffAt,
      deleted_count: 0,
      eligible_count: eligible,
      remaining_eligible_count: eligible,
      table_name: label,
    };
  }
  return database.transaction().execute(async (transaction) => {
    const lockName = `classhub.retention.policy.${label}`;
    const lock = await sql<{ acquired: number | string | null }>`
      SELECT GET_LOCK(${lockName}, 0) AS acquired`.execute(transaction);
    if (![1, "1"].includes(lock.rows[0]?.acquired ?? 0))
      throw new RetentionMariaDbError("invalid_result");
    try {
      const eligible = await count(transaction, table, where);
      let deleted = 0;
      for (let batch = 0; batch < options.maxBatches; batch += 1) {
        const result = await batchStatement(table, where, options.batchSize, shape).execute(
          transaction,
        );
        const removed = countValue(result.numAffectedRows);
        if (removed > options.batchSize) throw new RetentionMariaDbError("invalid_result");
        deleted += removed;
        if (removed < options.batchSize) break;
      }
      const remaining = await count(transaction, table, where);
      await recordMariaDbAudit(
        transaction,
        "retention.executed",
        label,
        { cutoff_at: cutoffAt, deleted_count: deleted, table_name: label },
        options.runId,
      );
      return {
        capped: remaining > 0,
        cutoff_at: cutoffAt,
        deleted_count: deleted,
        eligible_count: eligible,
        remaining_eligible_count: remaining,
        table_name: label,
      };
    } finally {
      await sql`SELECT RELEASE_LOCK(${lockName})`.execute(transaction);
    }
  });
}

/** 처리방침 보관기간 작업 전체. 표마다 한 트랜잭션이라 한 표가 실패해도 앞 표 결과는 남는다. */
export async function runMariaDbPolicyRetention(
  database: RetentionDatabase,
  options: {
    mode: RetentionMode;
    batchSize?: number;
    maxBatches?: number;
    runId?: string;
    includeMailLogs?: boolean;
    includeAuditConsents?: boolean;
    includeAdminRecords?: boolean;
  },
) {
  if (options.mode !== "dry-run" && options.mode !== "execute")
    throw new RetentionMariaDbError("invalid_mode");
  const settings = {
    mode: options.mode,
    batchSize: positiveInteger(options.batchSize ?? 500, "batchSize"),
    maxBatches: positiveInteger(options.maxBatches ?? 20, "maxBatches"),
    runId: options.runId ?? randomUUID(),
  };
  const now = await databaseNow(database);
  const jobs: PolicyJobResult[] = [];
  for (const job of POLICY_JOBS)
    jobs.push(
      await runJob(database, job.table, predicate(job, now), cutoff(now, job.days), settings),
    );
  jobs.push(
    await runJob(
      database,
      "guardian_consent_requests",
      predicate("guardian", now),
      cutoff(now, DELETED_STUDENT_GUARDIAN_DAYS),
      settings,
    ),
  );
  if (options.includeMailLogs === true)
    jobs.push(
      await runJob(
        database,
        MAIL_LOG_JOB.table,
        predicate(MAIL_LOG_JOB, now),
        cutoff(now, MAIL_LOG_JOB.days),
        settings,
      ),
    );
  if (options.includeAuditConsents === true)
    for (const job of AUDIT_CONSENT_JOBS)
      jobs.push(
        await runJob(database, job.table, predicate(job, now), cutoff(now, job.days), settings),
      );
  if (options.includeAdminRecords === true) {
    jobs.push(
      await runJob(
        database,
        "admin_signup_approvals",
        approvalContactPredicate(now),
        cutoff(now, APPROVAL_CONTACT_DAYS),
        settings,
        { label: "admin_signup_approvals:contact", action: "clear-contact" },
      ),
    );
    for (const job of ADMIN_RECORD_JOBS)
      jobs.push(
        await runJob(
          database,
          job.table,
          predicate(job, now),
          cutoff(now, job.days),
          settings,
          job.orderBy === undefined ? {} : { orderBy: job.orderBy },
        ),
      );
  }
  return {
    // 한 번에 다 못 지운 표가 있으면 main이 종료 코드 2로 알린다(기존 작업과 같은 약속).
    capped: jobs.some((job) => job.capped),
    mode: settings.mode,
    run_id: settings.mode === "execute" ? settings.runId : null,
    jobs,
  };
}
