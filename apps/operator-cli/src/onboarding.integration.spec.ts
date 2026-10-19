import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB, verifyPassword } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { importSchools, SchoolKindGradeConflictError } from "./school-import.js";
import { syncNeisSchools } from "./neis-school-sync.js";
import { type NeisSchoolCatalog, NeisSchoolError } from "./neis-school.js";
import { SchoolSeedValidationError, type SchoolSeedItem } from "./school-seed.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";
import { provisionTeacher, resetTeacherPassword } from "./teacher-provision.js";
import { transferClassTeacher } from "./class-transfer.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

const operatorToken = "onboarding-integration-operator-token";

let postgres: StartedNativeTestService;
let database: ReturnType<typeof createDatabase<DB>>;
let migratorDatabaseUrl: string;
let operatorDatabaseUrl: string;
let operatorId: string;
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

function school(
  schoolCode: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    edu_office_code: "B10",
    edu_office_name: "서울특별시교육청",
    region_name: "서울특별시",
    school_code: schoolCode,
    school_kind: "high",
    school_name: `통합 테스트 ${schoolCode}`,
    ...overrides,
  };
}

function neisSchool(schoolCode: string, overrides: Partial<SchoolSeedItem> = {}): SchoolSeedItem {
  return {
    eduOfficeCode: "J10",
    eduOfficeName: "경기도교육청",
    regionName: "경기도",
    schoolCode,
    schoolKind: "high",
    schoolName: `NEIS 통합 테스트 ${schoolCode}`,
    ...overrides,
  };
}

function neisCatalog(
  items: SchoolSeedItem[],
  ignoredUnsupportedCount = 0,
  ignoredInvalidIdentifierCount = 0,
): NeisSchoolCatalog {
  return {
    blankedOptionalFieldCount: 0,
    ignoredInvalidIdentifierCount,
    ignoredUnsupportedCount,
    items,
    sourceCount: items.length + ignoredUnsupportedCount + ignoredInvalidIdentifierCount,
  };
}

async function seedFile(name: string, items: unknown[]): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ schema_version: 1, items }), "utf8");
  return path;
}

async function countRows(table: "operator_audit_logs" | "school_import_logs" | "schools") {
  return (
    await database
      .selectFrom(table)
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow()
  ).count;
}

/*
 * 갓 발급된 임시 비밀번호는 재발급 쿨다운에 걸린다. 실제 문의는 며칠 뒤에 오므로
 * 만료 시각을 당겨 그 상태를 재현한다. bootstrap 역할에는 teacher_profiles UPDATE
 * 권한이 없어 소유자인 migrator로 손본다.
 */
async function backdateTemporaryPassword(userId: string, remainingHours: number): Promise<void> {
  const migrator = createDatabase<DB>(migratorDatabaseUrl);
  try {
    await migrator
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: new Date(Date.now() + remainingHours * 60 * 60 * 1_000),
      })
      .where("user_id", "=", userId)
      .execute();
  } finally {
    await migrator.destroy();
  }
}

async function seedExistingTeacherClass(schoolCode: string, grade: number): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const user = await transaction
      .insertInto("users")
      .values({
        display_name: "기존 담임",
        email_normalized: `fixture-${schoolCode}@example.com`,
        email_verified_at: new Date(),
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operatorId,
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: user.id,
      })
      .execute();
    const classRow = await transaction
      .insertInto("classes")
      .values({
        academic_year: 2026,
        created_by_user_id: user.id,
        edu_office_code: "B10",
        expected_student_count: 30,
        grade,
        name: "기존 학급",
        school_code: schoolCode,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("class_members")
      .values({
        class_id: classRow.id,
        role: "teacher",
        status: "approved",
        status_changed_at: new Date(),
        user_id: user.id,
      })
      .execute();
  });
}

async function readClassTransferState(classId: string) {
  const [targetClass, members, history, classAudits, operatorAudits] = await Promise.all([
    database.selectFrom("classes").selectAll().where("id", "=", classId).executeTakeFirstOrThrow(),
    database
      .selectFrom("class_members")
      .selectAll()
      .where("class_id", "=", classId)
      .orderBy("id", "asc")
      .execute(),
    database
      .selectFrom("class_member_status_history")
      .selectAll()
      .where("class_id", "=", classId)
      .orderBy("id", "asc")
      .execute(),
    database
      .selectFrom("audit_logs")
      .selectAll()
      .where("class_id", "=", classId)
      .orderBy("id", "asc")
      .execute(),
    database
      .selectFrom("operator_audit_logs")
      .selectAll()
      .where("target_type", "=", "class")
      .where("target_id", "=", classId)
      .orderBy("id", "asc")
      .execute(),
  ]);

  return { classAudits, history, members, operatorAudits, targetClass };
}

async function markTemporaryPasswordChanged(userId: string): Promise<void> {
  await database
    .updateTable("teacher_profiles")
    .set({
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
    })
    .where("user_id", "=", userId)
    .execute();
}

async function seedSuspendedClassForReactivationBoundary() {
  return database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "서울특별시교육청",
        region_name: "서울특별시",
        school_code: "9911112",
        school_kind: "elementary",
        school_name: "재활성화경계초등학교",
      })
      .execute();
    const user = await transaction
      .insertInto("users")
      .values({
        display_name: "재활성화 경계 담임",
        email_normalized: "reactivation-boundary@example.com",
        email_verified_at: new Date(),
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operatorId,
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: user.id,
      })
      .execute();
    const suspendedAt = new Date();
    const targetClass = await transaction
      .insertInto("classes")
      .values({
        academic_year: 2026,
        created_by_user_id: user.id,
        edu_office_code: "B10",
        expected_student_count: 30,
        grade: 6,
        name: "재활성화 권한 경계",
        school_code: "9911112",
        status: "suspended",
        suspended_at: suspendedAt,
        suspended_by_operator_id: operatorId,
        suspended_reason: "권한 경계 시험",
      })
      .returning(["id", "row_version"])
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("class_members")
      .values({
        class_id: targetClass.id,
        role: "teacher",
        status: "approved",
        status_changed_at: suspendedAt,
        user_id: user.id,
      })
      .execute();

    return { ...targetClass, suspendedAt };
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
  migratorDatabaseUrl = postgresUrl("classhub_migrator", "local_migrator_password");
  await applyMigrations();
  operatorDatabaseUrl = postgresUrl("classhub_operator", "local_operator_password");
  const operator = await database
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update(operatorToken, "utf8").digest(),
      email_normalized: "onboarding-operator@classhub.local",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  operatorId = operator.id;
  directory = await mkdtemp(join(tmpdir(), "classhub-onboarding-"));
}, 120_000);

beforeEach(async () => {
  await database.transaction().execute(async (transaction) => {
    await transaction
      .deleteFrom("operator_audit_logs")
      .where("action", "in", [
        "class.reactivated",
        "school.imported",
        "teacher.created",
        "teacher.transferred",
      ])
      .execute();
    await transaction.deleteFrom("school_import_logs").execute();
    // 학급 감사는 classes를 ON DELETE RESTRICT로 참조한다. 담임 이관이 여기에
    // 기록을 남기게 된 뒤로는 감사부터 지워야 반이 지워진다(방침 §3.3의 정리 순서와 같다).
    await transaction.deleteFrom("audit_logs").execute();
    await transaction.deleteFrom("class_member_status_history").execute();
    await transaction.deleteFrom("class_members").execute();
    await transaction.deleteFrom("classes").execute();
    await transaction.deleteFrom("teacher_profiles").execute();
    await transaction.deleteFrom("users").execute();
    await transaction.deleteFrom("schools").execute();
  });
});

afterAll(async () => {
  await Promise.allSettled([
    database?.destroy(),
    postgres?.stop({ remove: true, removeVolumes: true }),
    rm(directory, { recursive: true }),
  ]);
}, 120_000);

describe("school and teacher onboarding commands", () => {
  it("previews without writes, then atomically inserts, skips, and updates schools", async () => {
    const initial = await seedFile("schools-initial.json", [school("7010101"), school("7010102")]);
    const preview = await importSchools({
      dryRun: true,
      filePath: initial,
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      insertedCount: 2,
      skippedCount: 0,
      updatedCount: 0,
    });
    expect(await countRows("schools")).toBe("0");
    expect(await countRows("school_import_logs")).toBe("0");
    expect(await countRows("operator_audit_logs")).toBe("0");

    const inserted = await importSchools({
      filePath: initial,
      operatorDatabaseUrl,
      operatorToken,
    });
    const same = await importSchools({
      filePath: initial,
      operatorDatabaseUrl,
      operatorToken,
    });
    const changedFile = await seedFile("schools-changed.json", [
      school("7010101", { school_name: "수정된 통합 테스트 학교" }),
      school("7010102"),
    ]);
    const changed = await importSchools({
      filePath: changedFile,
      operatorDatabaseUrl,
      operatorToken,
    });

    expect(inserted).toMatchObject({ insertedCount: 2, skippedCount: 0, updatedCount: 0 });
    expect(same).toMatchObject({ insertedCount: 0, skippedCount: 2, updatedCount: 0 });
    expect(same.checksum).toBe(inserted.checksum);
    expect(changed).toMatchObject({ insertedCount: 0, skippedCount: 1, updatedCount: 1 });
    expect(await countRows("school_import_logs")).toBe("3");
    expect(await countRows("operator_audit_logs")).toBe("3");
    expect(
      (
        await database
          .selectFrom("schools")
          .select("school_name")
          .where("school_code", "=", "7010101")
          .executeTakeFirstOrThrow()
      ).school_name,
    ).toBe("수정된 통합 테스트 학교");
  });

  it("previews and idempotently imports a validated NEIS school catalog", async () => {
    const schools = [
      neisSchool("7530063", {
        homepageUrl: "https://dongan-h.goeay.kr/",
        phoneNumber: "031-387-6105",
        roadAddress: "경기도 안양시 동안구 부림로 71",
        roadAddressDetail: "(평촌동,동안고등학교)",
        schoolName: "동안고등학교",
      }),
      neisSchool("7530064", { schoolKind: "middle", schoolName: "통합 중학교" }),
    ];
    const preview = await syncNeisSchools({
      apiKey: "integration-test-key",
      dryRun: true,
      fetchSchools: async () => neisCatalog(schools, 1, 1),
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      fetchedCount: 2,
      ignoredInvalidIdentifierCount: 1,
      ignoredUnsupportedCount: 1,
      insertedCount: 2,
      skippedCount: 0,
      sourceCount: 4,
      updatedCount: 0,
    });
    expect(await countRows("schools")).toBe("0");
    expect(await countRows("school_import_logs")).toBe("0");
    expect(await countRows("operator_audit_logs")).toBe("0");

    const inserted = await syncNeisSchools({
      apiKey: "integration-test-key",
      fetchSchools: async () => neisCatalog(schools, 1, 1),
      operatorDatabaseUrl,
      operatorToken,
    });
    const repeated = await syncNeisSchools({
      apiKey: "integration-test-key",
      fetchSchools: async () => neisCatalog(schools, 1, 1),
      operatorDatabaseUrl,
      operatorToken,
    });
    const partiallyUpdated = await syncNeisSchools({
      apiKey: "integration-test-key",
      fetchSchools: async () =>
        neisCatalog(
          [
            neisSchool("7530063", {
              phoneNumber: "031-387-6106",
              schoolName: "동안고등학교",
            }),
            schools[1]!,
          ],
          1,
          1,
        ),
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(inserted).toMatchObject({
      fetchedCount: 2,
      ignoredInvalidIdentifierCount: 1,
      ignoredUnsupportedCount: 1,
      insertedCount: 2,
      skippedCount: 0,
      sourceCount: 4,
      updatedCount: 0,
    });
    expect(repeated).toMatchObject({
      fetchedCount: 2,
      ignoredInvalidIdentifierCount: 1,
      ignoredUnsupportedCount: 1,
      insertedCount: 0,
      skippedCount: 2,
      sourceCount: 4,
      updatedCount: 0,
    });
    expect(repeated.checksum).toBe(inserted.checksum);
    expect(partiallyUpdated).toMatchObject({
      insertedCount: 0,
      skippedCount: 1,
      updatedCount: 1,
    });
    expect(partiallyUpdated.checksum).not.toBe(inserted.checksum);
    expect(
      await database
        .selectFrom("schools")
        .select([
          "homepage_url",
          "phone_number",
          "road_address",
          "road_address_detail",
          "school_code",
          "school_kind",
          "school_name",
        ])
        .orderBy("school_code")
        .execute(),
    ).toEqual([
      {
        homepage_url: "https://dongan-h.goeay.kr/",
        phone_number: "031-387-6106",
        road_address: "경기도 안양시 동안구 부림로 71",
        road_address_detail: "(평촌동,동안고등학교)",
        school_code: "7530063",
        school_kind: "high",
        school_name: "동안고등학교",
      },
      {
        homepage_url: null,
        phone_number: null,
        road_address: null,
        road_address_detail: null,
        school_code: "7530064",
        school_kind: "middle",
        school_name: "통합 중학교",
      },
    ]);
    expect(await countRows("school_import_logs")).toBe("3");
    expect(await countRows("operator_audit_logs")).toBe("3");
    expect(
      (
        await database
          .selectFrom("school_import_logs")
          .select("file_name")
          .orderBy("id")
          .executeTakeFirstOrThrow()
      ).file_name,
    ).toBe("neis:schoolInfo:nationwide");
  });

  it("records a redacted applied NEIS school fetch failure without changing schools", async () => {
    await expect(
      syncNeisSchools({
        apiKey: "secret-integration-test-key",
        fetchSchools: async () => {
          throw new NeisSchoolError("NEIS_REQUEST_FAILED", "합성 NEIS 요청 실패");
        },
        operatorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toBeInstanceOf(NeisSchoolError);

    expect(await countRows("schools")).toBe("0");
    const failure = await database
      .selectFrom("school_import_logs")
      .select(["checksum", "error_json", "file_name", "result"])
      .executeTakeFirstOrThrow();
    expect(failure).toMatchObject({
      error_json: { code: "NEIS_REQUEST_FAILED" },
      file_name: "neis:schoolInfo:nationwide",
      result: "failed",
    });
    expect(failure.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(await countRows("operator_audit_logs")).toBe("1");
    const serializedLogs = JSON.stringify([
      failure,
      await database
        .selectFrom("operator_audit_logs")
        .select(["after_json", "before_json"])
        .executeTakeFirstOrThrow(),
    ]);
    expect(serializedLogs).not.toContain("secret-integration-test-key");
    expect(serializedLogs).not.toContain(operatorToken);
  });

  it("keeps dry-run validation silent and records an applied validation failure", async () => {
    const invalid = await seedFile("schools-invalid.json", [
      school("7010201"),
      { ...school("7010201"), unexpected: true },
    ]);
    await expect(
      importSchools({
        dryRun: true,
        filePath: invalid,
        operatorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toBeInstanceOf(SchoolSeedValidationError);
    expect(await countRows("school_import_logs")).toBe("0");
    expect(await countRows("operator_audit_logs")).toBe("0");

    await expect(
      importSchools({ filePath: invalid, operatorDatabaseUrl, operatorToken }),
    ).rejects.toBeInstanceOf(SchoolSeedValidationError);
    expect(await countRows("schools")).toBe("0");
    const failure = await database
      .selectFrom("school_import_logs")
      .select(["error_json", "result"])
      .executeTakeFirstOrThrow();
    expect(failure).toEqual({
      error_json: { code: "INVALID_SCHOOL_SEED" },
      result: "failed",
    });
    expect(await countRows("operator_audit_logs")).toBe("1");
  });

  it("rolls back every school when a school-kind change conflicts with an existing grade", async () => {
    await database
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "서울특별시교육청",
        region_name: "서울특별시",
        school_code: "7011000",
        school_kind: "elementary",
        school_name: "기존 초등학교",
      })
      .execute();
    await seedExistingTeacherClass("7011000", 5);
    const conflicting = await seedFile("schools-conflict.json", [
      school("7010000"),
      school("7011000", { school_kind: "middle", school_name: "변경 시도 중학교" }),
    ]);

    await expect(
      importSchools({ filePath: conflicting, operatorDatabaseUrl, operatorToken }),
    ).rejects.toBeInstanceOf(SchoolKindGradeConflictError);
    expect(
      await database
        .selectFrom("schools")
        .select(["school_code", "school_kind"])
        .orderBy("school_code")
        .execute(),
    ).toEqual([{ school_code: "7011000", school_kind: "elementary" }]);
    const failure = await database
      .selectFrom("school_import_logs")
      .select(["error_json", "result"])
      .executeTakeFirstOrThrow();
    expect(failure).toEqual({
      error_json: { code: "SCHOOL_KIND_GRADE_CONFLICT" },
      result: "failed",
    });
  });

  it("creates a verified temporary-password teacher once and makes reruns no-op", async () => {
    const created = await provisionTeacher({
      displayName: "통합 담임",
      email: "Teacher@Example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(created.created).toBe(true);
    if (!created.created) throw new Error("expected a newly provisioned teacher");

    const user = await database
      .selectFrom("users")
      .select(["display_name", "email_normalized", "email_verified_at", "password_hash"])
      .where("id", "=", created.userId)
      .executeTakeFirstOrThrow();
    const profile = await database
      .selectFrom("teacher_profiles")
      .select(["status", "temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", created.userId)
      .executeTakeFirstOrThrow();
    expect(user).toMatchObject({
      display_name: "통합 담임",
      email_normalized: "teacher@example.com",
    });
    expect(user.email_verified_at).not.toBeNull();
    await expect(verifyPassword(created.rawTemporaryPassword, user.password_hash)).resolves.toBe(
      true,
    );
    expect(profile).toMatchObject({
      status: "active",
      temporary_password_must_change: true,
    });
    expect(
      profile.temporary_password_expires_at!.getTime() - user.email_verified_at!.getTime(),
    ).toBe(72 * 60 * 60 * 1_000);

    const audit = await database
      .selectFrom("operator_audit_logs")
      .select(["after_json", "before_json"])
      .where("action", "=", "teacher.created")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({
      after_json: {
        teacher_profile_status: "active",
        teacher_user_id: created.userId,
      },
      before_json: null,
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain("teacher@example.com");
    expect(serializedAudit).not.toContain(created.rawTemporaryPassword);
    expect(serializedAudit).not.toContain("통합 담임");

    const existing = await provisionTeacher({
      displayName: "다른 입력 표시명",
      email: "teacher@example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(existing).toMatchObject({
      created: false,
      rawTemporaryPassword: null,
      runId: null,
      userId: created.userId,
    });
    expect(
      (
        await database
          .selectFrom("operator_audit_logs")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("action", "=", "teacher.created")
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("1");
  });

  it("reissues a temporary password, cuts live sessions, and refuses non-teachers", async () => {
    const created = await provisionTeacher({
      displayName: "재발급 담임",
      email: "reset@example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    if (!created.created) throw new Error("expected a newly provisioned teacher");
    await backdateTemporaryPassword(created.userId, 48);
    await database
      .insertInto("sessions")
      .values({
        created_ip: "203.0.113.10",
        // sessions_*_hash_check가 정확히 32바이트를 요구한다.
        csrf_token_hash: createHash("sha256").update("csrf-fixture").digest(),
        expires_at: new Date(Date.now() + 60 * 60 * 1_000),
        session_hash: createHash("sha256").update("session-fixture").digest(),
        user_id: created.userId,
      })
      .execute();

    const reset = await resetTeacherPassword({
      email: "Reset@Example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(reset.userId).toBe(created.userId);
    expect(reset.revokedSessionCount).toBe(1);
    expect(reset.rawTemporaryPassword).not.toBe(created.rawTemporaryPassword);

    const user = await database
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", created.userId)
      .executeTakeFirstOrThrow();
    await expect(verifyPassword(reset.rawTemporaryPassword, user.password_hash)).resolves.toBe(
      true,
    );
    await expect(verifyPassword(created.rawTemporaryPassword, user.password_hash)).resolves.toBe(
      false,
    );

    const profile = await database
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", created.userId)
      .executeTakeFirstOrThrow();
    expect(profile.temporary_password_must_change).toBe(true);
    expect(profile.temporary_password_expires_at!.getTime()).toBeGreaterThan(Date.now());

    const liveSessions = await database
      .selectFrom("sessions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", created.userId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(liveSessions.count).toBe("0");

    // 재발급 기록은 남되 이메일·비밀번호가 감사 로그로 새지 않아야 한다.
    const audit = await database
      .selectFrom("operator_audit_logs")
      .select(["after_json", "target_id"])
      .where("action", "=", "teacher.password_reset")
      .executeTakeFirstOrThrow();
    expect(audit.target_id).toBe(created.userId);
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain("reset@example.com");
    expect(serializedAudit).not.toContain(reset.rawTemporaryPassword);

    await expect(
      resetTeacherPassword({
        email: "missing@example.com",
        operatorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toThrow("활성 계정을 찾지 못해");
  });

  it("serializes two concurrent reissues instead of interleaving them", async () => {
    const created = await provisionTeacher({
      displayName: "동시 재발급 담임",
      email: "concurrent-reset@example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    if (!created.created) throw new Error("expected a newly provisioned teacher");
    await backdateTemporaryPassword(created.userId, 48);

    // 두 운영자가 같은 문의를 받아 동시에 재발급하는 상황. advisory lock으로
    // 직렬화되므로 뒤에 선 쪽은 방금 발급된 상태를 보고 멈춰야 한다 — 그러지
    // 않으면 먼저 처리한 운영자가 이미 무효인 비밀번호를 교사에게 알려준다.
    const attempts = await Promise.allSettled([
      resetTeacherPassword({
        email: "concurrent-reset@example.com",
        operatorDatabaseUrl,
        operatorToken,
      }),
      resetTeacherPassword({
        email: "concurrent-reset@example.com",
        operatorDatabaseUrl,
        operatorToken,
      }),
    ]);
    const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
    const refused = attempts.filter((attempt) => attempt.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain("방금");

    const winner = (
      succeeded[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof resetTeacherPassword>>>
    ).value;
    const user = await database
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", created.userId)
      .executeTakeFirstOrThrow();
    await expect(verifyPassword(winner.rawTemporaryPassword, user.password_hash)).resolves.toBe(
      true,
    );

    const profile = await database
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", created.userId)
      .executeTakeFirstOrThrow();
    expect(profile.temporary_password_must_change).toBe(true);
    expect(profile.temporary_password_expires_at!.toISOString()).toBe(
      winner.temporaryPasswordExpiresAt.toISOString(),
    );

    // 멈춘 쪽은 아무것도 쓰지 않았어야 한다 — 감사 기록은 한 줄뿐이다.
    const audits = await database
      .selectFrom("operator_audit_logs")
      .select("run_id")
      .where("action", "=", "teacher.password_reset")
      .where("target_id", "=", created.userId)
      .execute();
    expect(audits).toHaveLength(1);

    // 의도적으로 다시 발급해야 하는 경우는 force로 통과한다.
    const forced = await resetTeacherPassword({
      email: "concurrent-reset@example.com",
      force: true,
      operatorDatabaseUrl,
      operatorToken,
    });
    expect(forced.rawTemporaryPassword).not.toBe(winner.rawTemporaryPassword);
  });

  it("keeps suspended-class reactivation least-privileged and concurrency-safe", async () => {
    const seeded = await seedSuspendedClassForReactivationBoundary();
    const operatorDatabase = createDatabase<DB>(operatorDatabaseUrl);
    const appDatabase = createDatabase<DB>(postgresUrl("classhub_app", "local_app_password"));

    try {
      const functionMetadata = await sql<{
        owner_name: string;
        proconfig: string[] | null;
        security_definer: boolean;
      }>`
        SELECT
          pg_get_userbyid(proowner) AS owner_name,
          proconfig,
          prosecdef AS security_definer
        FROM pg_proc
        WHERE oid = to_regprocedure(
          'public.reactivate_suspended_class_for_teacher_transfer(bigint,bigint)'
        )
      `.execute(database);
      expect(functionMetadata.rows).toEqual([
        {
          owner_name: "classhub_migrator",
          proconfig: ["search_path=pg_catalog"],
          security_definer: true,
        },
      ]);

      const privileges = await sql<{
        app_execute: boolean;
        operator_classes_update: boolean;
        operator_execute: boolean;
        operator_name_read: boolean;
        operator_row_version_read: boolean;
        operator_status_update: boolean;
      }>`
        SELECT
          has_function_privilege(
            'classhub_operator',
            'public.reactivate_suspended_class_for_teacher_transfer(bigint,bigint)',
            'EXECUTE'
          ) AS operator_execute,
          has_function_privilege(
            'classhub_app',
            'public.reactivate_suspended_class_for_teacher_transfer(bigint,bigint)',
            'EXECUTE'
          ) AS app_execute,
          has_table_privilege(
            'classhub_operator', 'public.classes', 'UPDATE'
          ) AS operator_classes_update,
          has_column_privilege(
            'classhub_operator', 'public.classes', 'status', 'UPDATE'
          ) AS operator_status_update,
          has_column_privilege(
            'classhub_operator', 'public.classes', 'row_version', 'SELECT'
          ) AS operator_row_version_read,
          has_column_privilege(
            'classhub_operator', 'public.classes', 'name', 'SELECT'
          ) AS operator_name_read
      `.execute(database);
      expect(privileges.rows[0]).toEqual({
        app_execute: false,
        operator_classes_update: false,
        operator_execute: true,
        operator_name_read: false,
        operator_row_version_read: true,
        operator_status_update: false,
      });

      let alterError: unknown;
      try {
        await operatorDatabase.transaction().execute(async (transaction) => {
          await sql`
            ALTER FUNCTION public.reactivate_suspended_class_for_teacher_transfer(BIGINT, BIGINT)
            VOLATILE
          `.execute(transaction);
          throw new Error("classhub_operator unexpectedly altered the reactivation function");
        });
      } catch (error) {
        alterError = error;
      }
      expect(String(alterError)).toContain("must be owner of function");

      const unchangedSuspendedState = await readClassTransferState(seeded.id);
      await expect(
        sql`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            ${seeded.id}::bigint,
            ${seeded.row_version}::bigint
          )
        `.execute(appDatabase),
      ).rejects.toThrow("permission denied for function");
      await expect(
        sql`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            NULL::bigint,
            ${seeded.row_version}::bigint
          )
        `.execute(operatorDatabase),
      ).rejects.toThrow("class id and expected row version are required");
      await expect(
        sql`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            9223372036854775807::bigint,
            ${seeded.row_version}::bigint
          )
        `.execute(operatorDatabase),
      ).rejects.toThrow("does not exist");
      await expect(
        sql`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            ${seeded.id}::bigint,
            ${(BigInt(seeded.row_version) + 1n).toString()}::bigint
          )
        `.execute(operatorDatabase),
      ).rejects.toThrow("row version changed");
      expect(await readClassTransferState(seeded.id)).toEqual(unchangedSuspendedState);

      await expect(
        operatorDatabase.transaction().execute(async (transaction) => {
          const reactivated = await sql<{ row_version: string }>`
            SELECT public.reactivate_suspended_class_for_teacher_transfer(
              ${seeded.id}::bigint,
              ${seeded.row_version}::bigint
            ) AS row_version
          `.execute(transaction);
          expect(reactivated.rows[0]?.row_version).toBe(
            (BigInt(seeded.row_version) + 1n).toString(),
          );
          throw new Error("force reactivation rollback");
        }),
      ).rejects.toThrow("force reactivation rollback");
      expect(await readClassTransferState(seeded.id)).toEqual(unchangedSuspendedState);

      const activatedAt = new Date();
      await database
        .updateTable("classes")
        .set({
          row_version: sql<string>`row_version + 1`,
          status: "active",
          suspended_at: null,
          suspended_by_operator_id: null,
          suspended_reason: null,
          updated_at: activatedAt,
        })
        .where("id", "=", seeded.id)
        .execute();
      const activeState = await readClassTransferState(seeded.id);
      await expect(
        sql`
          SELECT public.reactivate_suspended_class_for_teacher_transfer(
            ${seeded.id}::bigint,
            ${activeState.targetClass.row_version}::bigint
          )
        `.execute(operatorDatabase),
      ).rejects.toThrow("must be suspended");
      expect(await readClassTransferState(seeded.id)).toEqual(activeState);
    } finally {
      await Promise.allSettled([operatorDatabase.destroy(), appDatabase.destroy()]);
    }
  });

  it("enforces teacher-transfer preconditions and preserves atomic audit state", async () => {
    const seeded = await database.transaction().execute(async (transaction) => {
      // classes가 schools를 참조하므로 학교부터 있어야 한다.
      await transaction
        .insertInto("schools")
        .values({
          edu_office_code: "B10",
          edu_office_name: "서울특별시교육청",
          region_name: "서울특별시",
          school_code: "9911111",
          school_kind: "elementary",
          school_name: "이관테스트초등학교",
        })
        .execute();
      const user = await transaction
        .insertInto("users")
        .values({
          display_name: "이관 전 담임",
          email_normalized: "transfer-from@example.com",
          email_verified_at: new Date(),
          password_hash: "fixture-password-hash",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("teacher_profiles")
        .values({
          created_by_operator_id: operatorId,
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
          user_id: user.id,
        })
        .execute();
      const classRow = await transaction
        .insertInto("classes")
        .values({
          academic_year: 2026,
          created_by_user_id: user.id,
          edu_office_code: "B10",
          expected_student_count: 30,
          grade: 5,
          name: "이관 대상 학급",
          school_code: "9911111",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // 활성 학급은 담임이 정확히 한 명이어야 하므로 반과 담임을 한 트랜잭션에서 만든다.
      await transaction
        .insertInto("class_members")
        .values({
          class_id: classRow.id,
          role: "teacher",
          status: "approved",
          status_changed_at: new Date(),
          user_id: user.id,
        })
        .execute();
      return { classId: classRow.id, teacherUserId: user.id };
    });

    const incoming = await provisionTeacher({
      displayName: "이관 후 담임",
      email: "transfer-to@example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    if (!incoming.created) throw new Error("expected a newly provisioned teacher");

    // teacher_profiles의 CHECK는 must_change=true와 expires_at!=NULL을 한 상태로
    // 묶는다. 운영자 역할은 만료 시각만 읽을 수 있으므로 이 상태를 변경 미완료로
    // 판정해야 하며, 거부 시 학급·멤버십·양쪽 감사가 하나도 달라지면 안 된다.
    const temporaryPasswordState = await database
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", incoming.userId)
      .executeTakeFirstOrThrow();
    expect(temporaryPasswordState.temporary_password_must_change).toBe(true);
    expect(temporaryPasswordState.temporary_password_expires_at).not.toBeNull();

    const beforeTemporaryPasswordRejection = await readClassTransferState(seeded.classId);
    await expect(
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        reason: "휴직 대체",
        toEmail: "Transfer-To@example.com",
      }),
    ).rejects.toThrow("임시 비밀번호를 변경하지 않은");
    expect(await readClassTransferState(seeded.classId)).toEqual(beforeTemporaryPasswordRejection);

    await markTemporaryPasswordChanged(incoming.userId);
    expect(
      await database
        .selectFrom("teacher_profiles")
        .select(["temporary_password_expires_at", "temporary_password_must_change"])
        .where("user_id", "=", incoming.userId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
    });

    // 같은 이관이 경쟁해도 advisory lock 뒤 재검증으로 하나만 성공하고, 실패한
    // 요청은 별도 이력·감사를 남기지 않아야 한다.
    const transferOutcomes = await Promise.allSettled([
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        reason: "휴직 대체",
        toEmail: "Transfer-To@example.com",
      }),
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        reason: "휴직 대체",
        toEmail: "Transfer-To@example.com",
      }),
    ]);
    const successfulTransfer = transferOutcomes.find((outcome) => outcome.status === "fulfilled");
    const rejectedTransfer = transferOutcomes.find((outcome) => outcome.status === "rejected");
    if (successfulTransfer?.status !== "fulfilled" || rejectedTransfer?.status !== "rejected") {
      throw new Error("expected exactly one successful competing class transfer");
    }
    expect(String(rejectedTransfer.reason)).toContain("같은 교사로는");
    const transferred = successfulTransfer.value;
    expect(transferred).toMatchObject({
      classId: seeded.classId,
      fromUserId: seeded.teacherUserId,
      toUserId: incoming.userId,
    });

    const members = await database
      .selectFrom("class_members")
      .select(["role", "status", "user_id"])
      .where("class_id", "=", seeded.classId)
      .orderBy("id", "asc")
      .execute();
    expect(members).toEqual([
      { role: "teacher", status: "transferred", user_id: seeded.teacherUserId },
      { role: "teacher", status: "approved", user_id: incoming.userId },
    ]);

    const history = await database
      .selectFrom("class_member_status_history")
      .select(["actor_operator_id", "from_status", "reason", "to_status"])
      .where("class_id", "=", seeded.classId)
      .orderBy("id", "asc")
      .execute();
    expect(history).toEqual([
      {
        actor_operator_id: operatorId,
        from_status: "approved",
        reason: "휴직 대체",
        to_status: "transferred",
      },
      {
        actor_operator_id: operatorId,
        from_status: null,
        reason: "휴직 대체",
        to_status: "approved",
      },
    ]);

    const audit = await database
      .selectFrom("operator_audit_logs")
      .select(["after_json", "before_json", "target_id"])
      .where("action", "=", "teacher.transferred")
      .executeTakeFirstOrThrow();
    expect(audit.target_id).toBe(seeded.classId);
    // 감사 기록에 이메일이 새면 안 된다 — user_id로 충분히 추적된다.
    expect(JSON.stringify(audit)).not.toContain("transfer-to@example.com");

    // 운영자 감사만으로는 교사가 앱에서 볼 수 없다. 학급 감사에도 남아야 한다.
    const memberIds = await database
      .selectFrom("class_members")
      .select(["id", "user_id"])
      .where("class_id", "=", seeded.classId)
      .orderBy("id", "asc")
      .execute();
    const outgoingMemberId = memberIds.find(({ user_id }) => user_id === seeded.teacherUserId)!.id;
    const incomingMemberId = memberIds.find(({ user_id }) => user_id === incoming.userId)!.id;
    const classAudit = await database
      .selectFrom("audit_logs")
      .select([
        "actor_display_name_snapshot",
        "actor_member_id",
        "actor_role_snapshot",
        "actor_user_id",
        "after_json",
        "before_json",
        "reason",
        "target_id",
        "target_type",
      ])
      .where("action", "=", "class.teacher_transferred")
      .executeTakeFirstOrThrow();
    expect(classAudit).toMatchObject({
      actor_display_name_snapshot: "운영자",
      // 운영자는 학급 구성원이 아니다. 두 열은 NULL로 남아야 하며 권한도 열려 있지 않다.
      actor_member_id: null,
      actor_role_snapshot: "operator",
      actor_user_id: null,
      after_json: { member_id: incomingMemberId, role: "teacher", status: "approved" },
      before_json: { member_id: outgoingMemberId, role: "teacher", status: "transferred" },
      reason: "휴직 대체",
      target_id: incomingMemberId,
      target_type: "member",
    });
    // 표시명 스냅샷은 넣지 않기로 했다 — append-only라 나중에 익명화가 불가능하다.
    expect(JSON.stringify(classAudit.after_json)).not.toContain("display_name_snapshot");
    expect(JSON.stringify(classAudit)).not.toContain("transfer-to@example.com");

    // 이관을 위해 연 권한이 딱 그만큼인지 못박는다. 운영자는 학급 감사를 읽지도,
    // 고치지도, 지우지도 못하고, 자신을 학급 구성원인 것처럼 적을 수도 없다.
    const grants = await sql<{
      insert_actor_member: boolean;
      insert_actor_user: boolean;
      read: boolean;
      remove: boolean;
      rewrite: boolean;
    }>`
      SELECT
        has_table_privilege('classhub_operator', 'audit_logs', 'SELECT') AS read,
        has_table_privilege('classhub_operator', 'audit_logs', 'UPDATE') AS rewrite,
        has_table_privilege('classhub_operator', 'audit_logs', 'DELETE') AS remove,
        has_column_privilege(
          'classhub_operator', 'audit_logs', 'actor_user_id', 'INSERT'
        ) AS insert_actor_user,
        has_column_privilege(
          'classhub_operator', 'audit_logs', 'actor_member_id', 'INSERT'
        ) AS insert_actor_member
    `.execute(database);
    expect(grants.rows[0]).toEqual({
      insert_actor_member: false,
      insert_actor_user: false,
      read: false,
      remove: false,
      rewrite: false,
    });

    // 과거 멤버십 row는 되살리지 않는다. 별도 교사 계정을 써야 한다는 계약대로
    // 거부하고, 실패한 트랜잭션이 멤버십·이력·감사를 남기지 않았음을 통째로 비교한다.
    const beforePriorMembershipRejection = await readClassTransferState(seeded.classId);
    await expect(
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        toEmail: "transfer-from@example.com",
      }),
    ).rejects.toThrow("과거 구성원이어서");
    expect(await readClassTransferState(seeded.classId)).toEqual(beforePriorMembershipRejection);

    await expect(
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        toEmail: "transfer-to@example.com",
      }),
    ).rejects.toThrow("같은 교사로는");
    expect(await readClassTransferState(seeded.classId)).toEqual(beforePriorMembershipRejection);

    const suspendedReplacement = await provisionTeacher({
      displayName: "중단 학급 대체 담임",
      email: "suspended-transfer-to@example.com",
      operatorDatabaseUrl,
      operatorToken,
    });
    if (!suspendedReplacement.created) {
      throw new Error("expected a newly provisioned suspended-class replacement teacher");
    }

    const suspendedAt = new Date();
    await database
      .updateTable("classes")
      .set({
        row_version: sql<string>`row_version + 1`,
        status: "suspended",
        suspended_at: suspendedAt,
        suspended_by_operator_id: operatorId,
        suspended_reason: "운영 점검",
        updated_at: suspendedAt,
      })
      .where("id", "=", seeded.classId)
      .execute();

    // 재활성화 함수가 먼저 실행된 뒤 새 교사의 비밀번호 조건에서 실패해도 함수의
    // classes UPDATE와 멤버십·양쪽 감사 모두 같은 transaction으로 rollback돼야 한다.
    const beforeSuspendedRollback = await readClassTransferState(seeded.classId);
    expect(beforeSuspendedRollback.targetClass).toMatchObject({
      status: "suspended",
      suspended_at: suspendedAt,
      suspended_by_operator_id: operatorId,
      suspended_reason: "운영 점검",
    });
    await expect(
      transferClassTeacher({
        classId: seeded.classId,
        operatorDatabaseUrl,
        operatorToken,
        toEmail: "suspended-transfer-to@example.com",
      }),
    ).rejects.toThrow("임시 비밀번호를 변경하지 않은");
    expect(await readClassTransferState(seeded.classId)).toEqual(beforeSuspendedRollback);

    await markTemporaryPasswordChanged(suspendedReplacement.userId);
    const suspendedTransfer = await transferClassTeacher({
      classId: seeded.classId,
      operatorDatabaseUrl,
      operatorToken,
      reason: "정지 학급 담임 이관",
      toEmail: "suspended-transfer-to@example.com",
    });
    expect(suspendedTransfer).toMatchObject({
      classId: seeded.classId,
      fromUserId: incoming.userId,
      toUserId: suspendedReplacement.userId,
    });

    const afterSuspendedTransfer = await readClassTransferState(seeded.classId);
    expect(afterSuspendedTransfer.targetClass).toMatchObject({
      status: "active",
      suspended_at: null,
      suspended_by_operator_id: null,
      suspended_reason: null,
    });
    expect(BigInt(afterSuspendedTransfer.targetClass.row_version)).toBe(
      BigInt(beforeSuspendedRollback.targetClass.row_version) + 1n,
    );
    expect(
      afterSuspendedTransfer.members.map(({ role, status, user_id }) => ({
        role,
        status,
        user_id,
      })),
    ).toEqual([
      { role: "teacher", status: "transferred", user_id: seeded.teacherUserId },
      { role: "teacher", status: "transferred", user_id: incoming.userId },
      {
        role: "teacher",
        status: "approved",
        user_id: suspendedReplacement.userId,
      },
    ]);
    expect(
      afterSuspendedTransfer.history.slice(beforeSuspendedRollback.history.length),
    ).toMatchObject([
      {
        actor_operator_id: operatorId,
        from_status: "approved",
        reason: "정지 학급 담임 이관",
        to_status: "transferred",
      },
      {
        actor_operator_id: operatorId,
        from_status: null,
        reason: "정지 학급 담임 이관",
        to_status: "approved",
      },
    ]);

    const reactivationClassAudit = afterSuspendedTransfer.classAudits.find(
      ({ action, request_id }) =>
        action === "class.reactivated" && request_id === suspendedTransfer.runId,
    );
    expect(reactivationClassAudit).toMatchObject({
      action: "class.reactivated",
      actor_display_name_snapshot: "운영자",
      actor_member_id: null,
      actor_role_snapshot: "operator",
      actor_user_id: null,
      after_json: { class_id: seeded.classId, status: "active", suspended_reason: null },
      before_json: { class_id: seeded.classId, status: "suspended" },
      class_id: seeded.classId,
      reason: "정지 학급 담임 이관",
      target_id: seeded.classId,
      target_type: "class",
    });
    expect(
      afterSuspendedTransfer.classAudits.find(
        ({ action, request_id }) =>
          action === "class.teacher_transferred" && request_id === suspendedTransfer.runId,
      ),
    ).toBeDefined();

    const reactivationOperatorAudits = afterSuspendedTransfer.operatorAudits.filter(
      ({ run_id }) => run_id === suspendedTransfer.runId,
    );
    expect(reactivationOperatorAudits).toMatchObject([
      {
        action: "class.reactivated",
        after_json: {
          class_id: seeded.classId,
          status: "active",
          teacher_user_id: suspendedReplacement.userId,
        },
        before_json: {
          class_id: seeded.classId,
          status: "suspended",
          teacher_user_id: incoming.userId,
        },
      },
      {
        action: "teacher.transferred",
        after_json: {
          class_id: seeded.classId,
          teacher_user_id: suspendedReplacement.userId,
        },
        before_json: { class_id: seeded.classId, teacher_user_id: incoming.userId },
      },
    ]);
    expect(
      reactivationOperatorAudits.every(
        ({ operator_id, target_id, target_type }) =>
          operator_id === operatorId && target_id === seeded.classId && target_type === "class",
      ),
    ).toBe(true);
    expect(JSON.stringify(reactivationOperatorAudits)).not.toContain(
      "suspended-transfer-to@example.com",
    );
  });

  it("fails closed for student, inactive, deleted, and revoked email conflicts", async () => {
    await database
      .insertInto("users")
      .values([
        {
          display_name: "학생 계정",
          email_normalized: "student@example.com",
          password_hash: "fixture-password-hash",
        },
        {
          display_name: "비활성 계정",
          email_normalized: "inactive@example.com",
          is_active: false,
          password_hash: "fixture-password-hash",
        },
        {
          deleted_at: new Date(),
          display_name: "삭제 계정",
          email_normalized: "deleted@example.com",
          password_hash: "fixture-password-hash",
        },
      ])
      .execute();
    const revokedUser = await database
      .insertInto("users")
      .values({
        display_name: "회수 교사",
        email_normalized: "revoked@example.com",
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await database
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operatorId,
        revoked_at: new Date(),
        revoked_by_operator_id: operatorId,
        status: "revoked",
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: revokedUser.id,
      })
      .execute();

    for (const email of [
      "student@example.com",
      "inactive@example.com",
      "deleted@example.com",
      "revoked@example.com",
    ]) {
      await expect(
        provisionTeacher({
          displayName: "충돌 담임",
          email,
          operatorDatabaseUrl,
          operatorToken,
        }),
      ).rejects.toThrow();
    }
    expect(
      (
        await database
          .selectFrom("operator_audit_logs")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("action", "=", "teacher.created")
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
  });

  it("rejects a migrator connection before either onboarding command can query or mutate", async () => {
    const seed = await seedFile("wrong-role-schools.json", [school("7010301")]);
    await expect(
      importSchools({
        dryRun: true,
        filePath: seed,
        operatorDatabaseUrl: migratorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toThrow("classhub_operator");
    await expect(
      provisionTeacher({
        displayName: "잘못된 역할",
        email: "wrong-role@example.com",
        operatorDatabaseUrl: migratorDatabaseUrl,
        operatorToken,
      }),
    ).rejects.toThrow("classhub_operator");
    expect(await countRows("schools")).toBe("0");
    expect(
      (
        await database
          .selectFrom("users")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
  });
});
