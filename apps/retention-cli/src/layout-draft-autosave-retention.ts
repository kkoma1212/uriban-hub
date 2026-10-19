import { randomUUID } from "node:crypto";

import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RetentionDatabase } from "./database.js";
import type { RetentionMode } from "./student-assessment-retention.js";

/*
 * 만들다 만 자리·모둠은 1주일이 지나면 지운다(2026-08-17 Hex 결정).
 *
 * 기준은 **마지막으로 손댄 때**다 — 만지면 다시 7일이라는 뜻이고, Hex 의 말("1주일
 * 동안 수정하지 않고 1주일이 지나면 자동 삭제")이 그대로 이 조건이다. 학생에게
 * 공개하면 화면이 그 자리에서 비우므로, 여기 남는 것은 **끝내 공개하지 않은 것**뿐이다.
 *
 * 왜 사람 손이 아니라 잡인가: 급식(T-HUB-25)에서 "자동 실행 장치가 없어 사람이
 * 기억해야 한다"에 이미 덴 적이 있다. 지우는 일을 기억에 맡기면 임시저장은 영원히 쌓인다.
 */

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;
const RETENTION_LOCK_KEY = "classhub.layout_draft_autosaves.retention.v1";
const RETENTION_DAYS = 7;

type RetentionQueryDatabase = Kysely<DB> | Transaction<DB>;

export interface LayoutDraftAutosaveRetentionOptions {
  batchSize?: number;
  maxBatches?: number;
  mode: RetentionMode;
  runId?: string;
}

export interface LayoutDraftAutosaveRetentionResult {
  capped: boolean;
  cutoff_at: string;
  deleted_count: number;
  eligible_count: number;
  mode: RetentionMode;
  remaining_eligible_count: number;
  run_id: string | null;
  table_name: "layout_draft_autosaves";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

/*
 * 자르는 시각은 DB 시계로 정한다. 잡이 도는 기계의 시계를 쓰면 시간대나 시계 어긋남이
 * 그대로 삭제 범위가 되어, 아직 살아 있어야 할 임시저장이 지워질 수 있다.
 */
async function databaseCutoff(database: RetentionQueryDatabase): Promise<Date> {
  const result = await sql<{ cutoff_at: Date }>`
    SELECT clock_timestamp() - make_interval(days => ${RETENTION_DAYS}) AS cutoff_at
  `.execute(database);
  return result.rows[0]!.cutoff_at;
}

async function eligibleCount(database: RetentionQueryDatabase, cutoff: Date): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM layout_draft_autosaves
    WHERE updated_at <= ${cutoff}
  `.execute(database);
  return Number(result.rows[0]!.count);
}

export async function runLayoutDraftAutosaveRetention(
  database: RetentionDatabase,
  options: LayoutDraftAutosaveRetentionOptions,
): Promise<LayoutDraftAutosaveRetentionResult> {
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = positiveInteger(options.maxBatches ?? DEFAULT_MAX_BATCHES, "maxBatches");

  if (options.mode === "dry-run") {
    const cutoff = await databaseCutoff(database);
    const count = await eligibleCount(database, cutoff);
    return {
      capped: false,
      cutoff_at: cutoff.toISOString(),
      deleted_count: 0,
      eligible_count: count,
      mode: "dry-run",
      remaining_eligible_count: count,
      run_id: null,
      table_name: "layout_draft_autosaves",
    };
  }

  const runId = options.runId ?? randomUUID();
  return database.transaction().execute(async (transaction) => {
    await sql`
      SELECT pg_advisory_xact_lock(hashtext(${RETENTION_LOCK_KEY}))
    `.execute(transaction);
    const cutoffResult = await sql<{ cutoff_at: Date }>`
      SELECT transaction_timestamp() - make_interval(days => ${RETENTION_DAYS}) AS cutoff_at
    `.execute(transaction);
    const cutoff = cutoffResult.rows[0]!.cutoff_at;
    const initialEligible = await eligibleCount(transaction, cutoff);
    let deletedCount = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await sql<{ deleted_count: string }>`
        WITH candidates AS (
          SELECT id
          FROM layout_draft_autosaves
          WHERE updated_at <= ${cutoff}
          ORDER BY updated_at, id
          LIMIT ${batchSize}
        ),
        deleted AS (
          DELETE FROM layout_draft_autosaves AS autosaves
          USING candidates
          WHERE autosaves.id = candidates.id
            AND autosaves.updated_at <= ${cutoff}
          RETURNING autosaves.id
        )
        SELECT count(*)::text AS deleted_count
        FROM deleted
      `.execute(transaction);
      const batchDeleted = Number(result.rows[0]!.deleted_count);
      deletedCount += batchDeleted;
      if (batchDeleted < batchSize) break;
    }

    const remainingEligible = await eligibleCount(transaction, cutoff);
    /*
     * 무엇을 지웠는지는 남기되 **내용은 싣지 않는다**. 임시저장 본문에는 아직 공개하지
     * 않은 배치가 들어 있어, 지운 기록에 옮겨 담으면 지운 보람이 없다.
     */
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
        'layout_draft_autosaves',
        jsonb_build_object(
          'cutoff_at', ${cutoff.toISOString()}::text,
          'table_name', 'layout_draft_autosaves',
          'deleted_count', ${deletedCount}::integer
        ),
        ${runId}::uuid
      )
    `.execute(transaction);

    return {
      capped: remainingEligible > 0,
      cutoff_at: cutoff.toISOString(),
      deleted_count: deletedCount,
      eligible_count: initialEligible,
      mode: "execute",
      remaining_eligible_count: remainingEligible,
      run_id: runId,
      table_name: "layout_draft_autosaves",
    };
  });
}
