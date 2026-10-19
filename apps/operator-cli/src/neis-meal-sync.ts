import { lockOperatorTransaction } from "./operator-lock.js";
import {
  operatorJson,
  operatorDate,
  operatorDateText,
  parseOperatorJson,
} from "./operator-query.js";
import { createHash, randomUUID } from "node:crypto";

import { type DB } from "@classhub/db";
import { type Kysely, type Transaction } from "kysely";

import {
  fetchNeisMeals,
  type NeisMeal,
  NeisMealError,
  type NeisMealQuery,
  validateNeisMealQuery,
} from "./neis-meal.js";
import { parseSeedMealMenu, type SeedMealMenuItem } from "./meal-seed.js";
import {
  authenticateOperator,
  lockAndRevalidateOperator,
  type AuthenticatedOperator,
} from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const IMPORT_LOCK_NAME = "classhub:meal-import";

interface SyncCounts {
  failed: number;
  inserted: number;
  replacedSeed: number;
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

type NeisMealFetcher = (query: NeisMealQuery) => Promise<NeisMeal[]>;

export interface SyncNeisMealsInput {
  apiKey: string | undefined;
  dryRun?: boolean;
  eduOfficeCode: string;
  fetchMeals?: NeisMealFetcher;
  from: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  replaceSeed?: boolean;
  schoolCode: string;
  to: string;
}

export interface SyncNeisMealsResult {
  checksum: string;
  dryRun: boolean;
  failedCount: 0;
  insertedCount: number;
  replacedSeedCount: number;
  runId: string;
  skippedCount: number;
  updatedCount: number;
}

export class NeisMealSyncBusyError extends Error {
  readonly code = "NEIS_MEAL_SYNC_BUSY";

  constructor() {
    super("다른 급식 import 또는 NEIS 동기화가 실행 중입니다. 잠시 후 다시 시도해 주세요.");
    this.name = "NeisMealSyncBusyError";
  }
}

export class NeisMealSyncSchoolNotFoundError extends Error {
  readonly code = "NEIS_MEAL_SCHOOL_NOT_FOUND";

  constructor() {
    super("기존 schools row가 없는 학교는 NEIS 급식을 동기화할 수 없습니다.");
    this.name = "NeisMealSyncSchoolNotFoundError";
  }
}

function emptyCounts(failed = 0): SyncCounts {
  return { failed, inserted: 0, replacedSeed: 0, skipped: 0, updated: 0 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestFileName(
  input: Pick<NeisMealQuery, "eduOfficeCode" | "from" | "schoolCode" | "to">,
): string {
  return ["neis", input.eduOfficeCode, input.schoolCode, input.from, input.to].join(":");
}

function normalizedChecksum(meals: NeisMeal[]): string {
  return sha256(
    JSON.stringify(
      meals.map((meal) => ({
        calorie_kcal_tenths: meal.calorieKcalTenths,
        edu_office_code: meal.eduOfficeCode,
        meal_date: meal.mealDate,
        menu_json: meal.menuJson,
        school_code: meal.schoolCode,
        source_loaded_on: meal.sourceLoadedOn,
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
    .insertInto("meal_import_logs")
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
      action: "meal.imported",
      actor_type: "operator",
      after_json: operatorJson(transaction, auditPayload(context, counts, result)),
      before_json: null,
      checksum: context.checksum,
      operator_id: context.operatorId,
      run_id: context.runId,
      target_id: "global",
      target_type: "meal_import",
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
  if (school === undefined) throw new NeisMealSyncSchoolNotFoundError();
}

function menuSignature(value: unknown): string | null {
  try {
    value = parseOperatorJson(value);
    const menu = parseSeedMealMenu(value);
    return JSON.stringify(menu);
  } catch {
    return null;
  }
}

function sameMenu(existing: unknown, expected: SeedMealMenuItem[]): boolean {
  return menuSignature(existing) === JSON.stringify(expected);
}

function databaseDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

async function applyMeal(
  transaction: Transaction<DB>,
  meal: NeisMeal,
  counts: SyncCounts,
  changedAt: Date,
  applyChanges: boolean,
  replaceSeed: boolean,
): Promise<void> {
  const query = transaction
    .selectFrom("meals")
    .select([
      "calorie_kcal_tenths",
      "id",
      "menu_json",
      "source",
      operatorDateText(transaction, "source_loaded_on").as("source_loaded_on"),
    ])
    .where("edu_office_code", "=", meal.eduOfficeCode)
    .where("school_code", "=", meal.schoolCode)
    .where("meal_date", "=", operatorDate(transaction, meal.mealDate))
    .where("meal_type", "=", "lunch");
  const existing = applyChanges
    ? await query.forUpdate().executeTakeFirst()
    : await query.executeTakeFirst();

  if (existing === undefined) {
    if (applyChanges) {
      await transaction
        .insertInto("meals")
        .values({
          calorie_kcal_tenths: meal.calorieKcalTenths,
          edu_office_code: meal.eduOfficeCode,
          meal_date: meal.mealDate,
          meal_type: "lunch",
          menu_json: operatorJson(transaction, meal.menuJson),
          school_code: meal.schoolCode,
          source: "neis",
          source_loaded_on: meal.sourceLoadedOn,
          source_updated_at: changedAt,
        })
        .execute();
    }
    counts.inserted += 1;
    return;
  }

  if (existing.source === "seed" && !replaceSeed) {
    counts.skipped += 1;
    return;
  }
  if (existing.source !== "seed" && existing.source !== "neis") {
    throw new NeisMealError("INVALID_NEIS_RESPONSE", "지원하지 않는 기존 급식 출처가 있습니다.");
  }
  if (
    existing.source === "neis" &&
    existing.calorie_kcal_tenths === meal.calorieKcalTenths &&
    sameMenu(existing.menu_json, meal.menuJson) &&
    databaseDate(existing.source_loaded_on) === meal.sourceLoadedOn
  ) {
    counts.skipped += 1;
    return;
  }

  if (applyChanges) {
    await transaction
      .updateTable("meals")
      .set({
        calorie_kcal_tenths: meal.calorieKcalTenths,
        menu_json: operatorJson(transaction, meal.menuJson),
        source: "neis",
        source_loaded_on: meal.sourceLoadedOn,
        source_updated_at: changedAt,
        updated_at: changedAt,
      })
      .where("id", "=", existing.id)
      .execute();
  }
  if (existing.source === "seed") counts.replacedSeed += 1;
  counts.updated += 1;
}

function errorCode(error: unknown): string {
  if (error instanceof NeisMealError) return error.code;
  if (error instanceof NeisMealSyncBusyError) return error.code;
  if (error instanceof NeisMealSyncSchoolNotFoundError) return error.code;
  return "NEIS_MEAL_SYNC_FAILED";
}

export async function syncNeisMeals(input: SyncNeisMealsInput): Promise<SyncNeisMealsResult> {
  const query = validateNeisMealQuery({
    apiKey: input.apiKey,
    eduOfficeCode: input.eduOfficeCode,
    from: input.from,
    schoolCode: input.schoolCode,
    to: input.to,
  });
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);
  const dryRun = input.dryRun ?? false;
  const replaceSeed = input.replaceSeed ?? false;
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

    let meals: NeisMeal[];
    try {
      meals = await (input.fetchMeals ?? fetchNeisMeals)(query);
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(database, authenticatedOperator, requestContext, 1, errorCode(error));
      }
      throw error;
    }

    const context: SyncRunContext = {
      ...requestContext,
      checksum: normalizedChecksum(meals),
    };
    const counts = emptyCounts();
    try {
      await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        const acquired = await lockOperatorTransaction(transaction, IMPORT_LOCK_NAME, {
          tryOnly: true,
        });
        if (!acquired) throw new NeisMealSyncBusyError();

        await validateSchool(transaction, query.eduOfficeCode, query.schoolCode);
        const changedAt = new Date();
        for (const meal of meals) {
          await applyMeal(transaction, meal, counts, changedAt, !dryRun, replaceSeed);
        }
        if (!dryRun) await insertRunLogs(transaction, context, counts, "success", null);
      });
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(
          database,
          authenticatedOperator,
          context,
          Math.max(1, meals.length),
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
      replacedSeedCount: counts.replacedSeed,
      runId,
      skippedCount: counts.skipped,
      updatedCount: counts.updated,
    };
  } finally {
    await database.destroy();
  }
}
