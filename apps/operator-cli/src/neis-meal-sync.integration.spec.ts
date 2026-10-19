import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NeisMealError, type NeisMeal } from "./neis-meal.js";
import { syncNeisMeals } from "./neis-meal-sync.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const operatorToken = "neis-sync-integration-operator-token";
const school = { eduOfficeCode: "M10", schoolCode: "8021028" };

let database: ReturnType<typeof createDatabase<DB>>;
let operatorDatabaseUrl: string;
let postgres: StartedNativeTestService;

function host(): string {
  return postgres.getHost() === "localhost" ? "127.0.0.1" : postgres.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${host()}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(migratorDatabaseUrl: string): Promise<void> {
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

function meal(
  date: string,
  name: string,
  loadedOn = "2026-07-29",
  calorieKcalTenths: number | null = 12_345,
): NeisMeal {
  return {
    calorieKcalTenths,
    eduOfficeCode: school.eduOfficeCode,
    mealDate: date,
    menuJson: [{ allergens: ["1"], name }],
    schoolCode: school.schoolCode,
    sourceLoadedOn: loadedOn,
  };
}

function sync(meals: NeisMeal[], options: { dryRun?: boolean; replaceSeed?: boolean } = {}) {
  return syncNeisMeals({
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.replaceSeed === undefined ? {} : { replaceSeed: options.replaceSeed }),
    apiKey: "integration-neis-api-key",
    eduOfficeCode: school.eduOfficeCode,
    fetchMeals: async () => meals,
    from: "2026-07-01",
    operatorDatabaseUrl,
    operatorToken,
    schoolCode: school.schoolCode,
    to: "2026-07-31",
  });
}

beforeAll(async () => {
  postgres = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  database = createDatabase<DB>(postgresUrl("classhub_bootstrap", "local_bootstrap_password"));
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(database);
  await applyMigrations(postgresUrl("classhub_migrator", "local_migrator_password"));
  operatorDatabaseUrl = postgresUrl("classhub_operator", "local_operator_password");
  await database
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update(operatorToken, "utf8").digest(),
      email_normalized: "neis-sync@classhub.local",
    })
    .execute();
  await database
    .insertInto("schools")
    .values({
      edu_office_code: school.eduOfficeCode,
      edu_office_name: "충청북도교육청",
      region_name: "충청북도",
      school_code: school.schoolCode,
      school_kind: "middle",
      school_name: "NEIS 연동 통합 테스트 학교",
    })
    .execute();
}, 120_000);

beforeEach(async () => {
  await database.deleteFrom("operator_audit_logs").where("action", "=", "meal.imported").execute();
  await database.deleteFrom("meal_import_logs").execute();
  await database.deleteFrom("meals").execute();
});

afterAll(async () => {
  await Promise.allSettled([database?.destroy(), postgres?.stop()]);
}, 120_000);

describe("NEIS meal sync", () => {
  it("supports no-write dry-run, insert, identical skip, and changed update", async () => {
    const firstMeal = meal("2026-07-02", "첫 급식");
    const dryRun = await sync([firstMeal], { dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      insertedCount: 1,
      skippedCount: 0,
      updatedCount: 0,
    });
    expect(
      (
        await database
          .selectFrom("meals")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
    expect(
      (
        await database
          .selectFrom("meal_import_logs")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");

    const inserted = await sync([firstMeal]);
    const skipped = await sync([firstMeal]);
    const updated = await sync([meal("2026-07-02", "바뀐 급식", "2026-07-30", 13_010)]);
    const calorieOnlyUpdated = await sync([meal("2026-07-02", "바뀐 급식", "2026-07-30", 13_011)]);
    expect(inserted).toMatchObject({ insertedCount: 1, skippedCount: 0, updatedCount: 0 });
    expect(skipped).toMatchObject({ insertedCount: 0, skippedCount: 1, updatedCount: 0 });
    expect(updated).toMatchObject({ insertedCount: 0, skippedCount: 0, updatedCount: 1 });
    expect(calorieOnlyUpdated).toMatchObject({
      insertedCount: 0,
      skippedCount: 0,
      updatedCount: 1,
    });

    const row = await database
      .selectFrom("meals")
      .select([
        "calorie_kcal_tenths",
        "menu_json",
        "source",
        sql<string>`source_loaded_on::text`.as("source_loaded_on"),
      ])
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      calorie_kcal_tenths: 13_011,
      menu_json: [{ allergens: ["1"], name: "바뀐 급식" }],
      source: "neis",
    });
    expect(row.source_loaded_on).toBe("2026-07-30");
    const logs = await database
      .selectFrom("meal_import_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(logs.count).toBe("4");
  });

  it("preserves seed by default and replaces it only with the explicit flag", async () => {
    await database
      .insertInto("meals")
      .values({
        edu_office_code: school.eduOfficeCode,
        meal_date: "2026-07-03",
        meal_type: "lunch",
        menu_json: sql`'[{"name":"운영 seed","allergens":[]}]'::jsonb`,
        school_code: school.schoolCode,
        source: "seed",
        source_loaded_on: null,
        source_updated_at: new Date("2026-07-01T00:00:00Z"),
      })
      .execute();

    const preserved = await sync([meal("2026-07-03", "NEIS 급식")]);
    expect(preserved).toMatchObject({
      replacedSeedCount: 0,
      skippedCount: 1,
      updatedCount: 0,
    });
    expect(
      (await database.selectFrom("meals").select(["source", "menu_json"]).executeTakeFirstOrThrow())
        .source,
    ).toBe("seed");

    const replaced = await sync([meal("2026-07-03", "NEIS 급식")], { replaceSeed: true });
    expect(replaced).toMatchObject({
      replacedSeedCount: 1,
      skippedCount: 0,
      updatedCount: 1,
    });
    expect(
      (await database.selectFrom("meals").select(["source", "menu_json"]).executeTakeFirstOrThrow())
        .source,
    ).toBe("neis");
  });

  it("never deletes a last-known meal merely because the next response omits it", async () => {
    await sync([meal("2026-07-04", "유지 급식"), meal("2026-07-05", "다른 급식")]);
    await sync([meal("2026-07-05", "다른 급식")]);

    const rows = await database
      .selectFrom("meals")
      .select(["meal_date", "menu_json"])
      .orderBy("meal_date")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.menu_json).toEqual([{ allergens: ["1"], name: "유지 급식" }]);
  });

  it("writes a redacted failed audit without changing meals when NEIS fails", async () => {
    const secret = "must-not-appear-in-audit";
    await expect(
      syncNeisMeals({
        apiKey: secret,
        eduOfficeCode: school.eduOfficeCode,
        fetchMeals: async () => {
          throw new NeisMealError("NEIS_REQUEST_FAILED", "NEIS 인증에 실패했습니다.");
        },
        from: "2026-07-01",
        operatorDatabaseUrl,
        operatorToken,
        schoolCode: school.schoolCode,
        to: "2026-07-31",
      }),
    ).rejects.toBeInstanceOf(NeisMealError);

    const log = await database
      .selectFrom("meal_import_logs")
      .select(["error_json", "file_name", "result"])
      .executeTakeFirstOrThrow();
    expect(log).toMatchObject({
      error_json: { code: "NEIS_REQUEST_FAILED" },
      result: "failed",
    });
    expect(JSON.stringify(log)).not.toContain(secret);
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
