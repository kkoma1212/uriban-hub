import { lockOperatorTransaction } from "./operator-lock.js";
import { operatorJson, operatorDate, parseOperatorJson } from "./operator-query.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { type DB } from "@classhub/db";
import { type Kysely, type Transaction } from "kysely";

import {
  MealSeedValidationError,
  parseMealSeedJson,
  parseSeedMealMenu,
  type MealSeedItem,
  type SeedMealMenuItem,
} from "./meal-seed.js";
import {
  authenticateOperator,
  lockAndRevalidateOperator,
  type AuthenticatedOperator,
} from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const MAX_MEAL_FILE_BYTES = 5 * 1024 * 1024;
const IMPORT_LOCK_NAME = "classhub:meal-import";

interface ImportCounts {
  deleted: number;
  failed: number;
  inserted: number;
  skipped: number;
  updated: number;
}

interface LoadedMealSeed {
  checksum: string;
  fileName: string;
  text: string;
}

interface ImportRunContext {
  checksum: string;
  fileName: string;
  operatorId: string;
  runId: string;
  startedAt: Date;
}

export interface ImportMealsInput {
  filePath: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
}

export interface ImportMealsResult {
  checksum: string;
  deletedCount: number;
  failedCount: 0;
  insertedCount: number;
  runId: string;
  skippedCount: number;
  updatedCount: number;
}

export class MealImportBusyError extends Error {
  readonly code = "MEAL_IMPORT_BUSY";

  constructor() {
    super("다른 급식 import가 실행 중입니다. 잠시 후 다시 시도해 주세요.");
    this.name = "MealImportBusyError";
  }
}

export class MealSourceOwnershipError extends Error {
  readonly code = "MEAL_SOURCE_OWNERSHIP_CONFLICT";

  constructor() {
    super("seed import는 NEIS 출처 급식을 변경하거나 삭제할 수 없습니다.");
    this.name = "MealSourceOwnershipError";
  }
}

function emptyCounts(failed = 0): ImportCounts {
  return { deleted: 0, failed, inserted: 0, skipped: 0, updated: 0 };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function loadMealSeed(filePath: string): Promise<LoadedMealSeed> {
  const information = await stat(filePath);
  if (!information.isFile()) throw new Error("급식 seed 경로가 파일이 아닙니다.");
  const fileName = basename(filePath);
  if (fileName.trim() === "") throw new Error("급식 seed 파일 이름이 비어 있습니다.");

  if (information.size > MAX_MEAL_FILE_BYTES) {
    const error = new MealSeedValidationError("급식 seed 파일은 5MB를 초과할 수 없습니다.");
    Object.assign(error, { checksum: await sha256File(filePath), fileName });
    throw error;
  }
  const buffer = await readFile(filePath);
  return {
    checksum: createHash("sha256").update(buffer).digest("hex"),
    fileName,
    text: buffer.toString("utf8"),
  };
}

export { lockAndRevalidateOperator } from "./operator-auth.js";

function schoolKey(item: Pick<MealSeedItem, "eduOfficeCode" | "schoolCode">): string {
  return `${item.eduOfficeCode}:${item.schoolCode}`;
}

async function validateSchools(database: Kysely<DB>, items: MealSeedItem[]): Promise<void> {
  const required = new Set(items.map(schoolKey));
  if (required.size === 0) return;
  const schools = await database
    .selectFrom("schools")
    .select(["edu_office_code", "school_code"])
    .execute();
  const existing = new Set(
    schools.map((school) => `${school.edu_office_code}:${school.school_code}`),
  );
  const missing = [...required].filter((key) => !existing.has(key));
  if (missing.length > 0) {
    throw new MealSeedValidationError("기존 schools row가 없는 급식 항목이 있습니다.");
  }
}

function menuSignature(value: unknown): string | null {
  try {
    value = parseOperatorJson(value);
    const menu = parseSeedMealMenu(value);
    if (
      !Array.isArray(value) ||
      value.some(
        (item, index) =>
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          !("name" in item) ||
          item.name !== menu[index]?.name,
      )
    ) {
      return null;
    }
    return JSON.stringify(menu.map((item) => ({ allergens: item.allergens, name: item.name })));
  } catch {
    return null;
  }
}

function sameMenu(existing: unknown, expected: SeedMealMenuItem[]): boolean {
  return menuSignature(existing) === JSON.stringify(expected);
}

function auditPayload(
  context: ImportRunContext,
  counts: ImportCounts,
  result: "failed" | "success",
) {
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

async function insertRunLogs(
  transaction: Transaction<DB>,
  context: ImportRunContext,
  counts: ImportCounts,
  result: "failed" | "success",
  errorCode: string | null,
): Promise<void> {
  const completedAt = new Date();
  const payload = auditPayload(context, counts, result);
  await transaction
    .insertInto("meal_import_logs")
    .values({
      checksum: context.checksum,
      completed_at: completedAt,
      deleted_count: counts.deleted,
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
      after_json: operatorJson(transaction, payload),
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
  context: ImportRunContext,
  failedCount: number,
  errorCode: string,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await lockAndRevalidateOperator(transaction, authenticatedOperator);
    await insertRunLogs(transaction, context, emptyCounts(failedCount), "failed", errorCode);
  });
}

async function applyMealItem(
  transaction: Transaction<DB>,
  item: MealSeedItem,
  counts: ImportCounts,
  changedAt: Date,
): Promise<void> {
  const existing = await transaction
    .selectFrom("meals")
    .select(["id", "menu_json", "source"])
    .where("edu_office_code", "=", item.eduOfficeCode)
    .where("school_code", "=", item.schoolCode)
    .where("meal_date", "=", operatorDate(transaction, item.mealDate))
    .where("meal_type", "=", item.mealType)
    .forUpdate()
    .executeTakeFirst();

  if (existing !== undefined && existing.source !== "seed") {
    throw new MealSourceOwnershipError();
  }

  if (item.operation === "delete") {
    if (existing === undefined) {
      counts.skipped += 1;
      return;
    }
    await transaction.deleteFrom("meals").where("id", "=", existing.id).execute();
    counts.deleted += 1;
    return;
  }

  if (existing === undefined) {
    await transaction
      .insertInto("meals")
      .values({
        edu_office_code: item.eduOfficeCode,
        meal_date: item.mealDate,
        meal_type: item.mealType,
        menu_json: operatorJson(transaction, item.menuJson),
        school_code: item.schoolCode,
        source: "seed",
        source_updated_at: changedAt,
      })
      .execute();
    counts.inserted += 1;
    return;
  }

  if (sameMenu(existing.menu_json, item.menuJson)) {
    counts.skipped += 1;
    return;
  }
  await transaction
    .updateTable("meals")
    .set({
      menu_json: operatorJson(transaction, item.menuJson),
      source: "seed",
      source_loaded_on: null,
      source_updated_at: changedAt,
      updated_at: changedAt,
    })
    .where("id", "=", existing.id)
    .execute();
  counts.updated += 1;
}

function errorCode(error: unknown): string {
  if (error instanceof MealSeedValidationError) return error.code;
  if (error instanceof MealImportBusyError) return error.code;
  if (error instanceof MealSourceOwnershipError) return error.code;
  return "MEAL_IMPORT_FAILED";
}

export async function importMeals(input: ImportMealsInput): Promise<ImportMealsResult> {
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);
  const runId = randomUUID();
  const startedAt = new Date();

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);
    let loaded: LoadedMealSeed;
    try {
      loaded = await loadMealSeed(input.filePath);
    } catch (error) {
      if (
        error instanceof MealSeedValidationError &&
        typeof (error as MealSeedValidationError & { checksum?: unknown }).checksum === "string" &&
        typeof (error as MealSeedValidationError & { fileName?: unknown }).fileName === "string"
      ) {
        const detail = error as MealSeedValidationError & { checksum: string; fileName: string };
        await recordFailedRun(
          database,
          authenticatedOperator,
          {
            checksum: detail.checksum,
            fileName: detail.fileName,
            operatorId: authenticatedOperator.operatorId,
            runId,
            startedAt,
          },
          1,
          error.code,
        );
      }
      throw error;
    }
    const context: ImportRunContext = {
      checksum: loaded.checksum,
      fileName: loaded.fileName,
      operatorId: authenticatedOperator.operatorId,
      runId,
      startedAt,
    };

    let parsed;
    try {
      parsed = parseMealSeedJson(loaded.text);
      await validateSchools(database, parsed.items);
    } catch (error) {
      await recordFailedRun(database, authenticatedOperator, context, 1, errorCode(error));
      throw error;
    }

    const counts = emptyCounts();
    try {
      await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        const acquired = await lockOperatorTransaction(transaction, IMPORT_LOCK_NAME, {
          tryOnly: true,
        });
        if (!acquired) throw new MealImportBusyError();

        const changedAt = new Date();
        for (const item of parsed.items) {
          await applyMealItem(transaction, item, counts, changedAt);
        }
        await insertRunLogs(transaction, context, counts, "success", null);
      });
    } catch (error) {
      await recordFailedRun(
        database,
        authenticatedOperator,
        context,
        Math.max(1, parsed.items.length),
        errorCode(error),
      );
      throw error;
    }

    return {
      checksum: loaded.checksum,
      deletedCount: counts.deleted,
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
