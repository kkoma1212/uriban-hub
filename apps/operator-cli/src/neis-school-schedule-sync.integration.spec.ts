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

import { type NeisSchoolSchedule, NeisSchoolScheduleError } from "./neis-school-schedule.js";
import { syncNeisSchoolSchedules } from "./neis-school-schedule-sync.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const operatorToken = "school-schedule-integration-operator-token";
const school = { eduOfficeCode: "J10", schoolCode: "7530063" };

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

function event(
  eventDate: string,
  eventName: string,
  overrides: Partial<NeisSchoolSchedule> = {},
): NeisSchoolSchedule {
  return {
    academicYear: 2026,
    eduOfficeCode: school.eduOfficeCode,
    eventContent: null,
    eventDate,
    eventName,
    gradeMask: 7,
    schoolCode: school.schoolCode,
    schoolDayType: "해당없음",
    sourceLoadedOn: "2026-07-30",
    ...overrides,
  };
}

function sync(events: NeisSchoolSchedule[], dryRun = false) {
  return syncNeisSchoolSchedules({
    apiKey: "integration-neis-api-key",
    dryRun,
    eduOfficeCode: school.eduOfficeCode,
    fetchSchedules: async () => events,
    from: "2026-03-01",
    operatorDatabaseUrl,
    operatorToken,
    schoolCode: school.schoolCode,
    to: "2027-02-28",
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
      email_normalized: "school-schedule-sync@classhub.local",
    })
    .execute();
  await database
    .insertInto("schools")
    .values({
      edu_office_code: school.eduOfficeCode,
      edu_office_name: "경기도교육청",
      region_name: "경기도",
      school_code: school.schoolCode,
      school_kind: "high",
      school_name: "동안고등학교",
    })
    .execute();
}, 120_000);

beforeEach(async () => {
  await database
    .deleteFrom("operator_audit_logs")
    .where("action", "=", "school_schedule.imported")
    .execute();
  await database.deleteFrom("school_schedule_import_logs").execute();
  await database.deleteFrom("school_schedule_events").execute();
});

afterAll(async () => {
  await Promise.allSettled([database?.destroy(), postgres?.stop()]);
}, 120_000);

describe("NEIS school schedule sync", () => {
  it("supports no-write dry-run, insert, identical skip, and metadata update", async () => {
    const first = event("2026-07-01", "2차 정기시험");
    await expect(sync([first], true)).resolves.toMatchObject({
      dryRun: true,
      insertedCount: 1,
      skippedCount: 0,
      updatedCount: 0,
    });
    expect(
      (
        await database
          .selectFrom("school_schedule_events")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
    expect(
      (
        await database
          .selectFrom("school_schedule_import_logs")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");

    await expect(sync([first])).resolves.toMatchObject({ insertedCount: 1 });
    await expect(sync([first])).resolves.toMatchObject({ skippedCount: 1 });
    await expect(
      sync([
        event("2026-07-01", "2차 정기시험", {
          eventContent: "전 학년 정상 등교",
          schoolDayType: "수업일",
          sourceLoadedOn: "2026-07-31",
        }),
      ]),
    ).resolves.toMatchObject({ updatedCount: 1 });

    const stored = await database
      .selectFrom("school_schedule_events")
      .select(["event_content", "grade_mask", "school_day_type"])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      event_content: "전 학년 정상 등교",
      grade_mask: 7,
      school_day_type: "수업일",
    });
  });

  it("preserves omitted last-known events and keeps distinct same-day events", async () => {
    await sync([
      event("2026-03-03", "입학식", { gradeMask: 1 }),
      event("2026-03-03", "개학식", { gradeMask: 6 }),
    ]);
    await sync([event("2026-03-03", "개학식", { gradeMask: 6 })]);

    const rows = await database
      .selectFrom("school_schedule_events")
      .select(["event_name", "grade_mask"])
      .orderBy("event_name")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      { event_name: "개학식", grade_mask: 6 },
      { event_name: "입학식", grade_mask: 1 },
    ]);
  });

  it("writes only a redacted error code when the upstream request fails", async () => {
    const secret = "must-not-appear-in-audit";
    await expect(
      syncNeisSchoolSchedules({
        apiKey: secret,
        eduOfficeCode: school.eduOfficeCode,
        fetchSchedules: async () => {
          throw new NeisSchoolScheduleError("NEIS_REQUEST_FAILED", "NEIS authentication failed.");
        },
        from: "2026-03-01",
        operatorDatabaseUrl,
        operatorToken,
        schoolCode: school.schoolCode,
        to: "2027-02-28",
      }),
    ).rejects.toBeInstanceOf(NeisSchoolScheduleError);

    const log = await database
      .selectFrom("school_schedule_import_logs")
      .select(["error_json", "file_name", "result"])
      .executeTakeFirstOrThrow();
    expect(log).toMatchObject({
      error_json: { code: "NEIS_REQUEST_FAILED" },
      result: "failed",
    });
    expect(JSON.stringify(log)).not.toContain(secret);
  });
});
