import { lockOperatorTransaction } from "./operator-lock.js";
import { operatorJson } from "./operator-query.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { type DB } from "@classhub/db";
import { type Transaction } from "kysely";

import {
  authenticateOperator,
  lockAndRevalidateOperator,
  type AuthenticatedOperator,
} from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";
import {
  parseSchoolSeedJson,
  type SchoolKind,
  type SchoolSeedItem,
  SchoolSeedValidationError,
} from "./school-seed.js";

const MAX_SCHOOL_FILE_BYTES = 20 * 1024 * 1024;
const IMPORT_LOCK_NAME = "classhub:school-import";

interface ImportCounts {
  failed: number;
  inserted: number;
  skipped: number;
  updated: number;
}

export interface LoadedSchoolSeed {
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

export interface ImportSchoolsInput {
  dryRun?: boolean;
  filePath: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
}

export interface ImportSchoolsResult {
  checksum: string;
  dryRun: boolean;
  failedCount: 0;
  insertedCount: number;
  runId: string;
  skippedCount: number;
  updatedCount: number;
}

export interface ImportSchoolSourceInput {
  dryRun?: boolean;
  loadSource: () => Promise<LoadedSchoolSeed>;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  sourceErrorCode?: (error: unknown) => string | undefined;
  sourceFailureIdentity?: Pick<LoadedSchoolSeed, "checksum" | "fileName">;
}

export class SchoolImportBusyError extends Error {
  readonly code = "SCHOOL_IMPORT_BUSY";

  constructor() {
    super("다른 학교 import가 실행 중입니다. 잠시 후 다시 시도해 주세요.");
    this.name = "SchoolImportBusyError";
  }
}

export class SchoolKindGradeConflictError extends Error {
  readonly code = "SCHOOL_KIND_GRADE_CONFLICT";

  constructor(item: Pick<SchoolSeedItem, "eduOfficeCode" | "schoolCode" | "schoolKind">) {
    super(
      `${item.eduOfficeCode}:${item.schoolCode} 학교를 ${item.schoolKind}로 변경할 수 없는 기존 학년이 있습니다.`,
    );
    this.name = "SchoolKindGradeConflictError";
  }
}

function emptyCounts(failed = 0): ImportCounts {
  return { failed, inserted: 0, skipped: 0, updated: 0 };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function loadSchoolSeed(filePath: string): Promise<LoadedSchoolSeed> {
  const information = await stat(filePath);
  if (!information.isFile()) throw new Error("학교 seed 경로가 파일이 아닙니다.");
  const fileName = basename(filePath);
  if (fileName.trim() === "") throw new Error("학교 seed 파일 이름이 비어 있습니다.");

  if (information.size > MAX_SCHOOL_FILE_BYTES) {
    const error = new SchoolSeedValidationError("학교 seed 파일은 20MB를 초과할 수 없습니다.");
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

function auditPayload(
  context: ImportRunContext,
  counts: ImportCounts,
  result: "failed" | "success",
) {
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
  context: ImportRunContext,
  counts: ImportCounts,
  result: "failed" | "success",
  errorCode: string | null,
): Promise<void> {
  const completedAt = new Date();
  await transaction
    .insertInto("school_import_logs")
    .values({
      checksum: context.checksum,
      completed_at: completedAt,
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
      action: "school.imported",
      actor_type: "operator",
      after_json: operatorJson(transaction, auditPayload(context, counts, result)),
      before_json: null,
      checksum: context.checksum,
      operator_id: context.operatorId,
      run_id: context.runId,
      target_id: "global",
      target_type: "school_import",
    })
    .execute();
}

async function recordFailedRun(
  database: Parameters<typeof authenticateOperator>[0],
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

function maximumGrade(schoolKind: SchoolKind): number {
  return schoolKind === "elementary" ? 6 : 3;
}

function sameSchool(
  existing: {
    edu_office_name: string;
    homepage_url: string | null;
    phone_number: string | null;
    region_name: string;
    road_address: string | null;
    road_address_detail: string | null;
    school_kind: string;
    school_name: string;
  },
  expected: SchoolSeedItem,
): boolean {
  return (
    existing.edu_office_name === expected.eduOfficeName &&
    (expected.homepageUrl == null || existing.homepage_url === expected.homepageUrl) &&
    (expected.phoneNumber == null || existing.phone_number === expected.phoneNumber) &&
    existing.region_name === expected.regionName &&
    (expected.roadAddress == null || existing.road_address === expected.roadAddress) &&
    (expected.roadAddressDetail == null ||
      existing.road_address_detail === expected.roadAddressDetail) &&
    existing.school_kind === expected.schoolKind &&
    existing.school_name === expected.schoolName
  );
}

async function applySchoolItem(
  transaction: Transaction<DB>,
  item: SchoolSeedItem,
  counts: ImportCounts,
  changedAt: Date,
  applyChanges: boolean,
): Promise<void> {
  const query = transaction
    .selectFrom("schools")
    .select([
      "edu_office_name",
      "homepage_url",
      "phone_number",
      "region_name",
      "road_address",
      "road_address_detail",
      "school_kind",
      "school_name",
    ])
    .where("edu_office_code", "=", item.eduOfficeCode)
    .where("school_code", "=", item.schoolCode);
  const existing = applyChanges
    ? await query.forUpdate().executeTakeFirst()
    : await query.executeTakeFirst();

  if (existing === undefined) {
    if (applyChanges) {
      await transaction
        .insertInto("schools")
        .values({
          edu_office_code: item.eduOfficeCode,
          edu_office_name: item.eduOfficeName,
          homepage_url: item.homepageUrl ?? null,
          phone_number: item.phoneNumber ?? null,
          region_name: item.regionName,
          road_address: item.roadAddress ?? null,
          road_address_detail: item.roadAddressDetail ?? null,
          school_code: item.schoolCode,
          school_kind: item.schoolKind,
          school_name: item.schoolName,
        })
        .execute();
    }
    counts.inserted += 1;
    return;
  }

  if (sameSchool(existing, item)) {
    counts.skipped += 1;
    return;
  }

  if (existing.school_kind !== item.schoolKind) {
    const incompatibleClass = await transaction
      .selectFrom("classes")
      .select("grade")
      .where("edu_office_code", "=", item.eduOfficeCode)
      .where("school_code", "=", item.schoolCode)
      .where("grade", ">", maximumGrade(item.schoolKind))
      .limit(1)
      .executeTakeFirst();
    if (incompatibleClass !== undefined) throw new SchoolKindGradeConflictError(item);
  }

  if (applyChanges) {
    await transaction
      .updateTable("schools")
      .set({
        edu_office_name: item.eduOfficeName,
        ...(item.homepageUrl == null ? {} : { homepage_url: item.homepageUrl }),
        ...(item.phoneNumber == null ? {} : { phone_number: item.phoneNumber }),
        region_name: item.regionName,
        ...(item.roadAddress == null ? {} : { road_address: item.roadAddress }),
        ...(item.roadAddressDetail == null ? {} : { road_address_detail: item.roadAddressDetail }),
        school_kind: item.schoolKind,
        school_name: item.schoolName,
        updated_at: changedAt,
      })
      .where("edu_office_code", "=", item.eduOfficeCode)
      .where("school_code", "=", item.schoolCode)
      .execute();
  }
  counts.updated += 1;
}

function sortedSchools(items: SchoolSeedItem[]): SchoolSeedItem[] {
  return [...items].sort(
    (left, right) =>
      left.eduOfficeCode.localeCompare(right.eduOfficeCode, "en") ||
      left.schoolCode.localeCompare(right.schoolCode, "en"),
  );
}

function errorCode(
  error: unknown,
  sourceErrorCode?: ImportSchoolSourceInput["sourceErrorCode"],
): string {
  const sourceCode = sourceErrorCode?.(error);
  if (sourceCode !== undefined) return sourceCode;
  if (error instanceof SchoolSeedValidationError) return error.code;
  if (error instanceof SchoolImportBusyError) return error.code;
  if (error instanceof SchoolKindGradeConflictError) return error.code;
  return "SCHOOL_IMPORT_FAILED";
}

export async function importSchoolSource(
  input: ImportSchoolSourceInput,
): Promise<ImportSchoolsResult> {
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);
  const dryRun = input.dryRun ?? false;
  const runId = randomUUID();
  const startedAt = new Date();

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);
    let loaded: LoadedSchoolSeed;
    try {
      loaded = await input.loadSource();
    } catch (error) {
      const detail =
        error instanceof SchoolSeedValidationError &&
        typeof (error as SchoolSeedValidationError & { checksum?: unknown }).checksum ===
          "string" &&
        typeof (error as SchoolSeedValidationError & { fileName?: unknown }).fileName === "string"
          ? (error as SchoolSeedValidationError & {
              checksum: string;
              fileName: string;
            })
          : input.sourceFailureIdentity;
      if (!dryRun && detail !== undefined) {
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
          errorCode(error, input.sourceErrorCode),
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
      parsed = parseSchoolSeedJson(loaded.text);
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(
          database,
          authenticatedOperator,
          context,
          1,
          errorCode(error, input.sourceErrorCode),
        );
      }
      throw error;
    }

    const counts = emptyCounts();
    try {
      await database.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        const acquired = await lockOperatorTransaction(transaction, IMPORT_LOCK_NAME, {
          tryOnly: true,
        });
        if (!acquired) throw new SchoolImportBusyError();

        const changedAt = new Date();
        for (const item of sortedSchools(parsed.items)) {
          await applySchoolItem(transaction, item, counts, changedAt, !dryRun);
        }
        if (!dryRun) await insertRunLogs(transaction, context, counts, "success", null);
      });
    } catch (error) {
      if (!dryRun) {
        await recordFailedRun(
          database,
          authenticatedOperator,
          context,
          Math.max(1, parsed.items.length),
          errorCode(error, input.sourceErrorCode),
        );
      }
      throw error;
    }

    return {
      checksum: loaded.checksum,
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

export async function importSchools(input: ImportSchoolsInput): Promise<ImportSchoolsResult> {
  return importSchoolSource({
    dryRun: input.dryRun ?? false,
    loadSource: () => loadSchoolSeed(input.filePath),
    operatorDatabaseUrl: input.operatorDatabaseUrl,
    operatorToken: input.operatorToken,
  });
}
