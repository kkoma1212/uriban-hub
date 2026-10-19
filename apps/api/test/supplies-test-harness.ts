import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";

import { issueSessionSecrets } from "../src/auth/session-crypto.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import { kstDate } from "../src/common/date/kst-date.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

export const publicOrigin = "https://classhub.test";
const environmentKeys = [
  "ATTENDANCE_NOTIFICATIONS_ENABLED",
  "CONTENT_SELECTED_AUDIENCE_ENABLED",
  "DATABASE_URL",
  "DUTY_ROSTERS_ENABLED",
  "EMAIL_HMAC_KEY",
  "EMAIL_HMAC_KEY_VERSION",
  "LOCAL_TEST_ADMIN_DATABASE_URL",
  "LOCAL_TEST_ADMIN_ENABLED",
  "LOCAL_TEST_ADMIN_OPERATOR_EMAIL",
  "LOCAL_TEST_ADMIN_PASSWORD_HASH",
  "LOCAL_TEST_ADMIN_USERNAME",
  "LOG_LEVEL",
  "NODE_ENV",
  "PUBLIC_API_ORIGIN",
  "PUBLIC_APP_ORIGIN",
  "POLLS_ENABLED",
  "REDIS_URL",
  "SEAT_DRAW_STUDIO_ENABLED",
  "SEAT_DRAWS_ENABLED",
  "SERVE_WEB",
  "STUDENT_ASSESSMENTS_ENABLED",
  "TEAM_DRAWS_ENABLED",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));

export interface ActorFixture {
  headers: Record<string, string>;
  memberId: null | string;
  userId: string;
}

export interface ClassFixture {
  classId: string;
  inactive: ActorFixture;
  operatorId: string;
  outsider: ActorFixture;
  students: [ActorFixture, ActorFixture, ActorFixture];
  teacher: ActorFixture;
}

type ApplicationFactory = () => Promise<{ app: NestFastifyApplication }>;

let postgres: StartedNativeTestService;
let redis: StartedNativeTestService | undefined;
export let database: ReturnType<typeof createDatabase<DB>>;
export let app: NestFastifyApplication;
let fixtureSequence = 0;
let supplySequence = 0;

function host(): string {
  return postgres.getHost() === "localhost" ? "127.0.0.1" : postgres.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${host()}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(postgresUrl("classhub_migrator", "local_migrator_password"));
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

async function issueActor(userId: string, memberId: null | string): Promise<ActorFixture> {
  const secrets = issueSessionSecrets();
  await database
    .insertInto("sessions")
    .values({
      created_ip: "127.0.0.1",
      csrf_token_hash: secrets.csrfTokenHash,
      expires_at: sql<Date>`now() + interval '1 day'`,
      session_hash: secrets.sessionTokenHash,
      user_id: userId,
    })
    .execute();
  return {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${secrets.sessionToken}; ${CSRF_COOKIE_NAME}=${secrets.csrfToken}`,
      origin: publicOrigin,
      "x-csrf-token": secrets.csrfToken,
    },
    memberId,
    userId,
  };
}

export async function createClassFixture(): Promise<ClassFixture> {
  const sequence = ++fixtureSequence;
  const schoolCode = String(8_000_000 + sequence);
  const ids = await database.transaction().execute(async (transaction) => {
    const operator = await transaction
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256").update(`supplies-operator-${sequence}`).digest(),
        email_normalized: `supplies-operator-${sequence}@classhub.local`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const addUser = async (name: string, active = true) =>
      transaction
        .insertInto("users")
        .values({
          display_name: name,
          email_normalized: `supplies-${sequence}-${name}@example.com`,
          email_verified_at: new Date(),
          is_active: active,
          password_hash: "fixture-password-hash",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const teacher = await addUser("교사");
    const students = await Promise.all([addUser("학생가"), addUser("학생나"), addUser("학생다")]);
    const inactive = await addUser("비활성학생", false);
    const outsider = await addUser("외부학생");
    await transaction
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: teacher.id,
      })
      .execute();
    await transaction
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "테스트 교육청",
        region_name: "서울",
        school_code: schoolCode,
        school_kind: "high",
        school_name: `준비물 테스트 학교 ${sequence}`,
      })
      .execute();
    const targetClass = await transaction
      .insertInto("classes")
      .values({
        academic_year: 2026,
        created_by_user_id: teacher.id,
        edu_office_code: "B10",
        expected_student_count: 30,
        grade: 2,
        name: `${sequence}반`,
        school_code: schoolCode,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const teacherMember = await transaction
      .insertInto("class_members")
      .values({
        class_id: targetClass.id,
        role: "teacher",
        status: "approved",
        user_id: teacher.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const studentMembers: Array<{ id: string }> = [];
    for (const [index, student] of students.entries()) {
      studentMembers.push(
        await transaction
          .insertInto("class_members")
          .values({
            class_id: targetClass.id,
            role: "student",
            status: "approved",
            student_number: index + 1,
            user_id: student.id,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
    }
    const inactiveMember = await transaction
      .insertInto("class_members")
      .values({
        class_id: targetClass.id,
        role: "student",
        status: "approved",
        student_number: 4,
        user_id: inactive.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return {
      classId: targetClass.id,
      inactive: { memberId: inactiveMember.id, userId: inactive.id },
      operatorId: operator.id,
      outsiderId: outsider.id,
      students: students.map((student, index) => ({
        memberId: studentMembers[index]!.id,
        userId: student.id,
      })),
      teacher: { memberId: teacherMember.id, userId: teacher.id },
    };
  });
  const [teacher, studentA, studentB, studentC, inactive, outsider] = await Promise.all([
    issueActor(ids.teacher.userId, ids.teacher.memberId),
    issueActor(ids.students[0]!.userId, ids.students[0]!.memberId),
    issueActor(ids.students[1]!.userId, ids.students[1]!.memberId),
    issueActor(ids.students[2]!.userId, ids.students[2]!.memberId),
    issueActor(ids.inactive.userId, ids.inactive.memberId),
    issueActor(ids.outsiderId, null),
  ]);
  return {
    classId: ids.classId,
    inactive,
    operatorId: ids.operatorId,
    outsider,
    students: [studentA, studentB, studentC],
    teacher,
  };
}

export async function seedSupply(
  owner: ClassFixture,
  values: Partial<{
    /* 숙제도 준비물과 같은 표를 쓴다 — 분류를 못 심으면 숙제 경로를 잴 수 없다. */
    category: "general" | "homework";
    content_revision: number;
    description: null | string;
    needed_on: string;
    row_version: number;
    title: string;
  }> = {},
) {
  return database
    .insertInto("supplies")
    .values({
      category: values.category,
      class_id: owner.classId,
      content_revision: values.content_revision,
      created_by_member_id: owner.teacher.memberId!,
      description: values.description ?? null,
      needed_on: values.needed_on ?? kstDate(new Date()),
      row_version: values.row_version,
      title: values.title ?? `준비물 ${++supplySequence}`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function setupSuppliesHarnessInternal(
  applicationFactory?: ApplicationFactory,
  withRedis = false,
  withStudentAssessments = false,
  withPolls = false,
  withSeatDraws = false,
  withTeamDraws = false,
  withDutyRosters = false,
  withElections = false,
): Promise<void> {
  postgres = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  database = createDatabase<DB>(postgresUrl("classhub_bootstrap", "local_bootstrap_password"));
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(database);
  await applyMigrations();
  if (withRedis) {
    redis = await startNativeTestService("redis");
  }
  Object.assign(process.env, {
    ATTENDANCE_NOTIFICATIONS_ENABLED: "true",
    CONTENT_SELECTED_AUDIENCE_ENABLED: "true",
    DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
    DUTY_ROSTERS_ENABLED: withDutyRosters ? "true" : "false",
    ELECTIONS_ENABLED: withElections ? "true" : "false",
    EMAIL_HMAC_KEY: "supplies-integration-hmac-key-at-least-32-bytes",
    EMAIL_HMAC_KEY_VERSION: "test-v1",
    LOCAL_TEST_ADMIN_ENABLED: "false",
    LOG_LEVEL: "fatal",
    NODE_ENV: "test",
    PUBLIC_API_ORIGIN: publicOrigin,
    PUBLIC_APP_ORIGIN: publicOrigin,
    POLLS_ENABLED: withPolls ? "true" : "false",
    REDIS_URL:
      redis === undefined
        ? "redis://127.0.0.1:1"
        : `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    SEAT_DRAW_STUDIO_ENABLED: withSeatDraws ? "true" : "false",
    SEAT_DRAWS_ENABLED: withSeatDraws ? "true" : "false",
    SERVE_WEB: "false",
    STUDENT_ASSESSMENTS_ENABLED: withStudentAssessments ? "true" : "false",
    TEAM_DRAWS_ENABLED: withTeamDraws ? "true" : "false",
  });
  const createApplication =
    applicationFactory ?? (await import("../src/app.factory.js")).createApplication;
  ({ app } = await createApplication());
}

export async function setupSuppliesHarness(): Promise<void> {
  await setupSuppliesHarnessInternal();
}

export async function setupStudentAssessmentsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, false, true);
}

export async function setupPollsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, true);
}

export async function setupSeatDrawsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, false, true);
}

export async function setupTeamDrawsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, false, false, true);
}

export async function setupDutyRostersHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, false, false, false, true);
}

export async function setupElectionsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, false, false, false, false, true);
}

/*
 * 임시저장(T-HUB-31)은 자기 스위치가 없다 — 자리·모둠 중 하나라도 켜지면 함께 뜬다.
 * 그래서 자리 배치를 켜는 것이 곧 이 모듈을 켜는 것이다.
 */
export async function setupLayoutDraftsHarness(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true, false, false, true, false, false, false);
}

export async function setupSuppliesHarnessWithRedis(): Promise<void> {
  await setupSuppliesHarnessInternal(undefined, true);
}

export async function setupSuppliesHarnessWithApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory);
}

export async function setupSuppliesHarnessWithRedisAndApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory, true);
}

export async function setupStudentAssessmentsHarnessWithRedisAndApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory, true, true);
}

export async function setupPollsHarnessWithRedisAndApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory, true, false, true);
}

export async function setupSeatDrawsHarnessWithRedisAndApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory, true, false, false, true);
}

export async function setupTeamDrawsHarnessWithRedisAndApplicationFactory(
  applicationFactory: ApplicationFactory,
): Promise<void> {
  await setupSuppliesHarnessInternal(applicationFactory, true, false, false, false, true);
}

export async function teardownSuppliesHarness(): Promise<void> {
  let cleanupError: unknown;
  try {
    for (const result of await Promise.allSettled([app?.close(), database?.destroy()])) {
      if (result.status === "rejected") cleanupError ??= result.reason;
    }
    try {
      await postgres?.stop();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await redis?.stop();
      redis = undefined;
    } catch (error) {
      cleanupError ??= error;
    }
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}

export async function stopSuppliesHarnessRedis(): Promise<void> {
  await redis?.stop();
  redis = undefined;
}

export function getSuppliesHarnessRedisUrl(): string {
  if (redis === undefined) throw new Error("The supplies harness Redis container is not running.");
  return `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}
