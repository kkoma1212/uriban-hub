import { lockOperatorTransaction } from "./operator-lock.js";
import { operatorJson, operatorDate, operatorDateText, operatorNow } from "./operator-query.js";
/*
 * 그 해의 법정공휴일을 받아 `public_holidays` 에 반영한다.
 *
 * `neis-school-schedule-sync.ts` 와 같은 뼈대다 — 운영자 인증, 자문 잠금으로 동시 실행
 * 차단, 트랜잭션 안에서 반영, 감사 기록. 다른 점은 셋뿐이다.
 *   · 학교 검증이 없다. 법정공휴일은 전국 공통이라 대상 학교가 없다.
 *   · 별도 import_logs 표가 없다. 운영자 감사 로그가 같은 키(건수·checksum)를 이미 받는다.
 *   · 삭제가 있다. 대체공휴일이 나중에 확정·변경되면 이전에 넣은 날짜가 더는 공휴일이
 *     아닐 수 있다. 그 해 범위 안에서 응답에 없는 날짜는 지운다 — 안 지우면 한번 잘못
 *     들어온 빨간 날이 영영 남는다.
 */
import { createHash, randomUUID } from "node:crypto";

import { type DB } from "@classhub/db";
import { type Kysely, type Transaction } from "kysely";

import {
  fetchKasiHolidays,
  KasiHolidayError,
  validateKasiHolidayQuery,
  type KasiHoliday,
  type KasiHolidayQuery,
} from "./kasi-holiday.js";
import {
  authenticateOperator,
  lockAndRevalidateOperator,
  type AuthenticatedOperator,
} from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const IMPORT_LOCK_NAME = "classhub:public-holiday-import";
const HOLIDAY_SOURCE = "kasi";

interface SyncCounts {
  deleted: number;
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
}

type KasiHolidayFetcher = (query: KasiHolidayQuery) => Promise<KasiHoliday[]>;

export interface SyncPublicHolidaysInput {
  apiKey: string | undefined;
  dryRun?: boolean;
  fetchHolidays?: KasiHolidayFetcher;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  year: number;
}

export interface SyncPublicHolidaysResult {
  checksum: string;
  deletedCount: number;
  dryRun: boolean;
  failedCount: 0;
  insertedCount: number;
  runId: string;
  skippedCount: number;
  updatedCount: number;
  year: number;
}

export class PublicHolidaySyncBusyError extends Error {
  readonly code = "PUBLIC_HOLIDAY_SYNC_BUSY";

  constructor() {
    super("Another public holiday sync is already running.");
    this.name = "PublicHolidaySyncBusyError";
  }
}

function emptyCounts(failed = 0): SyncCounts {
  return { deleted: 0, failed, inserted: 0, skipped: 0, updated: 0 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestFileName(year: number): string {
  return ["kasi-public-holiday", String(year)].join(":");
}

/** 받은 내용이 지난번과 같은지 한눈에 보이게 하는 지문. 날짜·이름만으로 만든다. */
function normalizedChecksum(holidays: readonly KasiHoliday[]): string {
  return sha256(JSON.stringify(holidays.map((holiday) => [holiday.date, holiday.name])));
}

function errorCode(error: unknown): string {
  if (error instanceof KasiHolidayError) return error.code;
  if (error instanceof PublicHolidaySyncBusyError) return error.code;
  return "UNEXPECTED_ERROR";
}

function auditPayload(context: SyncRunContext, counts: SyncCounts, result: "failed" | "success") {
  return {
    checksum: context.checksum,
    deleted_count: counts.deleted,
    failed_count: counts.failed,
    file_name: context.fileName,
    inserted_count: counts.inserted,
    result,
    skipped_count: counts.skipped,
    updated_count: counts.updated,
  };
}

async function insertRunLog(
  transaction: Transaction<DB>,
  context: SyncRunContext,
  counts: SyncCounts,
  result: "failed" | "success",
): Promise<void> {
  await transaction
    .insertInto("operator_audit_logs")
    .values({
      action: "holiday.imported",
      actor_type: "operator",
      after_json: operatorJson(transaction, auditPayload(context, counts, result)),
      before_json: null,
      checksum: context.checksum,
      operator_id: context.operatorId,
      run_id: context.runId,
      target_id: "global",
      target_type: "public_holiday_import",
    })
    .execute();
}

async function recordFailedRun(
  database: Kysely<DB>,
  authenticatedOperator: AuthenticatedOperator,
  context: SyncRunContext,
  failedCount: number,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await lockAndRevalidateOperator(transaction, authenticatedOperator);
    await insertRunLog(transaction, context, emptyCounts(failedCount), "failed");
  });
}

async function applyHoliday(
  transaction: Transaction<DB>,
  holiday: KasiHoliday,
  loadedOn: string,
  counts: SyncCounts,
  applyChanges: boolean,
): Promise<void> {
  const query = transaction
    .selectFrom("public_holidays")
    .select([
      "name",
      "source",
      operatorDateText(transaction, "source_loaded_on").as("source_loaded_on"),
    ])
    .where("holiday_date", "=", operatorDate(transaction, holiday.date));
  const existing = applyChanges
    ? await query.forUpdate().executeTakeFirst()
    : await query.executeTakeFirst();

  if (existing === undefined) {
    counts.inserted += 1;
    if (!applyChanges) return;
    await transaction
      .insertInto("public_holidays")
      .values({
        holiday_date: holiday.date,
        name: holiday.name,
        source: HOLIDAY_SOURCE,
        source_loaded_on: loadedOn,
      })
      .execute();
    return;
  }

  /*
   * 이름도 출처도 같으면 건드리지 않는다. `source_loaded_on` 만 새로 찍으려고 매번
   * UPDATE 하면 "이번에 무엇이 실제로 바뀌었나"가 건수에서 사라진다.
   */
  if (existing.name === holiday.name && existing.source === HOLIDAY_SOURCE) {
    counts.skipped += 1;
    return;
  }

  counts.updated += 1;
  if (!applyChanges) return;
  await transaction
    .updateTable("public_holidays")
    .set({
      name: holiday.name,
      source: HOLIDAY_SOURCE,
      source_loaded_on: loadedOn,
      updated_at: operatorNow(transaction),
    })
    .where("holiday_date", "=", operatorDate(transaction, holiday.date))
    .execute();
}

/**
 * 그 해에 이미 들어 있는데 이번 응답에는 없는 날짜를 지운다.
 *
 * 범위를 **그 해로 한정**하는 것이 중요하다. 전체를 대상으로 지우면 2027년만 동기화했을
 * 때 2026년 공휴일이 통째로 사라진다.
 */
async function deleteStaleHolidays(
  transaction: Transaction<DB>,
  year: number,
  keepDates: readonly string[],
  counts: SyncCounts,
  applyChanges: boolean,
): Promise<void> {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const stale = await transaction
    .selectFrom("public_holidays")
    .select(operatorDateText(transaction, "holiday_date").as("holiday_date"))
    .where("holiday_date", ">=", operatorDate(transaction, start))
    .where("holiday_date", "<=", operatorDate(transaction, end))
    .where("source", "=", HOLIDAY_SOURCE)
    .execute();
  const keep = new Set(keepDates);
  const removable = stale.map((row) => row.holiday_date).filter((date) => !keep.has(date));
  counts.deleted += removable.length;
  if (!applyChanges || removable.length === 0) return;
  await transaction
    .deleteFrom("public_holidays")
    .where(
      "holiday_date",
      "in",
      removable.map((date) => operatorDate(transaction, date)),
    )
    .execute();
}

export async function syncPublicHolidays(
  input: SyncPublicHolidaysInput,
): Promise<SyncPublicHolidaysResult> {
  const query = validateKasiHolidayQuery({ apiKey: input.apiKey, year: input.year });
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);
  const dryRun = input.dryRun ?? false;
  const runId = randomUUID();
  const fileName = requestFileName(query.year);
  const requestContext: SyncRunContext = {
    checksum: sha256(fileName),
    fileName,
    operatorId: "",
    runId,
  };

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);
    requestContext.operatorId = authenticatedOperator.operatorId;

    let holidays: KasiHoliday[];
    try {
      holidays = await (input.fetchHolidays ?? fetchKasiHolidays)({
        apiKey: input.apiKey,
        year: query.year,
      });
    } catch (error) {
      if (!dryRun) await recordFailedRun(database, authenticatedOperator, requestContext, 1);
      throw error;
    }

    const context: SyncRunContext = {
      ...requestContext,
      checksum: normalizedChecksum(holidays),
    };
    const counts = emptyCounts();
    try {
      await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        const acquired = await lockOperatorTransaction(transaction, IMPORT_LOCK_NAME, {
          tryOnly: true,
        });
        if (!acquired) throw new PublicHolidaySyncBusyError();

        const loadedOn = new Date().toISOString().slice(0, 10);
        for (const holiday of holidays) {
          await applyHoliday(transaction, holiday, loadedOn, counts, !dryRun);
        }
        await deleteStaleHolidays(
          transaction,
          query.year,
          holidays.map((holiday) => holiday.date),
          counts,
          !dryRun,
        );
        if (!dryRun) await insertRunLog(transaction, context, counts, "success");
      });
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(
          database,
          authenticatedOperator,
          context,
          Math.max(1, holidays.length),
        );
      }
      throw error;
    }

    return {
      checksum: context.checksum,
      deletedCount: counts.deleted,
      dryRun,
      failedCount: 0,
      insertedCount: counts.inserted,
      runId,
      skippedCount: counts.skipped,
      updatedCount: counts.updated,
      year: query.year,
    };
  } finally {
    await database.destroy();
  }
}

export { errorCode as publicHolidaySyncErrorCode };
