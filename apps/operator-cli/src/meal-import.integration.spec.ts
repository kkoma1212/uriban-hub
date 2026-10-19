import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  importMeals,
  lockAndRevalidateOperator,
  MealImportBusyError,
  MealSourceOwnershipError,
} from "./meal-import.js";
import { MealSeedValidationError } from "./meal-seed.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";
import { bootstrapOperator } from "./operator-bootstrap.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

const operatorToken = "meal-import-integration-operator-token";
const school = { eduOfficeCode: "B10", schoolCode: "7010123" };

let postgres: StartedNativeTestService;
let database: ReturnType<typeof createDatabase<DB>>;
let migratorDatabaseUrl: string;
let operatorDatabaseUrl: string;
let directory: string;

function host(): string {
  return postgres.getHost() === "localhost" ? "127.0.0.1" : postgres.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${host()}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(migratorDatabaseUrl);
  try {
    await sql
      .raw(
        `CREATE TABLE pgmigrations (
          id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, run_on TIMESTAMPTZ NOT NULL
        )`,
      )
      .execute(migrator);
    for (const path of await loadAllTestMigrationPaths()) {
      const migration = await readFile(path, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

function upsert(date: string, name: string) {
  return {
    operation: "upsert",
    edu_office_code: school.eduOfficeCode,
    school_code: school.schoolCode,
    meal_date: date,
    meal_type: "lunch",
    menu_json: [{ name, allergens: ["1"] }],
  };
}

function deletion(date: string) {
  return {
    operation: "delete",
    edu_office_code: school.eduOfficeCode,
    school_code: school.schoolCode,
    meal_date: date,
    meal_type: "lunch",
  };
}

async function seedFile(name: string, items: unknown[]): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ schema_version: 1, items }), "utf8");
  return path;
}

beforeAll(async () => {
  postgres = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  database = createDatabase<DB>(postgresUrl("classhub_bootstrap", "local_bootstrap_password"));
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(database);
  migratorDatabaseUrl = postgresUrl("classhub_migrator", "local_migrator_password");
  await applyMigrations();
  operatorDatabaseUrl = postgresUrl("classhub_operator", "local_operator_password");
  await database
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update(operatorToken, "utf8").digest(),
      email_normalized: "meal-importer@classhub.local",
    })
    .execute();
  await database
    .insertInto("schools")
    .values({
      edu_office_code: school.eduOfficeCode,
      edu_office_name: "서울특별시교육청",
      region_name: "서울특별시",
      school_code: school.schoolCode,
      school_kind: "high",
      school_name: "급식 통합 테스트 고등학교",
    })
    .execute();
  directory = await mkdtemp(join(tmpdir(), "classhub-meal-import-"));
}, 120_000);

beforeEach(async () => {
  await database.deleteFrom("operator_audit_logs").where("action", "=", "meal.imported").execute();
  await database.deleteFrom("meal_import_logs").execute();
  await database.deleteFrom("meals").execute();
});

afterAll(async () => {
  await Promise.allSettled([
    database?.destroy(),
    postgres?.stop(),
    rm(directory, { recursive: true }),
  ]);
}, 120_000);

describe("meal seed importer", () => {
  it("bootstraps the first operator through the dedicated operator role", async () => {
    await database.deleteFrom("operators").execute();
    let runId: string | undefined;
    try {
      const result = await bootstrapOperator({
        bootstrapSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
        email: "first-operator@classhub.local",
        operatorDatabaseUrl,
      });
      runId = result.runId;

      const operator = await database
        .selectFrom("operators")
        .select(["email_normalized", "status"])
        .where("id", "=", result.operatorId)
        .executeTakeFirstOrThrow();
      expect(operator).toEqual({
        email_normalized: "first-operator@classhub.local",
        status: "active",
      });
      await expect(
        bootstrapOperator({
          bootstrapSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
          email: "second-operator@classhub.local",
          operatorDatabaseUrl,
        }),
      ).rejects.toThrow("operators table이 비어 있을 때만");
    } finally {
      if (runId !== undefined) {
        await database.deleteFrom("operator_audit_logs").where("run_id", "=", runId).execute();
      }
      await database.deleteFrom("operators").execute();
      await database
        .insertInto("operators")
        .values({
          credential_hash: createHash("sha256").update(operatorToken, "utf8").digest(),
          email_normalized: "meal-importer@classhub.local",
        })
        .execute();
    }
  });

  it("rejects the migrator connection before either operator command can mutate data", async () => {
    const seed = await seedFile("wrong-role.json", [upsert("2026-07-14", "역할 검증")]);

    await expect(
      importMeals({
        filePath: seed,
        operatorDatabaseUrl: migratorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toThrow("classhub_operator");
    await expect(
      bootstrapOperator({
        bootstrapSecret: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH",
        email: "new-operator@classhub.local",
        operatorDatabaseUrl: migratorDatabaseUrl,
      }),
    ).rejects.toThrow("classhub_operator");

    expect(
      (
        await database
          .selectFrom("operators")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("1");
    expect(
      (
        await database
          .selectFrom("meals")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
  });

  it("holds the shared operator lifecycle lock while revalidating the exact token", async () => {
    const operatorDatabase = createDatabase<DB>(operatorDatabaseUrl);
    const operator = await database
      .selectFrom("operators")
      .select("id")
      .where("email_normalized", "=", "meal-importer@classhub.local")
      .executeTakeFirstOrThrow();
    const authenticatedOperator = {
      credentialHash: createHash("sha256").update(operatorToken, "utf8").digest(),
      operatorId: operator.id,
    };

    try {
      await operatorDatabase.transaction().execute(async (transaction) => {
        await lockAndRevalidateOperator(transaction, authenticatedOperator);
        await expect(
          database.transaction().execute(async (lifecycleTransaction) => {
            await sql`SET LOCAL lock_timeout = '100ms'`.execute(lifecycleTransaction);
            await sql`
              SELECT pg_advisory_xact_lock(
                hashtextextended('classhub:operator-lifecycle', 0)
              )
            `.execute(lifecycleTransaction);
          }),
        ).rejects.toMatchObject({ code: "55P03" });
      });

      await expect(
        operatorDatabase.transaction().execute((transaction) =>
          lockAndRevalidateOperator(transaction, {
            credentialHash: Buffer.alloc(32),
            operatorId: operator.id,
          }),
        ),
      ).rejects.toThrow("유효한 active operator token");
    } finally {
      await operatorDatabase.destroy();
    }
  });

  it("inserts, skips an identical rerun, and restores A after A→B→A", async () => {
    const a = await seedFile("a.json", [upsert("2026-07-14", "A 메뉴")]);
    const b = await seedFile("b.json", [upsert("2026-07-14", "B 메뉴")]);

    const first = await importMeals({
      filePath: a,
      operatorDatabaseUrl,
      operatorToken,
    });
    const same = await importMeals({
      filePath: a,
      operatorDatabaseUrl,
      operatorToken,
    });
    const changed = await importMeals({
      filePath: b,
      operatorDatabaseUrl,
      operatorToken,
    });
    const restored = await importMeals({
      filePath: a,
      operatorDatabaseUrl,
      operatorToken,
    });

    expect(first).toMatchObject({ insertedCount: 1, skippedCount: 0, updatedCount: 0 });
    expect(same).toMatchObject({ insertedCount: 0, skippedCount: 1, updatedCount: 0 });
    expect(changed).toMatchObject({ insertedCount: 0, skippedCount: 0, updatedCount: 1 });
    expect(restored).toMatchObject({ insertedCount: 0, skippedCount: 0, updatedCount: 1 });
    expect(restored.checksum).toBe(first.checksum);

    const row = await database.selectFrom("meals").select("menu_json").executeTakeFirstOrThrow();
    expect(row.menu_json).toEqual([{ allergens: ["1"], name: "A 메뉴" }]);
    const logs = await database
      .selectFrom("meal_import_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const audits = await database
      .selectFrom("operator_audit_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("action", "=", "meal.imported")
      .executeTakeFirstOrThrow();
    expect(logs.count).toBe("4");
    expect(audits.count).toBe("4");
  });

  it("changes zero meal rows when any schema item is invalid and records a failed run", async () => {
    const baseline = await seedFile("baseline.json", [upsert("2026-07-14", "기존 메뉴")]);
    await importMeals({ filePath: baseline, operatorDatabaseUrl, operatorToken });
    await database
      .deleteFrom("operator_audit_logs")
      .where("action", "=", "meal.imported")
      .execute();
    await database.deleteFrom("meal_import_logs").execute();
    const invalid = await seedFile("invalid.json", [
      upsert("2026-07-14", "변경 시도"),
      {
        ...upsert("2026-07-15", "잘못된 메뉴"),
        menu_json: [{ name: "잘못된 메뉴", allergens: ["1", "1"] }],
      },
    ]);

    await expect(
      importMeals({ filePath: invalid, operatorDatabaseUrl, operatorToken }),
    ).rejects.toBeInstanceOf(MealSeedValidationError);
    const row = await database.selectFrom("meals").select("menu_json").executeTakeFirstOrThrow();
    expect(row.menu_json).toEqual([{ allergens: ["1"], name: "기존 메뉴" }]);
    const log = await database
      .selectFrom("meal_import_logs")
      .select(["error_json", "result"])
      .executeTakeFirstOrThrow();
    expect(log).toEqual({ error_json: { code: "INVALID_MEAL_SEED" }, result: "failed" });
    const audit = await database
      .selectFrom("operator_audit_logs")
      .select("after_json")
      .where("action", "=", "meal.imported")
      .executeTakeFirstOrThrow();
    expect(audit.after_json).toMatchObject({ failed_count: 1, result: "failed" });
  });

  it("counts an existing delete and a missing delete without partial behavior", async () => {
    const baseline = await seedFile("delete-baseline.json", [upsert("2026-07-14", "삭제할 메뉴")]);
    await importMeals({ filePath: baseline, operatorDatabaseUrl, operatorToken });
    const deletes = await seedFile("delete.json", [deletion("2026-07-14"), deletion("2026-07-15")]);

    const result = await importMeals({
      filePath: deletes,
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(result).toMatchObject({ deletedCount: 1, skippedCount: 1 });
    const rows = await database
      .selectFrom("meals")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(rows.count).toBe("0");
  });

  it("refuses to overwrite a NEIS-owned row through the seed importer", async () => {
    await database
      .insertInto("meals")
      .values({
        edu_office_code: school.eduOfficeCode,
        meal_date: "2026-07-14",
        meal_type: "lunch",
        menu_json: sql`'[{"name":"NEIS 원본","allergens":["1"]}]'::jsonb`,
        school_code: school.schoolCode,
        source: "neis",
        source_loaded_on: "2026-07-29",
        source_updated_at: new Date("2026-07-29T00:00:00Z"),
      })
      .execute();
    const attempted = await seedFile("neis-conflict.json", [upsert("2026-07-14", "seed 덮어쓰기")]);

    await expect(
      importMeals({ filePath: attempted, operatorDatabaseUrl, operatorToken }),
    ).rejects.toBeInstanceOf(MealSourceOwnershipError);

    const row = await database
      .selectFrom("meals")
      .select(["menu_json", "source"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      menu_json: [{ allergens: ["1"], name: "NEIS 원본" }],
      source: "neis",
    });
    const log = await database
      .selectFrom("meal_import_logs")
      .select(["error_json", "result"])
      .executeTakeFirstOrThrow();
    expect(log).toEqual({
      error_json: { code: "MEAL_SOURCE_OWNERSHIP_CONFLICT" },
      result: "failed",
    });
  });

  it("fails the whole file for a nonexistent school and when the import lock is busy", async () => {
    const missingSchool = await seedFile("missing-school.json", [
      { ...upsert("2026-07-14", "없는 학교"), school_code: "7999999" },
    ]);
    await expect(
      importMeals({ filePath: missingSchool, operatorDatabaseUrl, operatorToken }),
    ).rejects.toBeInstanceOf(MealSeedValidationError);
    expect(
      (
        await database
          .selectFrom("meals")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");

    const valid = await seedFile("locked.json", [upsert("2026-07-14", "잠금 메뉴")]);
    await database.transaction().execute(async (transaction) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('classhub:meal-import', 0))`.execute(
        transaction,
      );
      await expect(
        importMeals({ filePath: valid, operatorDatabaseUrl, operatorToken }),
      ).rejects.toBeInstanceOf(MealImportBusyError);
    });
    expect(
      (
        await database
          .selectFrom("meals")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
  });
});
