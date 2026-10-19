import { randomUUID } from "node:crypto";

import type { DB } from "@classhub/db";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RetentionDatabase } from "./database.js";
import type { RetentionMode } from "./student-assessment-retention.js";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;
const RETENTION_DAYS = 7;
const RETENTION_LOCK_KEY = "classhub.guardian_consent_requests.retention.v1";

type RetentionQueryDatabase = Kysely<DB> | Transaction<DB>;

export interface GuardianConsentRequestRetentionOptions {
  batchSize?: number;
  maxBatches?: number;
  mode: RetentionMode;
  runId?: string;
}

export interface GuardianConsentRequestRetentionResult {
  capped: boolean;
  cutoff_at: string;
  deleted_count: number;
  eligible_count: number;
  mode: RetentionMode;
  remaining_eligible_count: number;
  run_id: string | null;
  table_name: "guardian_consent_requests";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

async function databaseCutoff(database: RetentionQueryDatabase): Promise<Date> {
  const result = await sql<{ cutoff_at: Date }>`
    SELECT clock_timestamp() - make_interval(days => ${RETENTION_DAYS}) AS cutoff_at
  `.execute(database);
  return result.rows[0]!.cutoff_at;
}

async function eligibleCount(database: RetentionQueryDatabase, cutoff: Date): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count
    FROM guardian_consent_requests
    WHERE user_id IS NULL
      AND requested_at <= ${cutoff}
  `.execute(database);
  return Number(result.rows[0]!.count);
}

export async function runGuardianConsentRequestRetention(
  database: RetentionDatabase,
  options: GuardianConsentRequestRetentionOptions,
): Promise<GuardianConsentRequestRetentionResult> {
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
      table_name: "guardian_consent_requests",
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
          FROM guardian_consent_requests
          WHERE user_id IS NULL
            AND requested_at <= ${cutoff}
          ORDER BY requested_at, id
          LIMIT ${batchSize}
        ),
        deleted AS (
          DELETE FROM guardian_consent_requests AS requests
          USING candidates
          WHERE requests.id = candidates.id
            AND requests.user_id IS NULL
            AND requests.requested_at <= ${cutoff}
          RETURNING requests.id
        )
        SELECT count(*)::text AS deleted_count
        FROM deleted
      `.execute(transaction);
      const batchDeleted = Number(result.rows[0]!.deleted_count);
      deletedCount += batchDeleted;
      if (batchDeleted < batchSize) break;
    }

    const remainingEligible = await eligibleCount(transaction, cutoff);
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
        'guardian_consent_requests',
        jsonb_build_object(
          'cutoff_at', ${cutoff.toISOString()}::text,
          'table_name', 'guardian_consent_requests',
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
      table_name: "guardian_consent_requests",
    };
  });
}
