import { lockOperatorTransaction } from "./operator-lock.js";
import { operatorJson, operatorDate, operatorDateText } from "./operator-query.js";
import { createHash, randomUUID } from "node:crypto";

import { type DB } from "@classhub/db";
import { type Kysely, type Transaction } from "kysely";

import {
  fetchNeisSchoolSchedules,
  type NeisSchoolSchedule,
  NeisSchoolScheduleError,
  type NeisSchoolScheduleQuery,
  validateNeisSchoolScheduleQuery,
} from "./neis-school-schedule.js";
import {
  authenticateOperator,
  lockAndRevalidateOperator,
  type AuthenticatedOperator,
} from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const IMPORT_LOCK_NAME = "classhub:school-schedule-import";

interface SyncCounts {
  failed: number;
  inserted: number;
  skipped: number;
  updated: number;
}

interface SyncRunContext {
  checksum: string;
  fileName: string;
  operatorId: string;
  runId: string;
  startedAt: Date;
}

type NeisSchoolScheduleFetcher = (query: NeisSchoolScheduleQuery) => Promise<NeisSchoolSchedule[]>;

export interface SyncNeisSchoolSchedulesInput {
  apiKey: string | undefined;
  dryRun?: boolean;
  eduOfficeCode: string;
  fetchSchedules?: NeisSchoolScheduleFetcher;
  from: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  schoolCode: string;
  to: string;
}

export interface SyncNeisSchoolSchedulesResult {
  checksum: string;
  dryRun: boolean;
  failedCount: 0;
  insertedCount: number;
  runId: string;
  skippedCount: number;
  updatedCount: number;
}

export class NeisSchoolScheduleSyncBusyError extends Error {
  readonly code = "NEIS_SCHOOL_SCHEDULE_SYNC_BUSY";

  constructor() {
    super("Another NEIS school schedule sync is already running.");
    this.name = "NeisSchoolScheduleSyncBusyError";
  }
}

export class NeisSchoolScheduleSyncSchoolNotFoundError extends Error {
  readonly code = "NEIS_SCHOOL_SCHEDULE_SCHOOL_NOT_FOUND";

  constructor() {
    super("The requested school must exist before its official schedule can be synced.");
    this.name = "NeisSchoolScheduleSyncSchoolNotFoundError";
  }
}

function emptyCounts(failed = 0): SyncCounts {
  return { failed, inserted: 0, skipped: 0, updated: 0 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestFileName(
  input: Pick<NeisSchoolScheduleQuery, "eduOfficeCode" | "from" | "schoolCode" | "to">,
): string {
  return ["neis-school-schedule", input.eduOfficeCode, input.schoolCode, input.from, input.to].join(
    ":",
  );
}

function normalizedChecksum(events: NeisSchoolSchedule[]): string {
  return sha256(
    JSON.stringify(
      events.map((event) => ({
        academic_year: event.academicYear,
        edu_office_code: event.eduOfficeCode,
        event_content: event.eventContent,
        event_date: event.eventDate,
        event_name: event.eventName,
        grade_mask: event.gradeMask,
        school_code: event.schoolCode,
        school_day_type: event.schoolDayType,
        source_loaded_on: event.sourceLoadedOn,
      })),
    ),
  );
}

function auditPayload(context: SyncRunContext, counts: SyncCounts, result: "failed" | "success") {
  return {
    checksum: context.checksum,
    deleted_count: 0,
    failed_count: counts.failed,
    file_name: context.fileName,
    inserted_count: counts.inserted,
    result,
    skipped_count: counts.skipped,
    updated_count: counts.updated,
  };
}

async function insertRunLogs(
  transaction: Transaction<DB>,
  context: SyncRunContext,
  counts: SyncCounts,
  result: "failed" | "success",
  errorCode: string | null,
): Promise<void> {
  const completedAt = new Date();
  await transaction
    .insertInto("school_schedule_import_logs")
    .values({
      checksum: context.checksum,
      completed_at: completedAt,
      deleted_count: 0,
      error_json: errorCode === null ? null : operatorJson(transaction, { code: errorCode }),
      failed_count: counts.failed,
      file_name: context.fileName,
      inserted_count: counts.inserted,
      operator_id: context.operatorId,
      result,
      run_id: context.runId,
      skipped_count: counts.skipped,
      started_at: context.startedAt,
      updated_count: counts.updated,
    })
    .execute();
  await transaction
    .insertInto("operator_audit_logs")
    .values({
      action: "school_schedule.imported",
      actor_type: "operator",
      after_json: operatorJson(transaction, auditPayload(context, counts, result)),
      before_json: null,
      checksum: context.checksum,
      operator_id: context.operatorId,
      run_id: context.runId,
      target_id: "global",
      target_type: "school_schedule_import",
    })
    .execute();
}

async function recordFailedRun(
  database: Kysely<DB>,
  authenticatedOperator: AuthenticatedOperator,
  context: SyncRunContext,
  failedCount: number,
  errorCode: string,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await lockAndRevalidateOperator(transaction, authenticatedOperator);
    await insertRunLogs(transaction, context, emptyCounts(failedCount), "failed", errorCode);
  });
}

async function validateSchool(
  database: Kysely<DB> | Transaction<DB>,
  eduOfficeCode: string,
  schoolCode: string,
): Promise<void> {
  const school = await database
    .selectFrom("schools")
    .select("school_code")
    .where("edu_office_code", "=", eduOfficeCode)
    .where("school_code", "=", schoolCode)
    .executeTakeFirst();
  if (school === undefined) throw new NeisSchoolScheduleSyncSchoolNotFoundError();
}

function databaseDate(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

async function applyEvent(
  transaction: Transaction<DB>,
  event: NeisSchoolSchedule,
  counts: SyncCounts,
  changedAt: Date,
  applyChanges: boolean,
): Promise<void> {
  const query = transaction
    .selectFrom("school_schedule_events")
    .select([
      "event_content",
      "id",
      "school_day_type",
      operatorDateText(transaction, "source_loaded_on").as("source_loaded_on"),
    ])
    .where("edu_office_code", "=", event.eduOfficeCode)
    .where("school_code", "=", event.schoolCode)
    .where("academic_year", "=", event.academicYear)
    .where("event_date", "=", operatorDate(transaction, event.eventDate))
    .where("event_name", "=", event.eventName)
    .where("grade_mask", "=", event.gradeMask);
  const existing = applyChanges
    ? await query.forUpdate().executeTakeFirst()
    : await query.executeTakeFirst();

  if (existing === undefined) {
    if (applyChanges) {
      await transaction
        .insertInto("school_schedule_events")
        .values({
          academic_year: event.academicYear,
          edu_office_code: event.eduOfficeCode,
          event_content: event.eventContent,
          event_date: event.eventDate,
          event_name: event.eventName,
          grade_mask: event.gradeMask,
          school_code: event.schoolCode,
          school_day_type: event.schoolDayType,
          source_loaded_on: event.sourceLoadedOn,
          source_updated_at: changedAt,
        })
        .execute();
    }
    counts.inserted += 1;
    return;
  }

  if (
    existing.event_content === event.eventContent &&
    existing.school_day_type === event.schoolDayType &&
    databaseDate(existing.source_loaded_on) === event.sourceLoadedOn
  ) {
    counts.skipped += 1;
    return;
  }

  if (applyChanges) {
    await transaction
      .updateTable("school_schedule_events")
      .set({
        event_content: event.eventContent,
        school_day_type: event.schoolDayType,
        source_loaded_on: event.sourceLoadedOn,
        source_updated_at: changedAt,
        updated_at: changedAt,
      })
      .where("id", "=", existing.id)
      .execute();
  }
  counts.updated += 1;
}

function errorCode(error: unknown): string {
  if (error instanceof NeisSchoolScheduleError) return error.code;
  if (error instanceof NeisSchoolScheduleSyncBusyError) return error.code;
  if (error instanceof NeisSchoolScheduleSyncSchoolNotFoundError) return error.code;
  return "NEIS_SCHOOL_SCHEDULE_SYNC_FAILED";
}

export async function syncNeisSchoolSchedules(
  input: SyncNeisSchoolSchedulesInput,
): Promise<SyncNeisSchoolSchedulesResult> {
  const query = validateNeisSchoolScheduleQuery({
    apiKey: input.apiKey,
    eduOfficeCode: input.eduOfficeCode,
    from: input.from,
    schoolCode: input.schoolCode,
    to: input.to,
  });
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);
  const dryRun = input.dryRun ?? false;
  const runId = randomUUID();
  const startedAt = new Date();
  const fileName = requestFileName(query);
  const requestContext: SyncRunContext = {
    checksum: sha256(fileName),
    fileName,
    operatorId: "",
    runId,
    startedAt,
  };

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);
    requestContext.operatorId = authenticatedOperator.operatorId;

    try {
      await validateSchool(database, query.eduOfficeCode, query.schoolCode);
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(database, authenticatedOperator, requestContext, 1, errorCode(error));
      }
      throw error;
    }

    let events: NeisSchoolSchedule[];
    try {
      events = await (input.fetchSchedules ?? fetchNeisSchoolSchedules)(query);
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(database, authenticatedOperator, requestContext, 1, errorCode(error));
      }
      throw error;
    }

    const context: SyncRunContext = {
      ...requestContext,
      checksum: normalizedChecksum(events),
    };
    const counts = emptyCounts();
    try {
      await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        const acquired = await lockOperatorTransaction(transaction, IMPORT_LOCK_NAME, {
          tryOnly: true,
        });
        if (!acquired) throw new NeisSchoolScheduleSyncBusyError();

        await validateSchool(transaction, query.eduOfficeCode, query.schoolCode);
        const changedAt = new Date();
        for (const event of events) {
          await applyEvent(transaction, event, counts, changedAt, !dryRun);
        }
        if (!dryRun) await insertRunLogs(transaction, context, counts, "success", null);
      });
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(
          database,
          authenticatedOperator,
          context,
          Math.max(1, events.length),
          errorCode(error),
        );
      }
      throw error;
    }

    return {
      checksum: context.checksum,
      dryRun,
      failedCount: 0,
      insertedCount: counts.inserted,
      runId,
      skippedCount: counts.skipped,
      updatedCount: counts.updated,
    };
  } finally {
    await database.destroy();
  }
}
