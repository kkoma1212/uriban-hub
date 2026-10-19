import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  parseSecurityAuditEvent,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_STREAM,
  type DB,
  type SecurityAuditEvent,
} from "@classhub/db";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { issueVerificationToken } from "../src/auth/auth-crypto.js";
import { hashPassword, verifyPassword } from "../src/auth/password-hasher.js";
import { hashSessionSecret } from "../src/auth/session-crypto.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import { loadEnvironment } from "../src/config/environment.js";
import { SECURITY_AUDIT_PUBLISHER } from "../src/security-audit/security-audit.tokens.js";
import type { SecurityAuditPublisher } from "../src/security-audit/security-audit.types.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const PASSWORD = "classhub123";
const NEW_PASSWORD = "resetPassword456";
const APP_ORIGIN = "https://classhub.test";
const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

interface AuthenticatedCookies {
  cookieHeader: string;
  csrfToken: string;
  sessionId: string;
  sessionToken: string;
}

interface ClassFixture {
  classId: string;
  inviteCode: string | null;
  teacherId: string;
  teacherMemberId: string;
}

let postgres: StartedNativeTestService;
let redis: StartedNativeTestService;
let redisStopped = false;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let applicationDatabase: ReturnType<typeof createDatabase<DB>>;
let securityRedis: RedisClientType;
let application: NestFastifyApplication;
let fixturePasswordHash: string;
let operatorId: string;
let classSequence = 0;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(
    5432,
  )}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(postgresUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql
      .raw(
        `CREATE TABLE pgmigrations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          run_on TIMESTAMPTZ NOT NULL
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

function responseCookies(headers: {
  "set-cookie"?: number | string | string[] | undefined;
}): string[] {
  const value = headers["set-cookie"];
  if (value === undefined || typeof value === "number") return [];
  return Array.isArray(value) ? value : [value];
}

function rawCookie(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const raw = cookie?.slice(name.length + 1).split(";", 1)[0];
  if (raw === undefined || raw.length === 0) throw new Error(`${name} cookie is missing.`);
  return raw;
}

async function createUser(
  email: string,
  options: { consents?: boolean; displayName?: string; verified?: boolean } = {},
): Promise<string> {
  const user = await bootstrapDatabase
    .insertInto("users")
    .values({
      display_name: options.displayName ?? "테스트 학생",
      email_normalized: email,
      email_verified_at: options.verified === false ? null : new Date(),
      password_hash: fixturePasswordHash,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (options.consents === true) {
    const acceptedAt = new Date();
    await bootstrapDatabase
      .insertInto("user_consents")
      .values(
        (["age_over_14", "privacy", "terms"] as const).map((consentType) => ({
          accepted_at: acceptedAt,
          consent_type: consentType,
          ip_address: "127.0.0.40",
          policy_version: "deletion-integration-v1",
          user_id: user.id,
        })),
      )
      .execute();
  }

  return user.id;
}

async function createClassFixture(
  label: string,
  status: "active" | "archived" | "suspended" = "active",
): Promise<ClassFixture> {
  classSequence += 1;
  const teacherId = await createUser(`${label}-${classSequence}-teacher@example.com`, {
    displayName: "테스트 교사",
  });
  await bootstrapDatabase
    .insertInto("teacher_profiles")
    .values({
      created_by_operator_id: operatorId,
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
      user_id: teacherId,
    })
    .execute();

  return bootstrapDatabase.transaction().execute(async (transaction) => {
    const now = new Date();
    const targetClass = await transaction
      .insertInto("classes")
      .values({
        academic_year: 2026,
        archived_at: status === "archived" ? now : null,
        archived_by_user_id: status === "archived" ? teacherId : null,
        created_by_user_id: teacherId,
        edu_office_code: "B10",
        expected_student_count: 30,
        grade: 1,
        name: `${label}-${classSequence}`,
        school_code: "1234567",
        status,
        suspended_at: status === "suspended" ? now : null,
        suspended_by_operator_id: status === "suspended" ? operatorId : null,
        suspended_reason: status === "suspended" ? "격리 테스트" : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const teacherMember = await transaction
      .insertInto("class_members")
      .values({
        class_id: targetClass.id,
        role: "teacher",
        status: status === "archived" ? "archived" : "approved",
        user_id: teacherId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const inviteCode =
      status === "active"
        ? `AAAAAAA${INVITE_CODE_ALPHABET[classSequence % INVITE_CODE_ALPHABET.length]}`
        : null;
    if (inviteCode !== null) {
      await transaction
        .insertInto("class_invite_codes")
        .values({
          class_id: targetClass.id,
          code: inviteCode,
          created_by_member_id: teacherMember.id,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        })
        .execute();
    }

    return {
      classId: targetClass.id,
      inviteCode,
      teacherId,
      teacherMemberId: teacherMember.id,
    };
  });
}

async function insertStudentMembership(
  fixture: ClassFixture,
  userId: string,
  status: "approved" | "left" | "pending",
  displayName: string,
): Promise<{ id: string; rowVersion: string }> {
  const member = await bootstrapDatabase
    .insertInto("class_members")
    .values({
      class_id: fixture.classId,
      display_name_in_class: displayName,
      role: "student",
      status,
      student_number: status === "approved" ? 17 : null,
      user_id: userId,
    })
    .returning(["id", "row_version"])
    .executeTakeFirstOrThrow();
  return { id: member.id, rowVersion: member.row_version };
}

async function login(email: string): Promise<AuthenticatedCookies> {
  const response = await application.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: APP_ORIGIN },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const cookies = responseCookies(response.headers);
  const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
  const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
  const session = await bootstrapDatabase
    .selectFrom("sessions")
    .select("id")
    .where("session_hash", "=", hashSessionSecret(sessionToken))
    .executeTakeFirstOrThrow();
  return {
    cookieHeader: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
    csrfToken,
    sessionId: session.id,
    sessionToken,
  };
}

function deletionRequest(
  authentication: AuthenticatedCookies,
  payload: Record<string, unknown> = {
    confirmation: "탈퇴",
    current_password: PASSWORD,
  },
) {
  return application.inject({
    method: "POST",
    url: "/api/v1/account/deletion",
    headers: {
      cookie: authentication.cookieHeader,
      origin: APP_ORIGIN,
      "user-agent": "c".repeat(43),
      "x-csrf-token": authentication.csrfToken,
    },
    payload,
  });
}

async function securityEventsForRequest(requestId: string): Promise<SecurityAuditEvent[]> {
  const entries = await securityRedis.xRange(SECURITY_AUDIT_STREAM, "-", "+");
  return entries
    .map((entry) => entry.message[SECURITY_AUDIT_EVENT_FIELD])
    .filter((serialized): serialized is string => serialized !== undefined)
    .map((serialized) => parseSecurityAuditEvent(serialized))
    .filter((event) => event.request_id === requestId);
}

async function addOpenTokens(
  userId: string,
): Promise<{ resetRaw: string; verificationRaw: string }> {
  const verification = issueVerificationToken();
  const reset = issueVerificationToken();
  await bootstrapDatabase
    .insertInto("email_verification_tokens")
    .values({
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      token_hash: verification.hash,
      user_id: userId,
    })
    .execute();
  await bootstrapDatabase
    .insertInto("password_reset_tokens")
    .values({
      expires_at: new Date(Date.now() + 30 * 60 * 1_000),
      requested_ip: "127.0.0.41",
      token_hash: reset.hash,
      user_id: userId,
    })
    .execute();
  return { resetRaw: reset.raw, verificationRaw: verification.raw };
}

async function addConfirmationRows(fixture: ClassFixture, memberId: string): Promise<void> {
  const now = new Date();
  const notice = await bootstrapDatabase
    .insertInto("notices")
    .values({
      class_id: fixture.classId,
      content: "격리 테스트 공지 본문",
      created_by_member_id: fixture.teacherMemberId,
      title: "격리 테스트 공지",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const supply = await bootstrapDatabase
    .insertInto("supplies")
    .values({
      class_id: fixture.classId,
      created_by_member_id: fixture.teacherMemberId,
      needed_on: new Date("2026-07-20T00:00:00.000Z"),
      title: "격리 테스트 준비물",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await bootstrapDatabase
    .insertInto("notice_reads")
    .values({
      class_id: fixture.classId,
      confirmed_at: now,
      confirmed_revision: "1",
      first_confirmed_at: now,
      member_id: memberId,
      notice_id: notice.id,
    })
    .execute();
  await bootstrapDatabase
    .insertInto("supply_checks")
    .values({
      checked_at: now,
      class_id: fixture.classId,
      confirmed_revision: "1",
      is_checked: true,
      member_id: memberId,
      supply_id: supply.id,
      unchecked_at: null,
    })
    .execute();
}

function withDeadline<T>(operation: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Concurrent deletion operation timed out.")),
      milliseconds,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([
    startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    }),
    startNativeTestService("redis"),
  ]);

  bootstrapDatabase = createDatabase<DB>(
    postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();
  applicationDatabase = createDatabase<DB>(postgresUrl("classhub_app", "local_app_password"));
  fixturePasswordHash = await hashPassword(PASSWORD);
  const operator = await bootstrapDatabase
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update("deletion-fixture-operator").digest(),
      email_normalized: "deletion-fixture-operator@classhub.local",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  operatorId = operator.id;
  await bootstrapDatabase
    .insertInto("schools")
    .values({
      edu_office_code: "B10",
      edu_office_name: "격리 테스트 교육청",
      region_name: "서울",
      school_code: "1234567",
      school_kind: "middle",
      school_name: "격리 테스트 중학교",
    })
    .execute();

  const redisUrl = `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`;
  const environment = loadEnvironment({
    AGE_POLICY_VERSION: "deletion-integration-v1",
    DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
    EMAIL_HMAC_KEY: "account-deletion-integration-hmac-key-32-bytes",
    EMAIL_HMAC_KEY_VERSION: "deletion-test-v1",
    LOCAL_TEST_ADMIN_ENABLED: "false",
    NODE_ENV: "test",
    PASSWORD_RESET_ENABLED: "true",
    PRIVACY_POLICY_VERSION: "deletion-integration-v1",
    PUBLIC_API_ORIGIN: APP_ORIGIN,
    PUBLIC_APP_ORIGIN: APP_ORIGIN,
    REDIS_URL: redisUrl,
    SERVE_WEB: "false",
    SMTP_FROM: "no-reply@classhub.local",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "9",
    SMTP_SECURE: "false",
    TERMS_POLICY_VERSION: "deletion-integration-v1",
  });
  const { createApplication } = await import("../src/app.factory.js");
  ({ app: application } = await createApplication({ environment }));

  securityRedis = createClient({ url: redisUrl });
  securityRedis.on("error", () => undefined);
  await securityRedis.connect();
}, 120_000);

beforeEach(async () => {
  await securityRedis.flushDb();
});

afterAll(async () => {
  await application?.close();
  await Promise.allSettled([
    securityRedis?.isOpen ? Promise.resolve(securityRedis.destroy()) : Promise.resolve(),
    applicationDatabase?.destroy(),
    bootstrapDatabase?.destroy(),
  ]);
  await Promise.allSettled([postgres?.stop(), redisStopped ? Promise.resolve() : redis?.stop()]);
}, 120_000);

describe.sequential("account deletion integration", () => {
  it("anonymizes an unverified student atomically, preserves reference rows, audits safely, and frees the email", async () => {
    const originalEmail = "delete-complete-student@example.com";
    const originalDisplayName = "삭제 대상 학생";
    const currentClass = await createClassFixture("delete-current");
    const pastClass = await createClassFixture("delete-past", "archived");
    const userId = await createUser(originalEmail, {
      consents: true,
      displayName: originalDisplayName,
      verified: false,
    });
    const current = await insertStudentMembership(currentClass, userId, "approved", "현재 반 학생");
    const past = await insertStudentMembership(pastClass, userId, "left", "과거 반 학생");
    await addConfirmationRows(currentClass, current.id);
    const rawTokens = await addOpenTokens(userId);
    await bootstrapDatabase
      .insertInto("student_assessment_records")
      .values({
        owner_user_id: userId,
        subject: "수학",
        title: "삭제되어야 하는 개인 평가 기록",
      })
      .execute();
    const firstAuthentication = await login(originalEmail);
    const secondAuthentication = await login(originalEmail);
    const beforeAccount = await bootstrapDatabase
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    const response = await deletionRequest(firstAuthentication);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ account_deleted: true, next_action: "LOGIN" });
    expect(responseCookies(response.headers)).toEqual([
      expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
      expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
    ]);

    const [
      account,
      memberships,
      history,
      audits,
      consents,
      verificationTokens,
      resetTokens,
      sessions,
      assessmentRecords,
    ] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select([
          "anonymized_at",
          "deleted_at",
          "display_name",
          "email_normalized",
          "failed_login_attempts",
          "is_active",
          "locked_until",
          "password_hash",
        ])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select([
          "class_id",
          "display_name_in_class",
          "id",
          "row_version",
          "status",
          "student_number",
        ])
        .where("user_id", "=", userId)
        .orderBy("class_id")
        .execute(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["actor_member_id", "actor_user_id", "class_id", "from_status", "to_status"])
        .where("member_id", "=", current.id)
        .where("to_status", "=", "account_deleted")
        .execute(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "action",
          "actor_display_name_snapshot",
          "actor_member_id",
          "actor_role_snapshot",
          "after_json",
          "before_json",
          "class_id",
          "request_id",
          "target_id",
          "target_snapshot",
        ])
        .where("actor_user_id", "=", userId)
        .where("action", "=", "member.account_deleted")
        .execute(),
      bootstrapDatabase
        .selectFrom("user_consents")
        .select(["ip_address", "retention_expires_at", "withdrawn_at"])
        .where("user_id", "=", userId)
        .orderBy("consent_type")
        .execute(),
      bootstrapDatabase
        .selectFrom("email_verification_tokens")
        .select(["invalidated_at", "used_at"])
        .where("user_id", "=", userId)
        .execute(),
      bootstrapDatabase
        .selectFrom("password_reset_tokens")
        .select(["invalidated_at", "used_at"])
        .where("user_id", "=", userId)
        .execute(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("user_id", "=", userId)
        .execute(),
      bootstrapDatabase
        .selectFrom("student_assessment_records")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("owner_user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);

    expect(account).toMatchObject({
      display_name: "탈퇴한 사용자",
      email_normalized: `deleted+${userId}@invalid.local`,
      failed_login_attempts: 0,
      is_active: false,
      locked_until: null,
    });
    expect(account.deleted_at).toBeInstanceOf(Date);
    expect(account.anonymized_at).toEqual(account.deleted_at);
    expect(account.password_hash).toMatch(/^deleted\$[A-Za-z0-9_-]{43}$/u);
    expect(account.password_hash).not.toBe(beforeAccount.password_hash);
    await expect(verifyPassword(PASSWORD, account.password_hash)).resolves.toBe(false);
    expect(assessmentRecords.count).toBe("0");

    const currentAfter = memberships.find(({ id }) => id === current.id);
    const pastAfter = memberships.find(({ id }) => id === past.id);
    expect(currentAfter).toMatchObject({
      class_id: currentClass.classId,
      display_name_in_class: null,
      row_version: String(BigInt(current.rowVersion) + 1n),
      status: "account_deleted",
      student_number: null,
    });
    expect(pastAfter).toMatchObject({
      class_id: pastClass.classId,
      display_name_in_class: null,
      row_version: past.rowVersion,
      status: "left",
      student_number: null,
    });
    expect(history).toEqual([
      {
        actor_member_id: current.id,
        actor_user_id: userId,
        class_id: currentClass.classId,
        from_status: "approved",
        to_status: "account_deleted",
      },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: "member.account_deleted",
        actor_display_name_snapshot: "탈퇴한 사용자",
        actor_member_id: current.id,
        actor_role_snapshot: "student",
        after_json: {
          display_name_snapshot: "탈퇴한 사용자",
          member_id: current.id,
          reason: null,
          role: "student",
          status: "account_deleted",
        },
        before_json: {
          display_name_snapshot: "탈퇴한 사용자",
          member_id: current.id,
          reason: null,
          role: "student",
          status: "approved",
        },
        class_id: currentClass.classId,
        target_id: current.id,
        target_snapshot: null,
      }),
    ]);
    expect(consents).toHaveLength(3);
    for (const consent of consents) {
      expect(consent.ip_address).toBeNull();
      expect(consent.withdrawn_at).toBeInstanceOf(Date);
      expect(consent.retention_expires_at).toBeInstanceOf(Date);
      expect(consent.retention_expires_at!.getTime() - consent.withdrawn_at!.getTime()).toBe(
        365 * 24 * 60 * 60 * 1_000,
      );
    }
    expect(verificationTokens).toEqual([{ invalidated_at: expect.any(Date), used_at: null }]);
    expect(resetTokens).toEqual([{ invalidated_at: expect.any(Date), used_at: null }]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every(({ revoked_at }) => revoked_at instanceof Date)).toBe(true);

    const [readCount, checkCount] = await Promise.all([
      bootstrapDatabase
        .selectFrom("notice_reads")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("member_id", "=", current.id)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("supply_checks")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("member_id", "=", current.id)
        .executeTakeFirstOrThrow(),
    ]);
    expect({ checks: checkCount.count, reads: readCount.count }).toEqual({
      checks: "1",
      reads: "1",
    });

    const requestId = String(response.headers["x-request-id"]);
    const securityEvents = await securityEventsForRequest(requestId);
    expect(securityEvents).toEqual([
      expect.objectContaining({
        action: "account.deleted",
        actor_class_id: currentClass.classId,
        actor_email_hmac: null,
        actor_user_id: userId,
        failure_code: null,
        hmac_key_version: null,
        method: "POST",
        request_id: requestId,
        resource: "account",
        sanitized_path: "/api/v1/account/deletion",
        target_class_id: null,
        user_agent: null,
      }),
    ]);
    const newAuditPayload = JSON.stringify({ audits, securityEvents });
    expect(newAuditPayload).not.toContain(originalEmail);
    expect(newAuditPayload).not.toContain(originalDisplayName);
    expect(newAuditPayload).not.toContain(rawTokens.resetRaw);
    expect(newAuditPayload).not.toContain(rawTokens.verificationRaw);

    const oldSession = await application.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: secondAuthentication.cookieHeader },
    });
    expect(oldSession.statusCode).toBe(401);

    const signUp = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: { origin: APP_ORIGIN },
      payload: {
        age_route: "over_14",
        role: "student",
        consents: { privacy: true, terms: true },
        display_name: "새 학생",
        email: originalEmail,
        password: PASSWORD,
      },
    });
    // 가입은 계정 존재 여부와 관계없이 202로 응답한다(7f30eff). 새 계정이 생겼는지는 DB로 확인한다.
    expect(signUp.statusCode, signUp.body).toBe(202);
    const replacement = await bootstrapDatabase
      .selectFrom("users")
      .select("id")
      .where("email_normalized", "=", originalEmail)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(replacement.id).not.toBe(userId);
  }, 60_000);

  it("enforces validation, Origin, CSRF, current-password, and user+IP rate-limit contracts without mutation", async () => {
    const email = "delete-contracts-student@example.com";
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);

    const invalidConfirmation = await deletionRequest(authentication, {
      confirmation: "탈퇴 ",
      current_password: PASSWORD,
    });
    expect(invalidConfirmation.statusCode).toBe(400);
    expect(invalidConfirmation.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const unknownField = await deletionRequest(authentication, {
      confirmation: "탈퇴",
      current_password: PASSWORD,
      delete_everything: true,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const missingCsrf = await application.inject({
      method: "POST",
      url: "/api/v1/account/deletion",
      headers: { cookie: authentication.cookieHeader, origin: APP_ORIGIN },
      payload: { confirmation: "탈퇴", current_password: PASSWORD },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const wrongOrigin = await application.inject({
      method: "POST",
      url: "/api/v1/account/deletion",
      headers: {
        cookie: authentication.cookieHeader,
        origin: "https://evil.example",
        "x-csrf-token": authentication.csrfToken,
      },
      payload: { confirmation: "탈퇴", current_password: PASSWORD },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });

    // P-018: the third failed password attempt reports the exhausted 3/60 budget.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wrongPassword = await deletionRequest(authentication, {
        confirmation: "탈퇴",
        current_password: "wrong-password",
      });
      expect(wrongPassword.statusCode, `attempt ${attempt + 1}`).toBe(401);
      expect(wrongPassword.json()).toMatchObject({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "현재 비밀번호가 올바르지 않습니다.",
        },
      });
    }
    const limited = await deletionRequest(authentication, {
      confirmation: "탈퇴",
      current_password: "wrong-password",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(limited.headers["x-ratelimit-limit"]).toBe("3");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["x-ratelimit-cooldown"]).toBe("60");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    const [account, session] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["deleted_at", "email_normalized", "is_active", "password_hash"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("id", "=", authentication.sessionId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(account).toEqual({
      deleted_at: null,
      email_normalized: email,
      is_active: true,
      password_hash: fixturePasswordHash,
    });
    expect(session.revoked_at).toBeNull();
  }, 45_000);

  it.each(["active", "suspended"] as const)(
    "blocks a teacher who owns a %s class with the stable 409 contract",
    async (classStatus) => {
      const fixture = await createClassFixture(`delete-block-${classStatus}`, classStatus);
      const teacherEmail = await bootstrapDatabase
        .selectFrom("users")
        .select("email_normalized")
        .where("id", "=", fixture.teacherId)
        .executeTakeFirstOrThrow();
      const authentication = await login(teacherEmail.email_normalized);

      const response = await deletionRequest(authentication);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "CONFLICT",
          message: "담당 중인 반 운영을 먼저 종료하거나 관리자에게 이관해 주세요.",
        },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();

      const [account, membership, session] = await Promise.all([
        bootstrapDatabase
          .selectFrom("users")
          .select(["deleted_at", "is_active"])
          .where("id", "=", fixture.teacherId)
          .executeTakeFirstOrThrow(),
        bootstrapDatabase
          .selectFrom("class_members")
          .select("status")
          .where("id", "=", fixture.teacherMemberId)
          .executeTakeFirstOrThrow(),
        bootstrapDatabase
          .selectFrom("sessions")
          .select("revoked_at")
          .where("id", "=", authentication.sessionId)
          .executeTakeFirstOrThrow(),
      ]);
      expect(account).toEqual({ deleted_at: null, is_active: true });
      expect(membership.status).toBe("approved");
      expect(session.revoked_at).toBeNull();
      await expect(
        securityEventsForRequest(String(response.headers["x-request-id"])),
      ).resolves.toEqual([]);
    },
    45_000,
  );

  it("serializes membership signup against deletion so no deleted account keeps a pending membership", async () => {
    const email = "delete-membership-race@example.com";
    const fixture = await createClassFixture("delete-membership-race");
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);
    if (fixture.inviteCode === null) throw new Error("Active class invite code is missing.");

    const [membershipResponse, deletionResponse] = await withDeadline(
      Promise.all([
        application.inject({
          method: "POST",
          url: "/api/v1/membership-requests",
          headers: {
            cookie: authentication.cookieHeader,
            origin: APP_ORIGIN,
            "x-csrf-token": authentication.csrfToken,
          },
          payload: { invite_code: fixture.inviteCode },
        }),
        deletionRequest(authentication),
      ]),
    );

    expect(deletionResponse.statusCode, deletionResponse.body).toBe(200);
    expect([201, 401]).toContain(membershipResponse.statusCode);
    const [account, memberships] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["deleted_at", "is_active"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select("status")
        .where("user_id", "=", userId)
        .execute(),
    ]);
    expect(account.is_active).toBe(false);
    expect(account.deleted_at).toBeInstanceOf(Date);
    expect(memberships.every(({ status }) => status !== "pending")).toBe(true);
    if (membershipResponse.statusCode === 201) {
      expect(memberships).toEqual([{ status: "account_deleted" }]);
    } else {
      expect(memberships).toEqual([]);
    }
  }, 45_000);

  it("serializes account profile update against deletion through the shared user row lock", async () => {
    const email = "delete-profile-race@example.com";
    const userId = await createUser(email, {
      consents: true,
      displayName: "삭제 경쟁 전 이름",
    });
    const authentication = await login(email);

    const [profileResponse, deletionResponse] = await withDeadline(
      Promise.all([
        application.inject({
          method: "PATCH",
          url: "/api/v1/account/profile",
          headers: {
            cookie: authentication.cookieHeader,
            origin: APP_ORIGIN,
            "x-csrf-token": authentication.csrfToken,
          },
          payload: { display_name: "삭제 경쟁 중 이름" },
        }),
        deletionRequest(authentication),
      ]),
    );

    expect(deletionResponse.statusCode, deletionResponse.body).toBe(200);
    expect([200, 401]).toContain(profileResponse.statusCode);
    if (profileResponse.statusCode === 200) {
      expect(profileResponse.json()).toMatchObject({
        display_name: "삭제 경쟁 중 이름",
        profile_updated: true,
      });
    }

    const account = await bootstrapDatabase
      .selectFrom("users")
      .select(["deleted_at", "display_name", "is_active"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      display_name: "탈퇴한 사용자",
      is_active: false,
    });
    expect(account.deleted_at).toBeInstanceOf(Date);
  }, 45_000);

  it("serializes password-reset request against deletion and leaves no open reset token", async () => {
    const email = "delete-reset-request-race@example.com";
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);

    const [resetRequest, deletionResponse] = await withDeadline(
      Promise.all([
        application.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset-requests",
          headers: { origin: APP_ORIGIN },
          payload: { email },
        }),
        deletionRequest(authentication),
      ]),
    );
    expect(resetRequest.statusCode, resetRequest.body).toBe(202);
    expect(deletionResponse.statusCode, deletionResponse.body).toBe(200);

    const [account, openTokens] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["deleted_at", "is_active"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("password_reset_tokens")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", userId)
        .where("used_at", "is", null)
        .where("invalidated_at", "is", null)
        .executeTakeFirstOrThrow(),
    ]);
    expect(account.is_active).toBe(false);
    expect(account.deleted_at).toBeInstanceOf(Date);
    expect(openTokens.count).toBe("0");

    const allEvents = await securityRedis.xRange(SECURITY_AUDIT_STREAM, "-", "+");
    const serializedEvents = JSON.stringify(allEvents);
    expect(serializedEvents).not.toContain(email);
    expect(serializedEvents).not.toContain(PASSWORD);
  }, 45_000);

  it("serializes reset completion against deletion without accepting stale password or session state", async () => {
    const email = "delete-reset-confirm-race@example.com";
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);
    const resetToken = issueVerificationToken();
    await bootstrapDatabase
      .insertInto("password_reset_tokens")
      .values({
        expires_at: new Date(Date.now() + 30 * 60 * 1_000),
        requested_ip: "127.0.0.43",
        token_hash: resetToken.hash,
        user_id: userId,
      })
      .execute();

    const [resetResponse, deletionResponse] = await withDeadline(
      Promise.all([
        application.inject({
          method: "POST",
          url: "/api/v1/auth/password-resets/confirm",
          headers: { origin: APP_ORIGIN },
          payload: { new_password: NEW_PASSWORD, token: resetToken.raw },
        }),
        deletionRequest(authentication),
      ]),
    );

    const account = await bootstrapDatabase
      .selectFrom("users")
      .select(["deleted_at", "is_active", "password_hash"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const token = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(["invalidated_at", "used_at"])
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    const session = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("id", "=", authentication.sessionId)
      .executeTakeFirstOrThrow();

    if (deletionResponse.statusCode === 200) {
      expect(resetResponse.statusCode).toBe(400);
      expect(account.is_active).toBe(false);
      expect(account.deleted_at).toBeInstanceOf(Date);
      expect(account.password_hash).toMatch(/^deleted\$/u);
      expect(token).toEqual({ invalidated_at: expect.any(Date), used_at: null });
      await expect(verifyPassword(NEW_PASSWORD, account.password_hash)).resolves.toBe(false);
    } else {
      expect(deletionResponse.statusCode).toBe(401);
      expect(resetResponse.statusCode, resetResponse.body).toBe(200);
      expect(account).toMatchObject({ deleted_at: null, is_active: true });
      expect(token).toEqual({ invalidated_at: null, used_at: expect.any(Date) });
      await expect(verifyPassword(NEW_PASSWORD, account.password_hash)).resolves.toBe(true);
    }
    expect(session.revoked_at).toBeInstanceOf(Date);
    expect(
      [resetResponse.statusCode, deletionResponse.statusCode].filter((status) => status === 200),
    ).toHaveLength(1);
  }, 45_000);

  it("serializes same-email signup against deletion without identity reuse or a uniqueness leak", async () => {
    const email = "delete-signup-race@example.com";
    const oldUserId = await createUser(email, { consents: true });
    const authentication = await login(email);

    const [signUpResponse, deletionResponse] = await withDeadline(
      Promise.all([
        application.inject({
          method: "POST",
          url: "/api/v1/auth/sign-up",
          headers: { origin: APP_ORIGIN },
          payload: {
            age_route: "over_14",
            role: "student",
            consents: { privacy: true, terms: true },
            display_name: "경쟁 신규 학생",
            email,
            password: PASSWORD,
          },
        }),
        deletionRequest(authentication),
      ]),
      20_000,
    );

    expect(deletionResponse.statusCode, deletionResponse.body).toBe(200);
    // 가입 응답은 순서와 관계없이 202로 같다(계정 존재 여부 비노출, 7f30eff).
    expect(signUpResponse.statusCode, signUpResponse.body).toBe(202);
    const oldUser = await bootstrapDatabase
      .selectFrom("users")
      .select(["deleted_at", "email_normalized", "is_active"])
      .where("id", "=", oldUserId)
      .executeTakeFirstOrThrow();
    const activeReplacement = await bootstrapDatabase
      .selectFrom("users")
      .select("id")
      .where("email_normalized", "=", email)
      .where("deleted_at", "is", null)
      .execute();
    expect(oldUser).toMatchObject({
      email_normalized: `deleted+${oldUserId}@invalid.local`,
      is_active: false,
    });
    expect(oldUser.deleted_at).toBeInstanceOf(Date);
    // 삭제보다 먼저 처리되면 새 계정이 없고, 나중이면 새 계정 하나가 생긴다. 옛 계정 재사용은 없어야 한다.
    expect(activeReplacement.length).toBeLessThanOrEqual(1);
    if (activeReplacement.length === 1) {
      expect(activeReplacement[0]!.id).not.toBe(oldUserId);
    }
  }, 45_000);

  /*
   * 개인정보처리방침 §3.4 는 계정을 지우면 "해당 학생의 행이 삭제된다"고 약속한다.
   * 그런데 선거와 당번은 남고 있었다 — 후보 기록과 당번 배정에는 **그때의 표시명과
   * 학생번호가 사본으로** 들어 있어서, 탈퇴한 뒤에도 교사 화면에 이름이 계속 보였다
   * (2026-08-22 감사 RED/BLUE-03, P1).
   *
   * 참여 기록은 DELETE 권한이 없어 못 지웠고, 마이그레이션 36000 이 그 권한을 열었다.
   * **개표 결과는 따로 세므로 이 삭제로 바뀌지 않는다** — 그것도 함께 잰다.
   */
  it("erases election and duty rows on deletion while leaving the tally intact", async () => {
    const email = "delete-election-duty@example.com";
    const fixture = await createClassFixture("delete-election");
    const userId = await createUser(email, { consents: true });
    const membership = await insertStudentMembership(fixture, userId, "approved", "선거 참여 학생");

    const election = await bootstrapDatabase
      .insertInto("elections")
      .values({
        class_id: fixture.classId,
        created_by_member_id: membership.id,
        results_visibility: "with_counts",
        status: "open",
        tie_break: "revote",
        title: "삭제 확인용 선거",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const candidate = await bootstrapDatabase
      .insertInto("election_candidates")
      .values({
        class_id: fixture.classId,
        display_name_snapshot: "선거 참여 학생",
        election_id: election.id,
        member_id: membership.id,
        student_number_snapshot: 17,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("election_tallies")
      .values({ candidate_id: candidate.id, election_id: election.id, vote_count: 1 })
      .execute();
    await bootstrapDatabase
      .insertInto("election_participants")
      .values({
        class_id: fixture.classId,
        election_id: election.id,
        member_id: membership.id,
      })
      .execute();

    const roster = await bootstrapDatabase
      .insertInto("duty_rosters")
      .values({
        assigned_student_count: 1,
        class_id: fixture.classId,
        created_by_member_id: membership.id,
        role_count: 1,
        title: "삭제 확인용 당번",
        unassigned_student_count: 0,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const role = await bootstrapDatabase
      .insertInto("class_duty_roles")
      .values({
        class_id: fixture.classId,
        name: "칠판 지우기",
        required_count: 1,
        sort_index: 1,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("duty_assignments")
      .values({
        class_id: fixture.classId,
        display_name_snapshot: "선거 참여 학생",
        duty_role_id: role.id,
        duty_roster_id: roster.id,
        member_id: membership.id,
        role_name_snapshot: "칠판 지우기",
        student_number_snapshot: 17,
      })
      .execute();

    const authentication = await login(email);
    const response = await deletionRequest(authentication);
    expect(response.statusCode, response.body).toBe(200);

    const participants = await bootstrapDatabase
      .selectFrom("election_participants")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("member_id", "=", membership.id)
      .executeTakeFirstOrThrow();
    expect(participants.count, "참여 기록이 남았다").toBe("0");

    const duties = await bootstrapDatabase
      .selectFrom("duty_assignments")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("member_id", "=", membership.id)
      .executeTakeFirstOrThrow();
    expect(duties.count, "당번 배정(이름 사본)이 남았다").toBe("0");

    /*
     * 후보 행은 **남기고 이름만 지운다** — 개표 결과가 후보를 `ON DELETE RESTRICT` 로
     * 참조하므로 행을 지우면 지난 선거의 득표 수가 함께 사라진다. 남길 것은 "몇 표였나",
     * 지울 것은 "누구였나"다.
     */
    const remainingCandidate = await bootstrapDatabase
      .selectFrom("election_candidates")
      .select(["display_name_snapshot", "student_number_snapshot"])
      .where("member_id", "=", membership.id)
      .executeTakeFirstOrThrow();
    expect(remainingCandidate.display_name_snapshot, "후보 이름이 그대로 남았다").not.toBe(
      "선거 참여 학생",
    );
    expect(remainingCandidate.student_number_snapshot, "학생번호가 남았다").toBeNull();

    /* 개표 결과는 그대로여야 한다 — 이름을 지우는 것이 표를 지우는 것이면 안 된다. */
    const tally = await bootstrapDatabase
      .selectFrom("election_tallies")
      .select(["vote_count"])
      .where("election_id", "=", election.id)
      .executeTakeFirstOrThrow();
    expect(tally.vote_count, "삭제가 개표 결과를 바꿨다").toBe(1);
  }, 45_000);

  it("publishes account.deleted with a null actor class when there is no current membership", async () => {
    const email = "delete-no-membership@example.com";
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);

    const response = await deletionRequest(authentication);
    expect(response.statusCode, response.body).toBe(200);
    const requestId = String(response.headers["x-request-id"]);
    await expect(securityEventsForRequest(requestId)).resolves.toEqual([
      expect.objectContaining({
        action: "account.deleted",
        actor_class_id: null,
        actor_user_id: userId,
        resource: "account",
      }),
    ]);
    const classAudit = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("actor_user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(classAudit.count).toBe("0");
  }, 45_000);

  // 2026-10-03 사용자 결정(보관기간 ①): 처리방침의 '계정 삭제 시 알림 구독 즉시 삭제'를 실제 DB로 확인한다.
  it("removes the account's push subscriptions in the deletion transaction", async () => {
    const email = "delete-push@example.com";
    const userId = await createUser(email, { consents: true });
    await bootstrapDatabase
      .insertInto("push_subscriptions")
      .values({
        user_id: userId,
        endpoint: "https://push.example.invalid/delete-push",
        p256dh: "p".repeat(87),
        auth_secret: "a".repeat(22),
      } as never)
      .execute();
    const authentication = await login(email);
    const response = await deletionRequest(authentication);
    expect(response.statusCode, response.body).toBe(200);
    const left = await bootstrapDatabase
      .selectFrom("push_subscriptions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(left.count).toBe("0");
  }, 45_000);

  it("keeps HTTP 200 and clears cookies when the post-commit security publisher unexpectedly rejects", async () => {
    const email = "delete-publisher-failure@example.com";
    const originalDisplayName = "발행 실패 삭제 학생";
    const userId = await createUser(email, {
      consents: true,
      displayName: originalDisplayName,
    });
    const rawTokens = await addOpenTokens(userId);
    const authentication = await login(email);
    const publisher = application.get<SecurityAuditPublisher>(SECURITY_AUDIT_PUBLISHER);
    const publisherSpy = vi
      .spyOn(publisher, "publish")
      .mockRejectedValue(new Error(`unhandled publisher detail ${email} ${rawTokens.resetRaw}`));
    const loggerSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {
      throw new Error(`fallback logger detail ${email} ${rawTokens.verificationRaw}`);
    });

    try {
      const response = await deletionRequest(authentication);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ account_deleted: true, next_action: "LOGIN" });
      expect(responseCookies(response.headers)).toEqual([
        expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
        expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
      ]);

      const account = await bootstrapDatabase
        .selectFrom("users")
        .select(["deleted_at", "display_name", "email_normalized", "is_active"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(account).toMatchObject({
        display_name: "탈퇴한 사용자",
        email_normalized: `deleted+${userId}@invalid.local`,
        is_active: false,
      });
      expect(account.deleted_at).toBeInstanceOf(Date);
      expect(publisherSpy).toHaveBeenCalledTimes(1);
      const rejectedEvent = publisherSpy.mock.calls[0]![0];
      expect(rejectedEvent).toMatchObject({
        action: "account.deleted",
        actor_class_id: null,
        actor_email_hmac: null,
        actor_user_id: userId,
        resource: "account",
      });
      expect(loggerSpy).toHaveBeenCalledWith({
        action: "security_audit.publish_failed",
        event_id: rejectedEvent.event_id,
        failure_code: "security_publisher_unhandled",
        request_id: String(response.headers["x-request-id"]),
      });
      const safeFailureBoundary = JSON.stringify({
        event: rejectedEvent,
        logs: loggerSpy.mock.calls,
      });
      expect(safeFailureBoundary).not.toContain(email);
      expect(safeFailureBoundary).not.toContain(originalDisplayName);
      expect(safeFailureBoundary).not.toContain(rawTokens.resetRaw);
      expect(safeFailureBoundary).not.toContain(rawTokens.verificationRaw);
      await expect(
        securityEventsForRequest(String(response.headers["x-request-id"])),
      ).resolves.toEqual([]);
    } finally {
      publisherSpy.mockRestore();
      loggerSpy.mockRestore();
    }
  }, 45_000);

  it("returns 503 before any DB change when the rate-limit Redis is unavailable", async () => {
    const email = "delete-redis-unavailable@example.com";
    const userId = await createUser(email, { consents: true });
    const authentication = await login(email);
    const before = await bootstrapDatabase
      .selectFrom("users")
      .select(["deleted_at", "display_name", "email_normalized", "is_active", "password_hash"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    await redis.stop();
    redisStopped = true;
    const response = await deletionRequest(authentication);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
        message: "요청을 처리하지 못했습니다.",
      },
    });
    expect(response.headers["set-cookie"]).toBeUndefined();

    const [after, session, memberships, audits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["deleted_at", "display_name", "email_normalized", "is_active", "password_hash"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("id", "=", authentication.sessionId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(after).toEqual(before);
    expect(session.revoked_at).toBeNull();
    expect(memberships.count).toBe("0");
    expect(audits.count).toBe("0");
  }, 45_000);
});
