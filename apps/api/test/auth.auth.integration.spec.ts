import { readFile } from "node:fs/promises";
import { argon2, createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  parseSecurityAuditEvent,
  SECURITY_AUDIT_EVENT_FIELD,
  SECURITY_AUDIT_STREAM,
  type DB,
  type SecurityAuditEvent,
} from "@classhub/db";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountService } from "../src/account/account.service.js";
import { AccountRecoveryService } from "../src/auth/account-recovery.service.js";
import { SignupApprovalRedemptionService } from "../src/auth/signup-approval-redemption.service.js";
import { AuthService } from "../src/auth/auth.service.js";
import { AdminSignupApprovalService } from "../src/admin-signup-approval/admin-signup-approval.service.js";
import { AdminUsersService } from "../src/admin-management/admin-users.service.js";
import type { AppEnvironment } from "../src/config/environment.js";
import { createPrivacySafeSubject, hashVerificationToken } from "../src/auth/auth-crypto.js";
import {
  EmailAlreadyVerifiedException,
  InvalidCredentialsException,
  InvalidGuardianConsentException,
  SignupApprovalInvalidException,
  EmailAlreadyRegisteredException,
  TokenInvalidOrExpiredException,
  UnauthenticatedException,
} from "../src/auth/auth.errors.js";
import { SessionService } from "../src/auth/session.service.js";
import { LoginAdmission } from "../src/auth/login-admission.js";
import { hashPassword, verifyPassword } from "../src/auth/password-hasher.js";
import { PasswordResetService } from "../src/auth/password-reset.service.js";
import type { AuthConfig, SignUpCommand } from "../src/auth/auth.types.js";
import { hashSessionSecret } from "../src/auth/session-crypto.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import {
  RateLimitedException,
  RateLimitServiceUnavailableException,
} from "../src/common/rate-limit/rate-limit.errors.js";
import {
  createRedisRateLimiter,
  RedisRateLimiter,
  type RateLimitResult,
} from "../src/common/rate-limit/redis-rate-limiter.js";
import { addCalendarDays } from "../src/common/date/kst-date.js";
import type { VerificationMailer } from "../src/mail/verification-mailer.js";
import type { PasswordResetMailer } from "../src/mail/password-reset-mailer.js";
import {
  LOCAL_ADMIN_CSRF_COOKIE,
  LOCAL_ADMIN_SESSION_COOKIE,
} from "../src/local-test-admin/local-test-admin.cookies.js";
import {
  CurrentMembershipExistsException,
  EmailNotVerifiedException,
  InvalidInviteCodeException,
  MembershipRequestNotAllowedException,
  MembershipStatusChangedException,
} from "../src/membership/membership.errors.js";
import { MembershipService } from "../src/membership/membership.service.js";
import { HomeNotFoundException, HomeUnavailableException } from "../src/home/home.errors.js";
import { HomeService } from "../src/home/home.service.js";
import {
  MemberAccountInactiveException,
  MemberStatusChangedException,
} from "../src/members/members.errors.js";
import { MembersService } from "../src/members/members.service.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);

const authConfig: AuthConfig = {
  agePolicyVersion: "age-2026-07",
  emailHmacKey: "integration-test-email-hmac-key-32-bytes",
  emailHmacKeyVersion: "test-v1",
  privacyPolicyVersion: "privacy-2026-07",
  termsPolicyVersion: "terms-2026-07",
};
const featureEnvironmentKeys = [
  "ATTENDANCE_NOTIFICATIONS_ENABLED",
  "PASSWORD_RESET_ENABLED",
  "POLLS_ENABLED",
  "SEAT_DRAWS_ENABLED",
  "TEAM_DRAWS_ENABLED",
] as const;
const originalFeatureEnvironment = new Map(
  featureEnvironmentKeys.map((key) => [key, process.env[key]] as const),
);

const localAdminTestPassword = "integration-local-admin-password-1234";

const baseCommand: SignUpCommand = {
  age_route: "over_14",
  consents: { privacy: true, terms: true },
  display_name: "학생 하나",
  email: "student@example.com",
  password: "Safe1234",
  role: "student",
};

class RecordingMailer implements VerificationMailer {
  readonly guardianMessages: Array<{ email: string; rawToken: string }> = [];
  readonly messages: Array<{ email: string; rawToken: string }> = [];
  shouldFail = false;

  async sendGuardianConsentEmail(email: string, rawToken: string): Promise<void> {
    if (this.shouldFail) {
      throw new Error("simulated SMTP failure");
    }

    this.guardianMessages.push({ email, rawToken });
  }

  async sendVerificationEmail(email: string, rawToken: string): Promise<void> {
    if (this.shouldFail) {
      throw new Error("simulated SMTP failure");
    }

    this.messages.push({ email, rawToken });
  }

  reset(): void {
    this.guardianMessages.length = 0;
    this.messages.length = 0;
    this.shouldFail = false;
  }
}

class RecordingSecurityAuditPublisher {
  readonly events: SecurityAuditEvent[] = [];

  async publish(event: SecurityAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async close(): Promise<void> {}

  reset(): void {
    this.events.length = 0;
  }
}

class RecordingPasswordResetMailer implements PasswordResetMailer {
  readonly messages: Array<{ email: string; rawToken: string }> = [];
  shouldFail = false;

  async sendPasswordResetEmail(email: string, rawToken: string): Promise<void> {
    if (this.shouldFail) throw new Error("simulated reset SMTP failure with sensitive detail");
    this.messages.push({ email, rawToken });
  }
}

let postgres: StartedNativeTestService;
let redis: StartedNativeTestService;
let mailpit: StartedNativeTestService;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let applicationDatabase: ReturnType<typeof createDatabase<DB>>;
let rateLimiter: RedisRateLimiter;
let mailer: RecordingMailer;
let authService: AuthService;
let securityAuditPublisher: RecordingSecurityAuditPublisher;
let securityRedis: RedisClientType;
let httpApplication: NestFastifyApplication;
let signupApprovalIssuerId: string;

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function withSafetyDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function waitForApplicationLockWait(queryFragment: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await sql<{ waiting: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE usename = 'classhub_app'
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${queryFragment}%`}
      ) AS waiting
    `.execute(bootstrapDatabase);
    if (result.rows[0]?.waiting === true) return;
    await delay(20);
  }
  throw new Error(`Application query did not reach the expected lock wait: ${queryFragment}`);
}

async function applyMigrations(): Promise<void> {
  const migratorDatabase = createDatabase<DB>(
    postgresUrl("classhub_migrator", "local_migrator_password"),
  );

  try {
    await sql
      .raw(
        `
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )
    `,
      )
      .execute(migratorDatabase);

    for (const migrationPath of await loadAllTestMigrationPaths()) {
      const migration = await readFile(migrationPath, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migratorDatabase
        .transaction()
        .execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migratorDatabase.destroy();
  }
}

function createCommand(
  email: string,
  role: "student" | "teacher" = "student",
): Promise<SignUpCommand> {
  return Promise.resolve({ ...baseCommand, email, role });
}

function createUnthrottledAuthService(): AuthService {
  const unthrottled = async () => ({
    allowed: true,
    count: 1,
    limit: 100,
    remaining: 99,
    retryAfterSeconds: 0,
  });
  return new AuthService(
    applicationDatabase,
    // 인증 메일은 consumeAll로 여러 한도를 한꺼번에 예약한다(7f30eff).
    { consume: unthrottled, consumeAll: unthrottled } as never,
    mailer,
    authConfig,
    securityAuditPublisher,
  );
}

async function createGuardianCommand(
  email: string,
  reference: { completion_token: string; request_id: string },
): Promise<SignUpCommand> {
  const command = await createCommand(email);
  return {
    ...command,
    age_route: "guardian_consent",
    consents: { privacy: true, terms: true },
    display_name: "보호자 동의 학생",
    email,
    guardian_consent: {
      completion_token: reference.completion_token,
      request_id: reference.request_id,
    },
  };
}

async function getSignUpArtifactCounts(email: string): Promise<{
  consents: string;
  tokens: string;
  users: string;
}> {
  const [users, consents, tokens] = await Promise.all([
    bootstrapDatabase
      .selectFrom("users")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("email_normalized", "=", email)
      .executeTakeFirstOrThrow(),
    bootstrapDatabase
      .selectFrom("user_consents")
      .innerJoin("users", "users.id", "user_consents.user_id")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("users.email_normalized", "=", email)
      .executeTakeFirstOrThrow(),
    bootstrapDatabase
      .selectFrom("email_verification_tokens")
      .innerJoin("users", "users.id", "email_verification_tokens.user_id")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("users.email_normalized", "=", email)
      .executeTakeFirstOrThrow(),
  ]);

  return { consents: consents.count, tokens: tokens.count, users: users.count };
}

async function getUserId(email: string): Promise<string> {
  const user = await bootstrapDatabase
    .selectFrom("users")
    .select("id")
    .where("email_normalized", "=", email)
    .executeTakeFirstOrThrow();

  return user.id;
}

async function issueLegacyEmailVerificationToken(userId: string): Promise<string> {
  // Explicitly seed an approved legacy account; new registration never grants this state.
  await bootstrapDatabase
    .updateTable("users")
    .set({ signup_approved_at: new Date() })
    .where("id", "=", userId)
    .execute();
  const rawToken = randomBytes(32).toString("base64url");
  await bootstrapDatabase
    .insertInto("email_verification_tokens")
    .values({
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      token_hash: hashVerificationToken(rawToken),
      user_id: userId,
    })
    .execute();
  return rawToken;
}

async function createTestUser(email: string, verified = true): Promise<string> {
  const user = await bootstrapDatabase
    .insertInto("users")
    .values({
      display_name: "테스트 학생",
      email_normalized: email,
      email_verified_at: verified ? new Date() : null,
      password_hash: await hashPassword(baseCommand.password),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return user.id;
}

async function databaseToday(): Promise<string> {
  const row = await bootstrapDatabase
    .selectNoFrom(
      sql<string>`to_char(
        (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,
        'YYYY-MM-DD'
      )`.as("server_today"),
    )
    .executeTakeFirstOrThrow();
  return row.server_today;
}

async function createActiveClassFixture(): Promise<{
  classId: string;
  inviteCode: string;
  operatorId: string;
  teacherId: string;
  teacherMemberId: string;
}> {
  const operator = await bootstrapDatabase
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update("membership-fixture-operator").digest(),
      email_normalized: "membership-fixture-operator@classhub.local",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const teacherId = await createTestUser("membership-teacher@example.com");
  await bootstrapDatabase
    .insertInto("teacher_profiles")
    .values({
      created_by_operator_id: operator.id,
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
      user_id: teacherId,
    })
    .execute();
  await bootstrapDatabase
    .insertInto("schools")
    .values({
      edu_office_code: "B10",
      edu_office_name: "테스트 교육청",
      homepage_url: "https://school.example.com/",
      phone_number: "02-1234-5678",
      region_name: "서울",
      road_address: "서울특별시 테스트구 학교로 1",
      road_address_detail: "(테스트동)",
      school_code: "1234567",
      school_kind: "middle",
      school_name: "테스트 중학교",
    })
    .execute();

  const inviteCode = "ABCDEFGH";
  return bootstrapDatabase.transaction().execute(async (transaction) => {
    const targetClass = await transaction
      .insertInto("classes")
      .values({
        academic_year: 2026,
        created_by_user_id: teacherId,
        edu_office_code: "B10",
        expected_student_count: 30,
        grade: 1,
        name: "1반",
        school_code: "1234567",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const teacherMember = await transaction
      .insertInto("class_members")
      .values({
        class_id: targetClass.id,
        role: "teacher",
        status: "approved",
        user_id: teacherId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("class_member_status_history")
      .values({
        actor_member_id: teacherMember.id,
        actor_operator_id: null,
        actor_user_id: teacherId,
        class_id: targetClass.id,
        from_status: null,
        member_id: teacherMember.id,
        reason: null,
        to_status: "approved",
      })
      .execute();
    await transaction
      .insertInto("class_invite_codes")
      .values({
        class_id: targetClass.id,
        code: inviteCode,
        created_by_member_id: teacherMember.id,
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000),
      })
      .execute();

    return {
      classId: targetClass.id,
      inviteCode,
      operatorId: operator.id,
      teacherId,
      teacherMemberId: teacherMember.id,
    };
  });
}

async function createTeacherWithoutClass(email: string, operatorId: string): Promise<string> {
  const userId = await createTestUser(email);
  await bootstrapDatabase
    .insertInto("teacher_profiles")
    .values({
      created_by_operator_id: operatorId,
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
      user_id: userId,
    })
    .execute();
  return userId;
}

async function insertStudentMembership(
  fixture: { classId: string; teacherId: string; teacherMemberId: string },
  userId: string,
  status: "canceled" | "pending" | "removed",
): Promise<string> {
  const member = await bootstrapDatabase
    .insertInto("class_members")
    .values({ class_id: fixture.classId, role: "student", status, user_id: userId })
    .returning("id")
    .executeTakeFirstOrThrow();
  await bootstrapDatabase
    .insertInto("class_member_status_history")
    .values({
      actor_member_id: null,
      actor_operator_id: null,
      actor_user_id: userId,
      class_id: fixture.classId,
      from_status: null,
      member_id: member.id,
      reason: null,
      to_status: "pending",
    })
    .execute();
  if (status !== "pending") {
    await bootstrapDatabase
      .insertInto("class_member_status_history")
      .values({
        actor_member_id: status === "removed" ? fixture.teacherMemberId : null,
        actor_operator_id: null,
        actor_user_id: status === "removed" ? fixture.teacherId : userId,
        class_id: fixture.classId,
        from_status: "pending",
        member_id: member.id,
        reason: status === "removed" ? "테스트 퇴출" : null,
        to_status: status,
      })
      .execute();
  }
  return member.id;
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
interface ArchiveHttpFixture {
  classId: string;
  className: string;
  cookie: string;
  csrf: string;
  inviteCode: string;
  teacherEmail: string;
  teacherId: string;
  teacherMemberId: string;
}

let archiveClassSequence = 0;

async function createArchiveHttpFixture(
  label: string,
  operatorId: string,
): Promise<ArchiveHttpFixture> {
  archiveClassSequence += 1;
  const teacherEmail = `archive-${label}-${archiveClassSequence}@example.com`;
  const teacherId = await createTeacherWithoutClass(teacherEmail, operatorId);
  const login = await httpApplication.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost:5173" },
    payload: { email: teacherEmail, password: baseCommand.password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const cookies = responseCookies(login.headers);
  const session = rawCookie(cookies, SESSION_COOKIE_NAME);
  const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
  const cookie = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`;
  const className = `아카이브 ${label} ${archiveClassSequence}반`;
  const created = await httpApplication.inject({
    method: "POST",
    url: "/api/v1/classes",
    headers: {
      cookie,
      "idempotency-key": randomUUID(),
      origin: "http://localhost:5173",
      "x-csrf-token": csrf,
    },
    payload: {
      academic_year: 2035,
      edu_office_code: "B10",
      expected_student_count: 30,
      grade: 1,
      name: className,
      school_code: "1234567",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  return {
    classId: created.json().class.id as string,
    className,
    cookie,
    csrf,
    inviteCode: created.json().invite_code.code as string,
    teacherEmail,
    teacherId,
    teacherMemberId: created.json().teacher_membership_id as string,
  };
}

async function waitForMailpitMessage(recipient: string): Promise<string> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const response = await fetch(
      `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}/api/v1/messages`,
      { signal: AbortSignal.timeout(1_000) },
    );
    const messages = await response.text();

    if (response.ok && messages.includes(recipient)) {
      return messages;
    }

    await delay(50);
  }

  throw new Error("Mailpit did not persist the expected message within 5 seconds.");
}

async function expectSignupMailWithoutVerification(recipient: string): Promise<void> {
  const message = await waitForMailpitMessageBody(recipient);
  expect(message).toMatch(/[0-9]{6}/u);
  expect(message).toContain("/login");
  expect(message).not.toContain("/verify-email#token=");
  expect(message).not.toContain(baseCommand.password);
}

async function testPolicyKeys(): Promise<string[]> {
  // This client belongs to this file's dynamic-port native fixture, never the live Redis.
  expect(redis.getMappedPort(6379)).not.toBe(6379);
  return (
    await Promise.all([
      securityRedis.keys("*:policy:*"),
      securityRedis.keys("auth-mail:v1:*:fixed:*"),
    ])
  ).flat();
}

// 같은 주소의 인증 메일은 60초에 한 번(AUTH_MAIL_LIMITS.cooldownSeconds). 기다리는 대신 대기 키만 지운다.
async function elapseAuthMailCooldowns(): Promise<void> {
  // This client belongs to this file's dynamic-port native fixture, never the live Redis.
  expect(redis.getMappedPort(6379)).not.toBe(6379);
  const keys = await securityRedis.keys("auth-mail:v1:cooldown:*");
  if (keys.length > 0) await securityRedis.del(keys);
}

async function waitForMailpitResetToken(recipient: string): Promise<string> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const response = await fetch(
      `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}/api/v1/messages`,
      { signal: AbortSignal.timeout(1_000) },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        messages?: Array<{ ID?: string; To?: Array<{ Address?: string }> }>;
      };
      const summary = body.messages?.find((message) =>
        message.To?.some((recipientEntry) => recipientEntry.Address === recipient),
      );
      if (summary?.ID !== undefined) {
        const messageResponse = await fetch(
          `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}/api/v1/message/${summary.ID}`,
          { signal: AbortSignal.timeout(1_000) },
        );
        const message = await messageResponse.text();
        const token = message.match(/reset-password#token=([A-Za-z0-9_-]{43})/u)?.[1];
        if (messageResponse.ok && token !== undefined) return token;
      }
    }
    await delay(50);
  }

  throw new Error("Mailpit did not persist the expected password reset token within 5 seconds.");
}

async function waitForMailpitMessageBody(recipient: string): Promise<string> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const response = await fetch(
      `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}/api/v1/messages`,
      { signal: AbortSignal.timeout(1_000) },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        messages?: Array<{ ID?: string; To?: Array<{ Address?: string }> }>;
      };
      const summary = body.messages?.find((message) =>
        message.To?.some((recipientEntry) => recipientEntry.Address === recipient),
      );
      if (summary?.ID !== undefined) {
        const messageResponse = await fetch(
          `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}/api/v1/message/${summary.ID}`,
          { signal: AbortSignal.timeout(1_000) },
        );
        if (messageResponse.ok) return messageResponse.text();
      }
    }
    await delay(50);
  }

  throw new Error(
    "Mailpit did not persist the expected guardian consent message within 5 seconds.",
  );
}

async function securityEventsForRequest(requestId: string): Promise<SecurityAuditEvent[]> {
  const entries = await securityRedis.xRange(SECURITY_AUDIT_STREAM, "-", "+");
  return entries
    .map((entry) => entry.message[SECURITY_AUDIT_EVENT_FIELD])
    .filter((serialized): serialized is string => serialized !== undefined)
    .map((serialized) => parseSecurityAuditEvent(serialized))
    .filter((event) => event.request_id === requestId);
}

async function waitForSecurityEventsForRequest(
  requestId: string,
  minimumCount = 1,
): Promise<SecurityAuditEvent[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = await securityEventsForRequest(requestId);
    if (events.length >= minimumCount) {
      await delay(50);
      return securityEventsForRequest(requestId);
    }
    await delay(20);
  }

  throw new Error(
    `Security audit stream did not contain ${minimumCount} event(s) for request ${requestId}.`,
  );
}

async function waitForSecurityEventsForRequests(
  requestIds: readonly string[],
  minimumCount = 1,
): Promise<SecurityAuditEvent[]> {
  const requestIdSet = new Set(requestIds);
  const read = async () => {
    const entries = await securityRedis.xRange(SECURITY_AUDIT_STREAM, "-", "+");
    return entries
      .map((entry) => entry.message[SECURITY_AUDIT_EVENT_FIELD])
      .filter((serialized): serialized is string => serialized !== undefined)
      .map((serialized) => parseSecurityAuditEvent(serialized))
      .filter((event) => requestIdSet.has(event.request_id));
  };
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = await read();
    if (events.length >= minimumCount) {
      await delay(50);
      return read();
    }
    await delay(20);
  }
  throw new Error(`Security audit stream did not contain ${minimumCount} aggregate event(s).`);
}

async function expectNoSecurityEventsForRequest(requestId: string): Promise<void> {
  await delay(1_100);
  await expect(securityEventsForRequest(requestId)).resolves.toEqual([]);
}

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([
    startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    }),
    startNativeTestService("redis"),
    startNativeTestService("mailpit", { MP_SMTP_DISABLE_RDNS: "true" }),
  ]);

  bootstrapDatabase = createDatabase<DB>(
    postgresUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();

  const signupApprovalOperator = await bootstrapDatabase
    .insertInto("operators")
    .values({
      credential_hash: Buffer.alloc(32, 31),
      email_normalized: "signup-approval-fixture-operator@classhub.local",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const signupApprovalIssuer = await bootstrapDatabase
    .insertInto("admin_accounts")
    .values({
      created_by_admin_account_id: null,
      created_by_operator_id: signupApprovalOperator.id,
      display_name: "가입 승인 테스트 관리자",
      email_normalized: "signup-approval-fixture-admin@classhub.local",
      password_hash: "integration-only-not-a-login-credential",
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  signupApprovalIssuerId = signupApprovalIssuer.id;

  applicationDatabase = createDatabase<DB>(postgresUrl("classhub_app", "local_app_password"));
  rateLimiter = createRedisRateLimiter(
    `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`,
  );
  securityRedis = createClient({
    url: `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`,
  });
  securityRedis.on("error", () => undefined);
  await securityRedis.connect();
  mailer = new RecordingMailer();
  securityAuditPublisher = new RecordingSecurityAuditPublisher();
  authService = new AuthService(
    applicationDatabase,
    rateLimiter,
    mailer,
    authConfig,
    securityAuditPublisher,
  );
  const localAdminPasswordHash = await hashPassword(localAdminTestPassword);

  Object.assign(process.env, {
    AGE_POLICY_VERSION: authConfig.agePolicyVersion,
    ATTENDANCE_NOTIFICATIONS_ENABLED: "true",
    DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
    EMAIL_HMAC_KEY: authConfig.emailHmacKey,
    EMAIL_HMAC_KEY_VERSION: authConfig.emailHmacKeyVersion,
    LOCAL_TEST_ADMIN_ENABLED: "true",
    LOCAL_TEST_ADMIN_DATABASE_URL: postgresUrl("classhub_local_admin", "local_admin_db_password"),
    LOCAL_TEST_ADMIN_OPERATOR_EMAIL: "admin@classhub.local",
    LOCAL_TEST_ADMIN_PASSWORD_HASH: localAdminPasswordHash,
    LOCAL_TEST_ADMIN_USERNAME: "admin",
    NODE_ENV: "development",
    PASSWORD_RESET_ENABLED: "true",
    POLLS_ENABLED: "false",
    SEAT_DRAWS_ENABLED: "false",
    PRIVACY_POLICY_VERSION: authConfig.privacyPolicyVersion,
    PUBLIC_API_ORIGIN: "http://localhost:5173",
    PUBLIC_APP_ORIGIN: "http://localhost:5173",
    REDIS_URL: `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`,
    SMTP_FROM: "no-reply@classhub.local",
    SMTP_HOST: reachableHost(mailpit),
    SMTP_PORT: String(mailpit.getMappedPort(1025)),
    SMTP_SECURE: "false",
    TERMS_POLICY_VERSION: authConfig.termsPolicyVersion,
  });
  const { createApplication } = await import("../src/app.factory.js");
  const { loadEnvironment } = await import("../src/config/environment.js");
  ({ app: httpApplication } = await createApplication({
    environment: loadEnvironment({
      ...process.env,
      // 보호자 동의 흐름을 시험하므로 만 14세 미만 가입을 연다(기본은 닫힘, P-025②).
      UNDER_14_SIGNUP_ENABLED: "true",
      LOG_LEVEL: "fatal",
      SMTP_USERNAME: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_REQUIRE_TLS: "false",
    }),
  }));
}, 120_000);

beforeEach(async () => {
  // Keep audits and domain fixtures; only request budgets must be independent between tests.
  const keys = await testPolicyKeys();
  if (keys.length > 0) await securityRedis.del(keys);
});

afterAll(async () => {
  try {
    await httpApplication?.close();
    await Promise.allSettled([
      rateLimiter?.close(),
      securityRedis?.isOpen ? Promise.resolve(securityRedis.destroy()) : Promise.resolve(),
      applicationDatabase?.destroy(),
      bootstrapDatabase?.destroy(),
    ]);
    await Promise.allSettled([postgres?.stop(), redis?.stop(), mailpit?.stop()]);
  } finally {
    for (const [key, value] of originalFeatureEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 120_000);

describe("authentication mail admission HTTP", () => {
  const headers = { origin: "http://localhost:5173" }; // Injection only; no listener on this port.
  const recipientKey = (email: string, window: "hour" | "day") => {
    const digest = createPrivacySafeSubject(
      authConfig.emailHmacKey,
      authConfig.emailHmacKeyVersion,
      "auth_mail_recipient",
      email,
    );
    return `auth-mail:v1:recipient:${digest}:${window}:fixed:${window === "hour" ? "10:3600" : "30:86400"}`;
  };
  const request = (
    kind: "password-reset" | "account-recovery" | "guardian-consent",
    email: string,
    remoteAddress: string,
  ) =>
    httpApplication.inject({
      method: "POST",
      url: `/api/v1/auth/${kind}-requests`,
      headers,
      remoteAddress,
      payload: kind === "guardian-consent" ? { guardian_email: email } : { email },
    });

  it("shares the recipient budget across three real SMTP paths and rejects a duplicate without replacing its reset token", async () => {
    const email = "mail-shared-paths@example.com";
    const userId = await createTestUser(email);
    for (const [index, kind] of (
      ["password-reset", "account-recovery", "guardian-consent"] as const
    ).entries()) {
      const response = await request(kind, email, `192.0.2.${10 + index}`);
      expect(response.statusCode, response.body).toBe(202);
      // The existing helper inspects the latest message for this recipient.
      if (kind === "password-reset") {
        await expect(waitForMailpitResetToken(email)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/u);
      }
    }
    expect(await securityRedis.get(recipientKey(email, "hour"))).toBe("3");
    const original = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .selectAll()
      .where("user_id", "=", userId)
      .execute();
    const duplicate = await request("password-reset", email, "192.0.2.20");
    expect(duplicate.statusCode).toBe(429);
    expect(duplicate.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(
      await bootstrapDatabase
        .selectFrom("password_reset_tokens")
        .selectAll()
        .where("user_id", "=", userId)
        .execute(),
    ).toEqual(original);
    expect(await securityRedis.get(recipientKey(email, "hour"))).toBe("3");
    const deliveries = await bootstrapDatabase
      .selectFrom("mail_delivery_logs")
      .select("status")
      .where("recipient_email", "=", email)
      .execute();
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((row) => row.status === "accepted")).toBe(true);
  });

  it.each(["hour", "day"] as const)(
    "enforces the recipient %s ceiling across request paths",
    async (window) => {
      const email = `mail-recipient-${window}@example.com`;
      const userId = await createTestUser(email);
      await securityRedis.set(recipientKey(email, window), window === "hour" ? "10" : "30", {
        EX: 600,
      });
      for (const [index, kind] of (
        ["password-reset", "account-recovery", "guardian-consent"] as const
      ).entries()) {
        const response = await request(kind, email, `192.0.2.${30 + index}`);
        expect(response.statusCode, response.body).toBe(429);
        expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
      }
      expect(
        await bootstrapDatabase
          .selectFrom("password_reset_tokens")
          .select("id")
          .where("user_id", "=", userId)
          .execute(),
      ).toEqual([]);
      expect(
        await bootstrapDatabase
          .selectFrom("mail_delivery_logs")
          .select("id")
          .where("recipient_email", "=", email)
          .execute(),
      ).toEqual([]);
      expect(await securityRedis.keys("auth-mail:v1:service:*")).toEqual([]);
    },
  );

  it.each(["hour", "day"] as const)(
    "enforces the service %s ceiling without spending a new recipient budget",
    async (window) => {
      const key = `auth-mail:v1:service:${window}:fixed:${window === "hour" ? "3000:3600" : "10000:86400"}`;
      await securityRedis.set(key, window === "hour" ? "3000" : "10000", { EX: 600 });
      for (const [index, kind] of (
        ["password-reset", "account-recovery", "guardian-consent"] as const
      ).entries()) {
        const email = `mail-service-${window}-${index}@example.com`;
        const response = await request(kind, email, `192.0.2.${40 + index}`);
        expect(response.statusCode, response.body).toBe(429);
        expect(await securityRedis.exists(recipientKey(email, "hour"))).toBe(0);
      }
    },
  );

  it("keeps a pending signup usable when the recipient mail ceiling is reached", async () => {
    const email = "mail-signup-full@example.com";
    await securityRedis.set(recipientKey(email, "hour"), "10", { EX: 600 });
    const response = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers,
      payload: await createCommand(email),
      remoteAddress: "192.0.2.50",
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
    const account = await bootstrapDatabase
      .selectFrom("users")
      .select(["id", "is_active", "signup_approved_at"])
      .where("email_normalized", "=", email)
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({ is_active: true, signup_approved_at: null });
    expect(
      await bootstrapDatabase
        .selectFrom("mail_delivery_logs")
        .select("id")
        .where("recipient_email", "=", email)
        .execute(),
    ).toEqual([]);
  });

  it("uses the same signup cooldown for the initial mail and authenticated resend", async () => {
    const email = "mail-signup-resend@example.com";
    const signup = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers,
      payload: await createCommand(email),
      remoteAddress: "192.0.2.60",
    });
    expect(signup.statusCode, signup.body).toBe(202);
    expect(signup.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers,
      payload: { email, password: baseCommand.password },
      remoteAddress: "192.0.2.61",
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookies = responseCookies(login.headers);
    const session = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
    const before = await bootstrapDatabase
      .selectFrom("admin_signup_approvals")
      .select(["id", "code_digest", "revoked_at"])
      .where("recipient_email", "=", email)
      .execute();
    const resend = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/signup-approval/resend",
      remoteAddress: "192.0.2.62",
      headers: {
        ...headers,
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
        "x-csrf-token": csrf,
      },
    });
    expect(resend.statusCode, resend.body).toBe(429);
    expect(
      await bootstrapDatabase
        .selectFrom("admin_signup_approvals")
        .select(["id", "code_digest", "revoked_at"])
        .where("recipient_email", "=", email)
        .execute(),
    ).toEqual(before);
    expect(await securityRedis.get(recipientKey(email, "hour"))).toBe("1");
  });
});

describe("anonymous account response privacy", () => {
  const headers = { origin: "http://localhost:5173" }; // Injection only; no listener.
  const accepted = { next_action: "LOGIN", request_accepted: true };
  const signup = (payload: SignUpCommand, address = "192.0.2.100") =>
    httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers,
      payload,
      remoteAddress: address,
    });
  const recipientKey = (email: string) =>
    "auth-mail:v1:recipient:" +
    createPrivacySafeSubject(
      authConfig.emailHmacKey,
      authConfig.emailHmacKeyVersion,
      "auth_mail_recipient",
      email,
    ) +
    ":hour:fixed:10:3600";

  it.each(["student", "teacher"] as const)(
    "uses one public contract for new and existing %s requests without changing the existing account",
    async (role) => {
      const existing = "privacy-existing-" + role + "@example.invalid";
      const fresh = "privacy-fresh-" + role + "@example.invalid";
      const id = await createTestUser(existing);
      const snapshot = () =>
        bootstrapDatabase
          .selectFrom("users")
          .select([
            "password_hash",
            "signup_role",
            "email_verified_at",
            "is_active",
            "display_name",
          ])
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
      const before = await snapshot();
      for (const email of [existing, fresh]) {
        const response = await signup({
          ...(await createCommand(email, role)),
          password: "Different8275",
          display_name: "새 이름",
        });
        expect(response.statusCode, response.body).toBe(202);
        expect(response.json()).toEqual(accepted);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await securityRedis.get(recipientKey(email))).toBe("1");
      }
      expect(await snapshot()).toEqual(before);
      expect(
        await bootstrapDatabase
          .selectFrom("admin_signup_approvals")
          .select("id")
          .where("recipient_email", "=", existing)
          .execute(),
      ).toEqual([]);
      expect(
        await bootstrapDatabase
          .selectFrom("admin_signup_approvals")
          .select("id")
          .where("recipient_email", "=", fresh)
          .execute(),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "closes a presented guardian proof after acceptance with existing=%s",
    async (existing) => {
      const email = "privacy-guardian-" + existing + "@example.invalid";
      if (existing) await createTestUser(email);
      const proof = await authService.requestGuardianConsent(
        "guardian-privacy-" + existing + "@example.invalid",
        "192.0.2.111",
      );
      await authService.confirmGuardianConsent(mailer.guardianMessages.at(-1)!.rawToken);
      const command = await createGuardianCommand(email, proof);
      const response = await signup(command);
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toEqual(accepted);
      const status = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/guardian-consent-requests/status",
        headers,
        payload: { request_id: proof.request_id, completion_token: proof.completion_token },
      });
      expect(status.statusCode).toBe(400);
      expect(status.json()).toMatchObject({ error: { code: "TOKEN_INVALID_OR_EXPIRED" } });
      const replay = await signup({ ...command, email: "replayed-" + email }, "192.0.2.112");
      expect(replay.statusCode).toBe(400);
      const row = await bootstrapDatabase
        .selectFrom("guardian_consent_requests")
        .select(["completion_token_hash", "consumed_at", "invalidated_at", "user_id"])
        .where("id", "=", proof.request_id)
        .executeTakeFirstOrThrow();
      expect(row.completion_token_hash).toBeNull();
      if (existing)
        expect(row).toMatchObject({
          consumed_at: null,
          user_id: null,
          invalidated_at: expect.any(Date),
        });
      else
        expect(row).toMatchObject({
          consumed_at: expect.any(Date),
          invalidated_at: null,
          user_id: expect.any(String),
        });
    },
  );

  it("serializes simultaneous duplicate guardian attempts so only one can use the proof", async () => {
    const email = "privacy-guardian-concurrent@example.invalid";
    await createTestUser(email);
    const proof = await authService.requestGuardianConsent(
      "guardian-privacy-concurrent@example.invalid",
      "192.0.2.113",
    );
    await authService.confirmGuardianConsent(mailer.guardianMessages.at(-1)!.rawToken);
    const command = await createGuardianCommand(email, proof);
    const responses = await Promise.all([
      signup(command, "192.0.2.114"),
      signup(command, "192.0.2.115"),
    ]);
    expect(responses.map((row) => row.statusCode).sort()).toEqual([202, 400]);
  });

  it.each(["account-recovery-requests", "password-reset-requests"])(
    "keeps known and absent %s responses identical with the short-path timing floor",
    async (route) => {
      const known = "privacy-known-" + route + "@example.invalid";
      await createTestUser(known);
      const durations: number[] = [];
      for (const email of [known, "privacy-absent-" + route + "@example.invalid"]) {
        const started = performance.now();
        const response = await httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/" + route,
          headers,
          payload: { email },
          remoteAddress: "192.0.2.116",
        });
        durations.push(performance.now() - started);
        expect(response.statusCode, response.body).toBe(202);
        expect(response.json()).toEqual({ request_accepted: true });
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(durations.every((value) => value >= 490)).toBe(true);
      console.info(
        JSON.stringify({
          probe: "account-response-floor",
          route,
          durationsMs: durations.map(Math.round),
        }),
      );
    },
  );

  it("does not disguise storage failure as a successful signup", async () => {
    const spy = vi
      .spyOn(AuthService.prototype, "signUp")
      .mockRejectedValueOnce(new Error("synthetic storage failure"));
    try {
      const response = await signup(await createCommand("privacy-storage-failure@example.invalid"));
      expect(response.statusCode).toBe(500);
      expect(response.json()).not.toHaveProperty("request_accepted");
      expect(response.body).not.toContain("synthetic storage failure");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("account request admission HTTP", () => {
  const routes = [
    ["/api/v1/auth/sign-up", { email: "invalid-admission-email" }],
    ["/api/v1/auth/account-recovery-requests", { email: "invalid-admission-email" }],
    ["/api/v1/auth/password-reset-requests", { email: "invalid-admission-email" }],
    ["/api/v1/auth/password-resets/confirm", { token: "invalid-admission-token" }],
  ] as const;
  const headers = { origin: "http://localhost:5173" }; // Injected harness; no port is bound.

  it.each(routes)(
    "limits malformed requests before validation or business work at %s",
    async (url, payload) => {
      const business = [
        vi.spyOn(AuthService.prototype, "signUp"),
        vi.spyOn(AccountRecoveryService.prototype, "requestAccount"),
        vi.spyOn(PasswordResetService.prototype, "requestReset"),
        vi.spyOn(PasswordResetService.prototype, "confirmReset"),
      ];
      try {
        for (let attempt = 0; attempt < 11; attempt++) {
          const response = await httpApplication.inject({
            method: "POST",
            url,
            headers,
            payload,
            remoteAddress: "127.13.0.1",
          });
          expect(response.statusCode, response.body).toBe(attempt < 10 ? 400 : 429);
          expect(response.headers["set-cookie"]).toBeUndefined();
          if (attempt === 10) {
            expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
            expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
          }
        }
        for (const call of business) expect(call).not.toHaveBeenCalled();
      } finally {
        for (const call of business) call.mockRestore();
      }
    },
  );

  it("validates Origin before consuming any of the four endpoint budgets", async () => {
    for (const [url, payload] of routes) {
      const response = await httpApplication.inject({
        method: "POST",
        url,
        payload,
        remoteAddress: "127.13.0.2",
        headers: { origin: "https://rejected-origin.example.invalid" },
      });
      expect(response.statusCode).toBe(403);
    }
    await expect(testPolicyKeys()).resolves.toEqual([]);
  });

  it("shares normalized email capacity across three endpoints while preserving another network", async () => {
    for (let attempt = 0; attempt < 11; attempt++) {
      const [url] = routes[attempt % 3]!;
      const response = await httpApplication.inject({
        method: "POST",
        url,
        headers,
        remoteAddress: "127.13.0.3",
        payload: { email: attempt % 2 ? " INVALID-ADMISSION-EMAIL " : "invalid-admission-email" },
      });
      expect(response.statusCode, response.body).toBe(attempt < 10 ? 400 : 429);
    }
    const outsider = await httpApplication.inject({
      method: "POST",
      url: routes[2][0],
      headers,
      remoteAddress: "127.13.0.4",
      payload: { email: "invalid-admission-email" },
    });
    expect(outsider.statusCode).toBe(400);
  });

  it("preserves service capacity after 600 blocked network requests using real Redis", async () => {
    const remoteAddress = "127.13.0.5";
    const opaque = createPrivacySafeSubject(
      authConfig.emailHmacKey,
      authConfig.emailHmacKeyVersion,
      "account_admission_account-request_network",
      remoteAddress,
    );
    await securityRedis.set(
      `auth-admission:account-request:network:${opaque}:policy:300:60`,
      "300",
      { EX: 60 },
    );
    for (let batch = 0; batch < 30; batch++) {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          httpApplication.inject({
            method: "POST",
            url: routes[2][0],
            headers,
            remoteAddress,
            payload: { email: "blocked-admission@example.invalid" },
          }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 429)).toBe(true);
    }
    await expect(
      securityRedis.get("auth-admission:account-request:service:v1:policy:600:60"),
    ).resolves.toBeNull();
    const outsider = await httpApplication.inject({
      method: "POST",
      url: routes[2][0],
      headers,
      remoteAddress: "127.13.0.6",
      payload: { email: "missing-admission@example.invalid" },
    });
    expect(outsider.statusCode, outsider.body).toBe(202);
    await expect(
      securityRedis.get("auth-admission:account-request:service:v1:policy:600:60"),
    ).resolves.toBe("1");
  }, 30_000);

  it("rejects a full global budget before the password-reset service is called", async () => {
    await securityRedis.set("auth-admission:account-request:service:v1:policy:600:60", "600", {
      EX: 60,
    });
    const business = vi.spyOn(PasswordResetService.prototype, "requestReset");
    try {
      const response = await httpApplication.inject({
        method: "POST",
        url: routes[2][0],
        headers,
        remoteAddress: "127.13.0.7",
        payload: { email: "missing-admission@example.invalid" },
      });
      expect(response.statusCode, response.body).toBe(429);
      expect(business).not.toHaveBeenCalled();
    } finally {
      business.mockRestore();
    }
  });
});

describe("signup approval and legacy email verification integration", () => {
  it.each(["student", "teacher"] as const)(
    "rejects common short passwords before HTTP %s signup creates any account artifacts",
    async (role) => {
      for (const [index, password] of ["abc123", "password1"].entries()) {
        const email = `blocked-password-${role}-${index}@example.invalid`;
        const response = await httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/sign-up",
          headers: { origin: "http://localhost:5173" }, // Injected harness; no port is bound.
          payload: { ...(await createCommand(email, role)), password },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { code: "VALIDATION_FAILED", message: expect.stringContaining("흔하거나") },
        });
        expect(response.body).not.toContain(password);
        await expect(getSignUpArtifactCounts(email)).resolves.toEqual({
          consents: "0",
          tokens: "0",
          users: "0",
        });
      }
    },
  );

  it("keeps HTTP login available for an existing password newly added to the blocklist", async () => {
    const email = "legacy-common-password@example.invalid";
    const userId = await createTestUser(email);
    const existingHash = await hashPassword("abc123");
    await bootstrapDatabase
      .updateTable("users")
      .set({ password_hash: existingHash, signup_approved_at: new Date() })
      .where("id", "=", userId)
      .execute();
    const response = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" }, // Injected harness; no port is bound.
      payload: { email, password: "abc123" },
    });
    expect(response.statusCode).toBe(200);
    expect(rawCookie(responseCookies(response.headers), SESSION_COOKIE_NAME)).toBeTruthy();
    const account = await bootstrapDatabase
      .selectFrom("users")
      .select(["password_hash", "failed_login_attempts"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(account.password_hash).toBe(existingHash);
    expect(account.failed_login_attempts).toBe(0);
  });

  it.each(["legacy_exact_v0", "nfc_v1"])(
    "upgrades old login hash parameters while preserving %s input semantics",
    async (version) => {
      const email = `hash-upgrade-${version}@example.invalid`;
      const userId = await createTestUser(email);
      const password = "legacy-e\u0301-credential123";
      const verificationPassword = version === "nfc_v1" ? password.normalize("NFC") : password;
      const nonce = Buffer.alloc(16, 19);
      const tag = await new Promise<Buffer>((resolve, reject) =>
        argon2(
          "argon2id",
          {
            memory: 8192,
            passes: 1,
            parallelism: 1,
            nonce,
            message: verificationPassword,
            tagLength: 32,
          },
          (error, result) => (error === null ? resolve(result) : reject(error)),
        ),
      );
      const original = `$argon2id$v=19$m=8192,t=1,p=1$${nonce.toString("base64url")}$${tag.toString("base64url")}`;
      await bootstrapDatabase
        .updateTable("users")
        .set({ password_hash: original, password_input_version: version })
        .where("id", "=", userId)
        .execute();
      const request = (value: string) =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: "127.8.0.1",
          headers: { origin: "http://localhost:5173" },
          payload: { email, password: value },
        });
      expect((await request("wrong-password1")).statusCode).toBe(401);
      expect(
        (
          await bootstrapDatabase
            .selectFrom("users")
            .select("password_hash")
            .where("id", "=", userId)
            .executeTakeFirstOrThrow()
        ).password_hash,
      ).toBe(original);
      const result = await request(password);
      expect(result.statusCode, result.body).toBe(200);
      const updated = await bootstrapDatabase
        .selectFrom("users")
        .select(["password_hash", "password_input_version"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(updated.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
      expect(updated.password_input_version).toBe(version);
      await expect(verifyPassword(verificationPassword, updated.password_hash)).resolves.toBe(true);
    },
  );

  it.each(["student", "teacher"] as const)(
    "emails the same pending %s code for administrator fallback and post-login resend",
    async (role) => {
      const email = `pending-${role}@example.com`;
      const password = "Safe12";
      const origin = "http://localhost:5173"; // Existing isolated Fastify harness origin; no port is bound.
      const payload = {
        age_route: "over_14",
        consents: { privacy: true, terms: true },
        display_name: "가입 대기",
        email,
        password,
        role,
      };
      const short = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        headers: { origin },
        payload: { ...payload, password: "Safe1" },
      });
      expect(short.statusCode).toBe(400);
      const signup = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        headers: { origin },
        payload,
      });
      expect(signup.statusCode).toBe(202);
      expect(signup.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
      const userId = await getUserId(email);
      const pending = await bootstrapDatabase
        .selectFrom("users")
        .select(["signup_approved_at", "email_verified_at"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      expect(pending).toEqual({ signup_approved_at: null, email_verified_at: null });
      expect(
        await bootstrapDatabase
          .selectFrom("teacher_profiles")
          .select("id")
          .where("user_id", "=", userId)
          .executeTakeFirst(),
      ).toBeUndefined();

      const config = new ConfigService<AppEnvironment, true>({
        DATABASE_ENGINE: "postgres",
        EMAIL_HMAC_KEY: authConfig.emailHmacKey,
      });
      const found = await new AdminUsersService(applicationDatabase, config).list(email);
      expect(found.users).toHaveLength(1);
      expect(found.users[0]).toMatchObject({ id: userId, email, signup_approved: false });
      const approvalService = httpApplication.get(AdminSignupApprovalService);
      const issued = (await approvalService.listMailApprovals()).find(
        (approval) => approval.recipient_email === email,
      )!;
      expect(issued.code).toMatch(/^[0-9]{6}$/u);
      const mailOrigin = `http://${reachableHost(mailpit)}:${mailpit.getMappedPort(8025)}`;
      const inbox = (await (await fetch(`${mailOrigin}/api/v1/messages`)).json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
      };
      const delivered = inbox.messages.find((message) =>
        message.To.some((to) => to.Address === email),
      )!;
      const mail = await (await fetch(`${mailOrigin}/api/v1/message/${delivered.ID}`)).text();
      expect(mail).toContain(issued.code);

      const login = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = responseCookies(login.headers);
      const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
      const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
      const headers = { origin, cookie, "x-csrf-token": csrf };
      await elapseAuthMailCooldowns();
      const resend = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/resend",
        headers,
      });
      expect(resend.statusCode).toBe(200);
      expect(resend.json()).toMatchObject({ email_delivery_status: "sent" });
      expect(
        (await approvalService.listMailApprovals()).find((approval) => approval.id === issued.id)
          ?.code,
      ).toBe(issued.code);
      const state = await httpApplication.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: { cookie },
      });
      expect(state.json()).toMatchObject({
        destination: "SIGNUP_APPROVAL_REQUIRED",
        allowed_actions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
      });
      const deniedHome = await httpApplication.inject({
        method: "GET",
        url: "/api/v1/home",
        headers: { cookie },
      });
      expect(deniedHome.statusCode).toBe(403);
      const emailBypass = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/email-verifications/resend",
        headers,
      });
      expect(emailBypass.statusCode).toBe(400);
      const noCsrf = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/confirm",
        headers: { origin, cookie },
        payload: { approval_code: issued.code },
      });
      expect(noCsrf.statusCode).toBe(403);
      const wrong = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/confirm",
        headers,
        payload: { approval_code: issued.code === "000000" ? "111111" : "000000" },
      });
      expect(wrong.statusCode).toBe(400);
      expect(
        await bootstrapDatabase
          .selectFrom("admin_signup_approvals")
          .select("failed_attempts")
          .where("id", "=", issued.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ failed_attempts: 1 });
      const confirm = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/confirm",
        headers,
        payload: { approval_code: issued.code },
      });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json()).toEqual({
        signup_approved: role === "student",
        next_action: "BOOTSTRAP",
      });
      if (role === "teacher") {
        const waiting = await httpApplication.inject({
          method: "GET",
          url: "/api/v1/bootstrap",
          headers: { cookie },
        });
        expect(waiting.json()).toMatchObject({
          destination: "SIGNUP_APPROVAL_REQUIRED",
          account: { email_verified: true },
        });
        const denied = await httpApplication.inject({
          method: "GET",
          url: "/api/v1/home",
          headers: { cookie },
        });
        expect(denied.statusCode).toBe(403);
        const adminCode = await approvalService.issue(
          email,
          role,
          signupApprovalIssuerId,
          randomUUID(),
        );
        const approved = await httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/signup-approval/confirm",
          headers,
          payload: { approval_code: adminCode.code },
        });
        expect(approved.statusCode).toBe(200);
        expect(approved.json()).toEqual({ signup_approved: true, next_action: "BOOTSTRAP" });
      }
      const ready = await httpApplication.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: { cookie },
      });
      expect(ready.json().destination).toBe(
        role === "teacher" ? "CREATE_CLASS" : "ENTER_INVITE_CODE",
      );
      expect(ready.json().account.email_verified).toBe(true);
      const approval = await bootstrapDatabase
        .selectFrom("admin_signup_approvals")
        .select(["consumed_by_user_id", "consumed_at"])
        .where("id", "=", issued.id)
        .executeTakeFirstOrThrow();
      expect(approval.consumed_by_user_id).toBe(userId);
      expect(approval.consumed_at).toBeInstanceOf(Date);
      const audit = await bootstrapDatabase
        .selectFrom("admin_signup_approval_events")
        .select(["role", "result_code"])
        .where("approval_id", "=", issued.id)
        .where("user_actor_id", "=", userId)
        .where("action", "=", "signup")
        .execute();
      expect(audit).toEqual([{ role, result_code: "approved" }]);
      await httpApplication.inject({ method: "POST", url: "/api/v1/auth/logout", headers });
    },
  );

  it.each(["student", "teacher"] as const)(
    "rejects legacy pre-registration approval codes without account artifacts (%s)",
    async (role) => {
      const email = role + "-legacy-code@example.invalid";
      await expect(
        authService.signUp(
          { ...(await createCommand(email, role)), approval_code: "123456" },
          "127.10.1.1",
        ),
      ).rejects.toBeInstanceOf(SignupApprovalInvalidException);
      await expect(getSignUpArtifactCounts(email)).resolves.toEqual({
        users: "0",
        consents: "0",
        tokens: "0",
      });
    },
  );

  it("creates a pending account and its exact consents without teacher authority", async () => {
    const email = "pending-record@example.invalid";
    await authService.signUp(await createCommand(email, "teacher"), "127.10.1.2");
    const id = await getUserId(email);
    const account = await bootstrapDatabase
      .selectFrom("users")
      .select(["signup_approved_at", "email_verified_at", "signup_role"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(account).toEqual({
      signup_approved_at: null,
      email_verified_at: null,
      signup_role: "teacher",
    });
    expect(
      await bootstrapDatabase
        .selectFrom("teacher_profiles")
        .select("id")
        .where("user_id", "=", id)
        .executeTakeFirst(),
    ).toBeUndefined();
    await expect(getSignUpArtifactCounts(email)).resolves.toEqual({
      users: "1",
      consents: "3",
      tokens: "0",
    });
  });

  it("permits only one concurrent pending signup and never duplicates consent rows", async () => {
    const email = "concurrent-pending@example.invalid",
      command = await createCommand(email);
    const service = createUnthrottledAuthService();
    const outcomes = await Promise.allSettled([
      service.signUp(command, "127.10.1.3"),
      service.signUp(command, "127.10.1.4"),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(EmailAlreadyRegisteredException);
    await expect(getSignUpArtifactCounts(email)).resolves.toEqual({
      users: "1",
      consents: "3",
      tokens: "0",
    });
  });

  it("rejects code-point overflow, HTML elements, and control characters before DB writes", async () => {
    const invalidDisplayNames = ["❤️".repeat(20), "<b>x</b>", "A\nB", "A\u0000B"];

    for (const [index, displayName] of invalidDisplayNames.entries()) {
      const email = `invalid-display-${index}@example.com`;
      const response = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        headers: { origin: "http://localhost:5173" },
        payload: { ...(await createCommand(email)), display_name: displayName },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
      await expect(
        bootstrapDatabase
          .selectFrom("users")
          .select("id")
          .where("email_normalized", "=", email)
          .executeTakeFirst(),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects malformed required consents before creating signup artifacts", async () => {
    const acceptedConsents = { privacy: true, terms: true };
    const invalidConsents: Array<{ label: string; value: unknown }> = [
      { label: "empty-array", value: [] },
      { label: "array", value: [acceptedConsents] },
      { label: "null", value: null },
      { label: "empty-object", value: {} },
      { label: "partial", value: { privacy: true } },
      { label: "false", value: { ...acceptedConsents, terms: false } },
      { label: "extra-key", value: { ...acceptedConsents, marketing: true } },
    ];

    for (const { label, value } of invalidConsents) {
      const email = `invalid-consents-${label}@example.com`;
      const response = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        headers: { origin: "http://localhost:5173" },
        payload: { ...(await createCommand(email)), consents: value },
      });

      expect(response.statusCode, label).toBe(400);
      expect(response.json(), label).toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
      await expect(getSignUpArtifactCounts(email), label).resolves.toEqual({
        consents: "0",
        tokens: "0",
        users: "0",
      });
    }
  });

  it("keeps approved signup successful without invoking legacy verification delivery", async () => {
    mailer.reset();
    mailer.shouldFail = true;
    securityAuditPublisher.reset();
    const requestId = randomUUID();

    await expect(
      authService.signUp(await createCommand("smtp-failure@example.com"), "127.0.0.13", {
        requestId,
        userAgent: "a".repeat(43),
      }),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });

    await expect(getUserId("smtp-failure@example.com")).resolves.toMatch(/^\d+$/u);
    expect(mailer.messages).toHaveLength(0);
    expect(securityAuditPublisher.events).toEqual([]);
  });

  it("does not call the legacy delivery audit publisher during approved signup", async () => {
    const email = "signup-audit-publisher-failure@example.com";
    const failingMailer = new RecordingMailer();
    failingMailer.shouldFail = true;
    const rejectingPublisher = {
      close: vi.fn(),
      publish: vi.fn().mockRejectedValue(new Error(`publisher detail ${email}`)),
    };
    const service = new AuthService(
      applicationDatabase,
      rateLimiter,
      failingMailer,
      authConfig,
      rejectingPublisher,
    );

    await expect(
      service.signUp(await createCommand(email), "127.0.0.131", {
        requestId: randomUUID(),
        userAgent: "integration-test",
      }),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });

    await expect(getUserId(email)).resolves.toMatch(/^\d+$/u);
    expect(failingMailer.messages).toHaveLength(0);
    expect(rejectingPublisher.publish).not.toHaveBeenCalled();
  });

  it("confirms a valid token exactly once in the same transaction as the user", async () => {
    mailer.reset();
    await authService.signUp(await createCommand("confirm@example.com"), "127.0.0.14");
    const rawToken = await issueLegacyEmailVerificationToken(
      await getUserId("confirm@example.com"),
    );

    await expect(authService.confirmEmail(rawToken)).resolves.toEqual({
      email_verified: true,
      next_action: "LOGIN",
    });
    await expect(authService.confirmEmail(rawToken)).rejects.toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );

    const state = await bootstrapDatabase
      .selectFrom("users")
      .innerJoin("email_verification_tokens", "email_verification_tokens.user_id", "users.id")
      .select(["email_verification_tokens.used_at", "users.email_verified_at"])
      .where("users.email_normalized", "=", "confirm@example.com")
      .executeTakeFirstOrThrow();

    expect(state.email_verified_at).toBeInstanceOf(Date);
    expect(state.used_at).toBeInstanceOf(Date);
  });

  it("invalidates the previous token before issuing the single replacement", async () => {
    mailer.reset();
    await authService.signUp(await createCommand("resend@example.com"), "127.0.0.15");
    const userId = await getUserId("resend@example.com");
    const oldToken = await issueLegacyEmailVerificationToken(userId);
    mailer.reset();

    await expect(authService.resendVerification(userId, "127.0.0.15")).resolves.toEqual({
      verification_delivery_status: "sent",
    });
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0]!.rawToken).not.toBe(oldToken);
    await expect(authService.confirmEmail(oldToken)).rejects.toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );

    const tokens = await bootstrapDatabase
      .selectFrom("email_verification_tokens")
      .select(["invalidated_at", "used_at"])
      .where("user_id", "=", userId)
      .orderBy("id")
      .execute();

    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.invalidated_at).toBeInstanceOf(Date);
    expect(tokens[1]).toEqual({ invalidated_at: null, used_at: null });
  });

  it("serializes confirm and resend to one valid final state", async () => {
    mailer.reset();
    await authService.signUp(await createCommand("race@example.com"), "127.0.0.16");
    const userId = await getUserId("race@example.com");
    const oldToken = await issueLegacyEmailVerificationToken(userId);

    const outcomes = await Promise.allSettled([
      authService.confirmEmail(oldToken),
      authService.resendVerification(userId, "127.0.0.16"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      outcomes
        .filter((outcome) => outcome.status === "rejected")
        .every(
          (outcome) =>
            outcome.status === "rejected" &&
            (outcome.reason instanceof TokenInvalidOrExpiredException ||
              outcome.reason instanceof EmailAlreadyVerifiedException),
        ),
    ).toBe(true);

    const user = await bootstrapDatabase
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const openTokens = await bootstrapDatabase
      .selectFrom("email_verification_tokens")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .executeTakeFirstOrThrow();

    expect(
      (user.email_verified_at !== null && openTokens.count === "0") ||
        (user.email_verified_at === null && openTokens.count === "1"),
    ).toBe(true);
  });

  it("enforces the email HMAC signup limit before another DB write", async () => {
    mailer.reset();
    const command = await createCommand("limited@example.com");
    await authService.signUp(command, "127.0.0.17");
    await expect(authService.signUp(command, "127.0.0.17")).rejects.toBeInstanceOf(
      EmailAlreadyRegisteredException,
    );
    await expect(authService.signUp(command, "127.0.0.17")).rejects.toBeInstanceOf(
      EmailAlreadyRegisteredException,
    );
    await expect(authService.signUp(command, "127.0.0.17")).rejects.toBeInstanceOf(
      RateLimitedException,
    );

    const users = await bootstrapDatabase
      .selectFrom("users")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("email_normalized", "=", "limited@example.com")
      .executeTakeFirstOrThrow();
    expect(users.count).toBe("1");

    const httpResponse = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: { origin: "http://localhost:5173" },
      payload: command,
    });
    expect(httpResponse.statusCode).toBe(429);
    expect(httpResponse.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(httpResponse.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });

  it("completes HTTP signup and limits pending login to verification", async () => {
    const recipient = "http-flow@example.com";
    const signup = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: { origin: "http://localhost:5173" },
      payload: await createCommand(recipient),
    });

    expect(signup.statusCode).toBe(202);
    expect(signup.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
    expect(signup.headers["set-cookie"]).toBeUndefined();
    await expectSignupMailWithoutVerification(recipient);

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: recipient, password: baseCommand.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const session = rawCookie(responseCookies(login.headers), SESSION_COOKIE_NAME);
    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      account: { email_verified: false },
      destination: "SIGNUP_APPROVAL_REQUIRED",
    });
  }, 20_000);

  it("creates an active teacher profile from a teacher approval and bootstraps to class creation", async () => {
    const email = "approved-teacher-signup@example.com";
    const signup = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: { origin: "http://localhost:5173" },
      payload: await createCommand(email, "teacher"),
    });
    expect(signup.statusCode, signup.body).toBe(202);
    expect(signup.json()).toEqual({ next_action: "LOGIN", request_accepted: true });

    const userId = await getUserId(email);
    const approvals = httpApplication.get(AdminSignupApprovalService);
    const redemption = httpApplication.get(SignupApprovalRedemptionService);
    const emailed = (await approvals.listMailApprovals()).find(
      (row) => row.recipient_email === email,
    )!;
    await expect(redemption.redeem(userId, emailed.code!, randomUUID())).resolves.toMatchObject({
      signup_approved: false,
    });
    const granted = await approvals.issue(email, "teacher", signupApprovalIssuerId, randomUUID());
    await redemption.redeem(userId, granted.code, randomUUID());
    const profile = await bootstrapDatabase
      .selectFrom("teacher_profiles")
      .select([
        "created_by_admin_account_id",
        "created_by_operator_id",
        "status",
        "temporary_password_expires_at",
        "temporary_password_must_change",
      ])
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(profile).toEqual({
      created_by_admin_account_id: signupApprovalIssuerId,
      created_by_operator_id: null,
      status: "active",
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
    });

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const session = rawCookie(responseCookies(login.headers), SESSION_COOKIE_NAME);
    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      account: { email_verified: true },
      allowed_actions: expect.arrayContaining(["CREATE_CLASS"]),
      destination: "CREATE_CLASS",
      teacher_profile: { status: "active", temporary_password_must_change: false },
    });
    await expectSignupMailWithoutVerification(email);
  }, 20_000);
});

describe("guardian consent signup integration", () => {
  it("stores no child account, consent, or verification token before guardian approval", async () => {
    mailer.reset();
    const childEmail = "guardian-pending-child@example.com";
    const request = await authService.requestGuardianConsent(
      "guardian-pending@example.com",
      "127.0.1.11",
    );

    await expect(
      authService.signUp(await createGuardianCommand(childEmail, request), "127.0.1.12"),
    ).rejects.toBeInstanceOf(TokenInvalidOrExpiredException);
    await expect(getSignUpArtifactCounts(childEmail)).resolves.toEqual({
      consents: "0",
      tokens: "0",
      users: "0",
    });

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.1.13",
      headers: { origin: "http://localhost:5173" },
      payload: { email: childEmail, password: baseCommand.password },
    });
    expect(login.statusCode, login.body).toBe(401);
    expect(login.headers["set-cookie"]).toBeUndefined();

    const membershipRequest = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests",
      remoteAddress: "127.0.1.14",
      headers: { origin: "http://localhost:5173" },
      payload: { invite_code: "ABCDEFGH" },
    });
    expect(membershipRequest.statusCode, membershipRequest.body).toBe(401);

    const storedRequest = await bootstrapDatabase
      .selectFrom("guardian_consent_requests")
      .selectAll()
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(storedRequest).toMatchObject({
      approved_at: null,
      consumed_at: null,
      guardian_email_normalized: "guardian-pending@example.com",
      user_id: null,
    });
    expect(JSON.stringify(storedRequest)).not.toContain(childEmail);
  });

  it("confirms once and rejects a guardian email reused as the student email", async () => {
    mailer.reset();
    const guardianEmail = "same-guardian-student@example.com";
    const request = await authService.requestGuardianConsent(guardianEmail, "127.0.1.21");
    const approvalToken = mailer.guardianMessages[0]?.rawToken;
    expect(approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    await expect(authService.confirmGuardianConsent(approvalToken!)).resolves.toEqual({
      guardian_consent: true,
    });
    await expect(authService.confirmGuardianConsent(approvalToken!)).rejects.toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );
    await expect(
      authService.signUp(
        await createGuardianCommand(` ${guardianEmail.toUpperCase()} `, request),
        "127.0.1.22",
      ),
    ).rejects.toBeInstanceOf(InvalidGuardianConsentException);
    await expect(getSignUpArtifactCounts(guardianEmail)).resolves.toEqual({
      consents: "0",
      tokens: "0",
      users: "0",
    });

    const storedRequest = await bootstrapDatabase
      .selectFrom("guardian_consent_requests")
      .select(["approved_at", "approval_token_hash", "completion_token_hash", "consumed_at"])
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(storedRequest.approved_at).toBeInstanceOf(Date);
    expect(storedRequest.approval_token_hash).toBeNull();
    expect(storedRequest.completion_token_hash).toHaveLength(32);
    expect(storedRequest.consumed_at).toBeNull();
  });

  it("creates two policy consents and consumes the approved request in the signup transaction", async () => {
    mailer.reset();
    const childEmail = "guardian-approved-child@example.com";
    const request = await authService.requestGuardianConsent(
      "guardian-approved@example.com",
      "127.0.1.31",
    );
    await authService.confirmGuardianConsent(mailer.guardianMessages[0]!.rawToken);
    mailer.reset();

    await expect(
      authService.signUp(await createGuardianCommand(childEmail, request), "127.0.1.32"),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });

    const userId = await getUserId(childEmail);
    const consents = await bootstrapDatabase
      .selectFrom("user_consents")
      .select(["consent_type", "policy_version"])
      .where("user_id", "=", userId)
      .orderBy("consent_type")
      .execute();
    expect(consents).toEqual([
      { consent_type: "privacy", policy_version: authConfig.privacyPolicyVersion },
      { consent_type: "terms", policy_version: authConfig.termsPolicyVersion },
    ]);

    const storedRequest = await bootstrapDatabase
      .selectFrom("guardian_consent_requests")
      .select(["approval_token_hash", "completion_token_hash", "consumed_at", "user_id"])
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(storedRequest).toMatchObject({
      approval_token_hash: null,
      completion_token_hash: null,
      consumed_at: expect.any(Date),
      user_id: userId,
    });
    expect(mailer.messages).toHaveLength(0);
  });

  it("allows only one child account when two signups reuse one approved request concurrently", async () => {
    mailer.reset();
    const firstEmail = "guardian-race-first@example.com";
    const secondEmail = "guardian-race-second@example.com";
    const request = await authService.requestGuardianConsent(
      "guardian-race@example.com",
      "127.0.1.41",
    );
    await authService.confirmGuardianConsent(mailer.guardianMessages[0]!.rawToken);
    mailer.reset();

    const outcomes = await Promise.allSettled([
      authService.signUp(await createGuardianCommand(firstEmail, request), "127.0.1.42"),
      authService.signUp(await createGuardianCommand(secondEmail, request), "127.0.1.43"),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );

    const [firstCounts, secondCounts] = await Promise.all([
      getSignUpArtifactCounts(firstEmail),
      getSignUpArtifactCounts(secondEmail),
    ]);
    expect(Number(firstCounts.users) + Number(secondCounts.users)).toBe(1);
    expect(Number(firstCounts.consents) + Number(secondCounts.consents)).toBe(2);
    expect(Number(firstCounts.tokens) + Number(secondCounts.tokens)).toBe(0);
    expect(mailer.messages).toHaveLength(0);

    const storedRequest = await bootstrapDatabase
      .selectFrom("guardian_consent_requests")
      .select(["completion_token_hash", "consumed_at", "user_id"])
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(storedRequest).toMatchObject({
      completion_token_hash: null,
      consumed_at: expect.any(Date),
      user_id: expect.any(String),
    });
  });

  it("completes request, fragment mail, confirmation, status, and signup through HTTP", async () => {
    const guardianEmail = "guardian-http-flow@example.com";
    const childEmail = "guardian-http-child@example.com";
    const requested = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/guardian-consent-requests",
      remoteAddress: "127.0.1.51",
      headers: { origin: "http://localhost:5173" },
      payload: { guardian_email: guardianEmail },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const request = requested.json() as {
      completion_token: string;
      consent_delivery_status: "failed" | "sent";
      expires_at: string;
      request_id: string;
    };
    expect(request).toMatchObject({
      completion_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      consent_delivery_status: "sent",
      expires_at: expect.stringMatching(/Z$/u),
      request_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });

    const message = await waitForMailpitMessageBody(guardianEmail);
    expect(message).toContain("/guardian-consent#token=");
    expect(message).not.toContain("/guardian-consent?token=");
    expect(message).not.toContain(request.completion_token);
    expect(message).not.toContain(childEmail);
    const approvalToken = message.match(/guardian-consent#token=([A-Za-z0-9_-]{43})/u)?.[1];
    expect(approvalToken).toBeDefined();

    const confirmed = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/guardian-consents/confirm",
      remoteAddress: "127.0.1.52",
      headers: { origin: "http://localhost:5173" },
      payload: { token: approvalToken },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toEqual({ guardian_consent: true });

    const status = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/guardian-consent-requests/status",
      remoteAddress: "127.0.1.53",
      headers: { origin: "http://localhost:5173" },
      payload: {
        completion_token: request.completion_token,
        request_id: request.request_id,
      },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toEqual({ status: "approved" });

    const signup = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      remoteAddress: "127.0.1.54",
      headers: { origin: "http://localhost:5173" },
      payload: await createGuardianCommand(childEmail, request),
    });
    expect(signup.statusCode, signup.body).toBe(202);
    expect(signup.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
    await expectSignupMailWithoutVerification(childEmail);

    const userId = await getUserId(childEmail);
    const consents = await bootstrapDatabase
      .selectFrom("user_consents")
      .select("consent_type")
      .where("user_id", "=", userId)
      .orderBy("consent_type")
      .execute();
    expect(consents).toEqual([{ consent_type: "privacy" }, { consent_type: "terms" }]);
    const storedRequest = await bootstrapDatabase
      .selectFrom("guardian_consent_requests")
      .select(["completion_token_hash", "consumed_at", "user_id"])
      .where("id", "=", request.request_id)
      .executeTakeFirstOrThrow();
    expect(storedRequest).toMatchObject({
      completion_token_hash: null,
      consumed_at: expect.any(Date),
      user_id: userId,
    });
    const user = await bootstrapDatabase
      .selectFrom("users")
      .select(["email_verified_at", "signup_approved_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(user.email_verified_at).toBeNull();
    expect(user.signup_approved_at).toBeNull();
  }, 20_000);
});

describe("password reset integration", () => {
  const requestReset = (
    email: string,
    remoteAddress: string,
    origin: string | null = "http://localhost:5173",
    userAgent?: string,
  ) =>
    httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/password-reset-requests",
      remoteAddress,
      headers: origin === null ? { "user-agent": userAgent } : { origin, "user-agent": userAgent },
      payload: { email },
    });

  it("returns the same 202 for existing, missing, inactive, and deleted accounts", async () => {
    const existingEmail = "reset-shape-existing@example.com";
    const inactiveEmail = "reset-shape-inactive@example.com";
    const deletedEmail = "reset-shape-deleted@example.com";
    const existingId = await createTestUser(existingEmail, false);
    const inactiveId = await createTestUser(inactiveEmail);
    const deletedId = await createTestUser(deletedEmail);
    await bootstrapDatabase
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", inactiveId)
      .execute();
    await bootstrapDatabase
      .updateTable("users")
      .set({ deleted_at: new Date() })
      .where("id", "=", deletedId)
      .execute();
    const sessionsBefore = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    const responses = await Promise.all([
      requestReset(` ${existingEmail.toUpperCase()} `, "127.0.1.10"),
      requestReset(
        "reset-shape-missing@example.com",
        "127.0.1.11",
        "http://localhost:5173",
        "b".repeat(43),
      ),
      requestReset(inactiveEmail, "127.0.1.12"),
      requestReset(deletedEmail, "127.0.1.13"),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ request_accepted: true });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }

    const resetTokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(["user_id"])
      .where("user_id", "in", [existingId, inactiveId, deletedId])
      .execute();
    expect(resetTokens).toEqual([{ user_id: existingId }]);
    const sessionsAfter = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(sessionsAfter.count).toBe(sessionsBefore.count);
    await expect(waitForMailpitResetToken(existingEmail)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const existing = await bootstrapDatabase
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", existingId)
      .executeTakeFirstOrThrow();
    expect(existing.email_verified_at).toBeNull();

    const missingEvents = await securityEventsForRequest(
      String(responses[1]!.headers["x-request-id"]),
    );
    expect(missingEvents).toEqual([
      expect.objectContaining({
        action: "auth.password_reset_requested",
        actor_email_hmac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        actor_user_id: null,
        resource: "password_reset",
        user_agent: null,
      }),
    ]);
    expect(JSON.stringify(missingEvents)).not.toContain("reset-shape-missing@example.com");
  });

  it("requires an allowed Origin before rate limiting or DB mutation", async () => {
    const email = "reset-origin@example.com";
    const userId = await createTestUser(email);
    const response = await requestReset(email, "127.0.1.20", null);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    await expectNoSecurityEventsForRequest(String(response.headers["x-request-id"]));
    const tokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(tokens.count).toBe("0");
  });

  it("enforces independent email and IP reset request limits", async () => {
    const email = "reset-email-limit@example.com";
    const userId = await createTestUser(email);
    const emailResponses = [];
    for (let index = 0; index < 4; index += 1) {
      emailResponses.push(await requestReset(email, `127.0.2.${index + 1}`));
    }
    expect(emailResponses.map((response) => response.statusCode)).toEqual([202, 429, 429, 429]);
    expect(emailResponses[3]!.headers["retry-after"]).toMatch(/^\d+$/u);
    const emailRateLimitedEvents = await waitForSecurityEventsForRequest(
      String(emailResponses[3]!.headers["x-request-id"]),
    );
    expect(emailRateLimitedEvents).toEqual([
      expect.objectContaining({
        action: "rate_limited",
        actor_email_hmac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        actor_user_id: null,
        deny_reason: "password_reset_request_limit",
        resource: "password_reset",
      }),
    ]);
    expect(emailRateLimitedEvents.filter((event) => event.action === "auth.login_failed")).toEqual(
      [],
    );
    expect(JSON.stringify(emailRateLimitedEvents)).not.toContain(email);

    const openTokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(openTokens.count).toBe("1");

    const ipResponses = [];
    for (let index = 0; index < 4; index += 1) {
      ipResponses.push(await requestReset(`reset-ip-limit-${index}@example.com`, "127.0.2.100"));
    }
    expect(ipResponses.map((response) => response.statusCode)).toEqual([202, 202, 202, 429]);
    expect(ipResponses[3]!.headers["retry-after"]).toMatch(/^\d+$/u);
  });

  it("fails closed before token creation when the limiter is unavailable", async () => {
    const email = "reset-redis-unavailable@example.com";
    const userId = await createTestUser(email);
    const resetMailer = new RecordingPasswordResetMailer();
    const publisher = new RecordingSecurityAuditPublisher();
    const unavailableLimiter = {
      consume: async () => {
        throw new RateLimitServiceUnavailableException();
      },
    };
    const service = new PasswordResetService(
      applicationDatabase,
      unavailableLimiter as never,
      resetMailer,
      authConfig,
      publisher,
    );

    await expect(
      service.requestReset(email, {
        clientIp: "127.0.3.1",
        requestId: randomUUID(),
        userAgent: "integration-test",
      }),
    ).rejects.toBeInstanceOf(RateLimitServiceUnavailableException);

    const tokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(tokens.count).toBe("0");
    expect(resetMailer.messages).toHaveLength(0);
    expect(publisher.events).toHaveLength(0);
  });

  it("keeps 202 on SMTP failure and publishes only classified audit events", async () => {
    const email = "reset-smtp-failure@example.com";
    const userId = await createTestUser(email);
    const resetMailer = new RecordingPasswordResetMailer();
    resetMailer.shouldFail = true;
    const publisher = new RecordingSecurityAuditPublisher();
    const service = new PasswordResetService(
      applicationDatabase,
      rateLimiter,
      resetMailer,
      authConfig,
      publisher,
    );
    const requestId = randomUUID();

    await expect(
      service.requestReset(email, {
        clientIp: "127.0.3.2",
        requestId,
        userAgent: "reset-test-agent",
      }),
    ).resolves.toEqual({ request_accepted: true });

    expect(publisher.events.map((event) => event.action)).toEqual([
      "auth.password_reset_requested",
      "email.delivery_failed",
    ]);
    expect(publisher.events[1]).toMatchObject({
      actor_user_id: userId,
      failure_code: "smtp_delivery_failed",
      request_id: requestId,
      resource: "password_reset",
    });
    const serialized = JSON.stringify(publisher.events);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain("sensitive detail");
  });

  it("keeps password-reset acceptance when every audit publish rejects", async () => {
    const email = "reset-audit-publisher-failure@example.com";
    const userId = await createTestUser(email);
    const resetMailer = new RecordingPasswordResetMailer();
    resetMailer.shouldFail = true;
    const rejectingPublisher = {
      close: vi.fn(),
      publish: vi.fn().mockRejectedValue(new Error(`publisher detail ${email}`)),
    };
    const service = new PasswordResetService(
      applicationDatabase,
      rateLimiter,
      resetMailer,
      authConfig,
      rejectingPublisher,
    );

    await expect(
      service.requestReset(email, {
        clientIp: "127.0.3.22",
        requestId: randomUUID(),
        userAgent: "integration-test",
      }),
    ).resolves.toEqual({ request_accepted: true });

    const openTokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(openTokens.count).toBe("1");
    expect(rejectingPublisher.publish).toHaveBeenCalledTimes(2);
  });

  it("admits one concurrent reset request without replacing its token", async () => {
    const email = "reset-concurrent-request@example.com";
    const userId = await createTestUser(email);
    const responses = await Promise.all([
      requestReset(email, "127.0.4.1"),
      requestReset(email, "127.0.4.2"),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429]);

    const tokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(["invalidated_at"])
      .where("user_id", "=", userId)
      .execute();
    expect(tokens).toHaveLength(1);
    expect(tokens.filter((token) => token.invalidated_at === null)).toHaveLength(1);
  });

  it("resets password, unlocks the account, preserves verification, and revokes every session", async () => {
    const email = "reset-complete@example.com";
    const userId = await createTestUser(email, false);
    const sessionService = new SessionService(applicationDatabase, rateLimiter, authConfig);
    const firstSession = await sessionService.login(
      { email, password: baseCommand.password },
      "127.0.5.1",
      "reset-first-session",
    );
    await sessionService.login(
      { email, password: baseCommand.password },
      "127.0.5.2",
      "reset-second-session",
    );
    await bootstrapDatabase
      .updateTable("users")
      .set({ failed_login_attempts: 3, locked_until: new Date(Date.now() + 60 * 1_000) })
      .where("id", "=", userId)
      .execute();

    const requested = await requestReset(email, "127.0.5.3");
    expect(requested.statusCode).toBe(202);
    const rawToken = await waitForMailpitResetToken(email);
    const newPassword = "Reset123";
    const confirmed = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/password-resets/confirm",
      remoteAddress: "127.0.5.4",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${firstSession.sessionToken}; ${CSRF_COOKIE_NAME}=${firstSession.csrfToken}`,
        origin: "http://localhost:5173",
      },
      payload: { new_password: newPassword, token: rawToken },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ next_action: "LOGIN", password_reset: true });
    expect(responseCookies(confirmed.headers)).toHaveLength(2);
    expect(responseCookies(confirmed.headers).every((cookie) => cookie.includes("Max-Age=0"))).toBe(
      true,
    );

    const account = await bootstrapDatabase
      .selectFrom("users")
      .select([
        "email_verified_at",
        "failed_login_attempts",
        "locked_until",
        "password_hash",
        "password_last_changed_at",
      ])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(account.email_verified_at).toBeNull();
    expect(account.failed_login_attempts).toBe(0);
    expect(account.locked_until).toBeNull();
    expect(account.password_last_changed_at).not.toBeNull();
    await expect(verifyPassword(newPassword, account.password_hash)).resolves.toBe(true);

    const activeSessions = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(activeSessions.count).toBe("0");

    const token = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(["invalidated_at", "used_at"])
      .where("token_hash", "=", hashVerificationToken(rawToken))
      .executeTakeFirstOrThrow();
    expect(token.invalidated_at).toBeNull();
    expect(token.used_at).not.toBeNull();

    await expect(
      sessionService.login({ email, password: baseCommand.password }, "127.0.5.5", "old-password"),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    await expect(
      sessionService.login({ email, password: newPassword }, "127.0.5.6", "new-password"),
    ).resolves.toMatchObject({ next_action: "BOOTSTRAP" });

    const replay = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/password-resets/confirm",
      remoteAddress: "127.0.5.7",
      headers: { origin: "http://localhost:5173" },
      payload: { new_password: "Other123", token: rawToken },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: { code: "TOKEN_INVALID_OR_EXPIRED" } });

    const requestedEvents = await securityEventsForRequest(
      String(requested.headers["x-request-id"]),
    );
    expect(requestedEvents.map((event) => event.action)).toContain("auth.password_reset_requested");
    const completedEvents = await securityEventsForRequest(
      String(confirmed.headers["x-request-id"]),
    );
    expect(completedEvents).toEqual([
      expect.objectContaining({
        action: "auth.password_reset_completed",
        actor_user_id: userId,
        resource: "password_reset",
      }),
    ]);
    expect(JSON.stringify([...requestedEvents, ...completedEvents])).not.toContain(email);
  }, 30_000);

  it("clears a teacher temporary-password gate after reset", async () => {
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256").update(randomUUID()).digest(),
        email_normalized: "reset-teacher-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const email = "reset-teacher@example.com";
    const userId = await createTestUser(email);
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: new Date(Date.now() + 60 * 60 * 1_000),
        temporary_password_must_change: true,
        user_id: userId,
      })
      .execute();

    await requestReset(email, "127.0.6.1");
    const rawToken = await waitForMailpitResetToken(email);
    const response = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/password-resets/confirm",
      remoteAddress: "127.0.6.2",
      headers: { origin: "http://localhost:5173" },
      payload: { new_password: "Teach123", token: rawToken },
    });
    expect(response.statusCode).toBe(200);

    const profile = await bootstrapDatabase
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(profile).toEqual({
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
    });
  });

  it("does not create an active old-password session when login races reset completion", async () => {
    const email = "reset-login-race@example.com";
    const userId = await createTestUser(email);
    await requestReset(email, "127.0.6.10");
    const rawToken = await waitForMailpitResetToken(email);
    const sessionService = new SessionService(applicationDatabase, rateLimiter, authConfig);
    let confirmationPromise: ReturnType<typeof httpApplication.inject> | undefined;
    let loginPromise: ReturnType<SessionService["login"]> | undefined;

    await bootstrapDatabase.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      confirmationPromise = httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/password-resets/confirm",
        remoteAddress: "127.0.6.11",
        headers: { origin: "http://localhost:5173" },
        payload: { new_password: "Race1234", token: rawToken },
      });
      await waitForApplicationLockWait('from "users"');
      loginPromise = sessionService.login(
        { email, password: baseCommand.password },
        "127.0.6.12",
        "old-password-race",
      );
    });

    if (confirmationPromise === undefined || loginPromise === undefined) {
      throw new Error("Password reset race promises were not initialized.");
    }

    const [confirmation, login] = await Promise.allSettled([confirmationPromise, loginPromise]);
    expect(confirmation).toMatchObject({
      status: "fulfilled",
      value: expect.objectContaining({ statusCode: 200 }),
    });
    expect(login).toMatchObject({
      reason: expect.any(InvalidCredentialsException),
      status: "rejected",
    });

    const activeSessions = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(activeSessions.count).toBe("0");
  }, 30_000);

  it("rejects expired tokens and allows only one concurrent confirmation", async () => {
    const expiredEmail = "reset-expired@example.com";
    const expiredUserId = await createTestUser(expiredEmail);
    await requestReset(expiredEmail, "127.0.7.1");
    const expiredRawToken = await waitForMailpitResetToken(expiredEmail);
    await bootstrapDatabase
      .updateTable("password_reset_tokens")
      .set({
        created_at: new Date(Date.now() - 32 * 60 * 1_000),
        expires_at: new Date(Date.now() - 60 * 1_000),
      })
      .where("user_id", "=", expiredUserId)
      .execute();
    const expired = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/password-resets/confirm",
      remoteAddress: "127.0.7.2",
      headers: { origin: "http://localhost:5173" },
      payload: { new_password: "Expire12", token: expiredRawToken },
    });
    expect(expired.statusCode).toBe(400);

    const concurrentEmail = "reset-concurrent-confirm@example.com";
    const concurrentUserId = await createTestUser(concurrentEmail);
    await requestReset(concurrentEmail, "127.0.7.3");
    const concurrentRawToken = await waitForMailpitResetToken(concurrentEmail);
    const confirmations = await Promise.all([
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/password-resets/confirm",
        remoteAddress: "127.0.7.4",
        headers: { origin: "http://localhost:5173" },
        payload: { new_password: "Race1234", token: concurrentRawToken },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/password-resets/confirm",
        remoteAddress: "127.0.7.5",
        headers: { origin: "http://localhost:5173" },
        payload: { new_password: "Race4567", token: concurrentRawToken },
      }),
    ]);
    expect(confirmations.map((response) => response.statusCode).sort()).toEqual([200, 400]);

    const usedTokens = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", concurrentUserId)
      .where("used_at", "is not", null)
      .executeTakeFirstOrThrow();
    expect(usedTokens.count).toBe("1");
  }, 30_000);
});

describe("login, session, logout, and CSRF integration", () => {
  it("resends verification through an approved email-unverified session with CSRF protection", async () => {
    const email = "http-resend-verification@example.com";
    const userId = await createTestUser(email, false);
    // P-010 permits this legacy ownership check only after administrator signup approval.
    await bootstrapDatabase
      .updateTable("users")
      .set({ signup_approved_at: new Date() })
      .where("id", "=", userId)
      .execute();
    await issueLegacyEmailVerificationToken(userId);
    const originalToken = await bootstrapDatabase
      .selectFrom("email_verification_tokens")
      .select(["id", "token_hash"])
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .where("invalidated_at", "is", null)
      .executeTakeFirstOrThrow();

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    const unauthenticated = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/email-verifications/resend",
      headers: { origin: "http://localhost:5173" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const invalidCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/email-verifications/resend",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": "invalid",
      },
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
    const csrfEvents = await waitForSecurityEventsForRequest(
      String(invalidCsrf.headers["x-request-id"]),
    );
    expect(csrfEvents).toEqual([
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_class_id: null,
        actor_user_id: userId,
        target_class_id: null,
        deny_reason: "csrf_header_invalid",
        sanitized_path: "/api/v1/auth/email-verifications/resend",
      }),
    ]);
    expect(JSON.stringify(csrfEvents)).not.toContain(sessionToken);
    expect(JSON.stringify(csrfEvents)).not.toContain(csrfToken);

    const response = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/email-verifications/resend",
      headers: { cookie, origin: "http://localhost:5173", "x-csrf-token": csrfToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verification_delivery_status: "sent" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    await expect(waitForMailpitMessage(email)).resolves.toContain(email);

    const [tokens, sessions] = await Promise.all([
      bootstrapDatabase
        .selectFrom("email_verification_tokens")
        .select(["id", "invalidated_at", "token_hash", "used_at"])
        .where("user_id", "=", userId)
        .orderBy("id")
        .execute(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ id: originalToken.id, used_at: null });
    expect(tokens[0]?.invalidated_at).toBeInstanceOf(Date);
    expect(tokens[1]).toMatchObject({ invalidated_at: null, used_at: null });
    expect(tokens[1]?.token_hash).not.toEqual(originalToken.token_hash);
    expect(sessions.count).toBe("1");
  });

  it("routes unapproved bootstrap to signup approval and preserves legacy verification access", async () => {
    const email = "bootstrap-student@example.com";
    const userId = await createTestUser(email, false);

    const unauthenticated = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    const unverified = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(unverified.statusCode).toBe(200);
    expect(unverified.json()).toMatchObject({
      account: { email_verified: false, is_active: true },
      allowed_actions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
      current_class: null,
      current_membership: null,
      destination: "SIGNUP_APPROVAL_REQUIRED",
      last_membership_status: null,
      last_status_reason: null,
      teacher_profile: null,
    });
    expect(unverified.json().server_today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const classPayload = {
      academic_year: 2026,
      edu_office_code: "B10",
      expected_student_count: 30,
      grade: 1,
      name: "미인증 차단 반",
      school_code: "1234567",
    };
    const invalidCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": "invalid",
        "idempotency-key": randomUUID(),
      },
      payload: classPayload,
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const protectedResponses = [
      await httpApplication.inject({
        method: "POST",
        url: "/api/v1/classes",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "x-csrf-token": csrfToken,
          "idempotency-key": randomUUID(),
        },
        payload: classPayload,
      }),
      await httpApplication.inject({
        method: "POST",
        url: "/api/v1/membership-requests",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "x-csrf-token": csrfToken,
        },
        payload: { invite_code: "ZZZZZZZZ" },
      }),
      await httpApplication.inject({
        method: "GET",
        url: "/api/v1/home",
        headers: { cookie },
      }),
      await httpApplication.inject({
        method: "GET",
        url: "/api/v1/classes/current",
        headers: { cookie },
      }),
      await httpApplication.inject({
        method: "GET",
        url: "/api/v1/classes/current/invite-code",
        headers: { cookie },
      }),
      await httpApplication.inject({
        method: "GET",
        url: "/api/v1/members?status=pending",
        headers: { cookie },
      }),
      await httpApplication.inject({
        method: "GET",
        url: "/api/v1/schools?q=test",
        headers: { cookie },
      }),
    ];
    for (const response of protectedResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });
    }

    const protectedRequestIds = protectedResponses.map((response) =>
      String(response.headers["x-request-id"]),
    );
    const protectedEvents = await waitForSecurityEventsForRequests(protectedRequestIds, 5);
    expect(protectedEvents).toHaveLength(5);
    for (const event of protectedEvents) {
      expect(event).toMatchObject({
        action: "authz.denied",
        actor_class_id: null,
        actor_user_id: userId,
        deny_reason: "email_not_verified",
      });
    }
    expect(new Set(protectedEvents.map((event) => event.resource))).toEqual(
      new Set(["classes", "membership-requests", "home", "members", "schools"]),
    );
    expect(protectedEvents.filter((event) => event.resource === "classes")).toHaveLength(1);

    const [memberships, idempotencyKeys] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("api_idempotency_keys")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", userId)
        .executeTakeFirstOrThrow(),
    ]);
    expect({ idempotencyKeys: idempotencyKeys.count, memberships: memberships.count }).toEqual({
      idempotencyKeys: "0",
      memberships: "0",
    });

    await bootstrapDatabase
      .updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("id", "=", userId)
      .execute();

    const verified = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      account: { email_verified: true, is_active: true },
      allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "ENTER_INVITE_CODE"],
      destination: "ENTER_INVITE_CODE",
    });
  });

  it("revokes an existing temporary-password session on its first expired request", async () => {
    const email = "bootstrap-temporary-teacher@example.com";
    await authService.signUp(await createCommand(email), "127.0.0.71");
    const userId = await getUserId(email);
    await bootstrapDatabase
      .updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("id", "=", userId)
      .execute();
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256")
          .update("bootstrap-teacher-operator-credential")
          .digest(),
        email_normalized: "bootstrap-teacher-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: new Date(Date.now() + 60_000),
        temporary_password_must_change: true,
        user_id: userId,
      })
      .execute();

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode).toBe(200);
    const sessionToken = rawCookie(responseCookies(login.headers), SESSION_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;

    const beforeExpiry = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(beforeExpiry.statusCode).toBe(200);
    expect(beforeExpiry.json()).toMatchObject({ destination: "CHANGE_TEMPORARY_PASSWORD" });

    await bootstrapDatabase
      .updateTable("teacher_profiles")
      .set({ temporary_password_expires_at: new Date(Date.now() - 1_000) })
      .where("user_id", "=", userId)
      .execute();

    const expired = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const session = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(session.revoked_at).not.toBeNull();
  });

  it("revokes an expired temporary-password session instead of refreshing CSRF", async () => {
    const email = "csrf-expired-temporary-teacher@example.com";
    await authService.signUp(await createCommand(email), "127.0.0.72");
    const userId = await getUserId(email);
    await bootstrapDatabase
      .updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("id", "=", userId)
      .execute();
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256")
          .update("csrf-expired-temporary-teacher-operator")
          .digest(),
        email_normalized: "csrf-expired-temporary-teacher-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: new Date(Date.now() + 60_000),
        temporary_password_must_change: true,
        user_id: userId,
      })
      .execute();

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const sessionHash = hashSessionSecret(sessionToken);
    const before = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at"])
      .where("session_hash", "=", sessionHash)
      .executeTakeFirstOrThrow();
    expect(before.revoked_at).toBeNull();

    await bootstrapDatabase
      .updateTable("teacher_profiles")
      .set({ temporary_password_expires_at: new Date(Date.now() - 1_000) })
      .where("user_id", "=", userId)
      .execute();

    const expired = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/csrf-token",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        origin: "http://localhost:5173",
      },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const after = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at"])
      .where("session_hash", "=", sessionHash)
      .executeTakeFirstOrThrow();
    expect(after.revoked_at).not.toBeNull();
    expect(after.csrf_token_hash).toEqual(before.csrf_token_hash);
  });

  it("does not hold the session lock while the CSRF rate limiter is stalled", async () => {
    const email = "csrf-rate-limit-stall@example.com";
    const userId = await createTestUser(email);
    const sessionService = new SessionService(applicationDatabase, rateLimiter, authConfig);
    const login = await sessionService.login(
      { email, password: baseCommand.password },
      "127.0.0.113",
    );
    const sessionHash = hashSessionSecret(login.sessionToken);
    const before = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at"])
      .where("session_hash", "=", sessionHash)
      .executeTakeFirstOrThrow();

    let markConsumeStarted!: () => void;
    const consumeStarted = new Promise<void>((resolve) => {
      markConsumeStarted = resolve;
    });
    let rejectConsume!: (reason: unknown) => void;
    const stalledConsume = new Promise<RateLimitResult>((_resolve, reject) => {
      rejectConsume = reject;
    });
    const stalledLimiter = {
      consume: () => {
        markConsumeStarted();
        return stalledConsume;
      },
    } as unknown as RedisRateLimiter;
    const stalledService = new SessionService(applicationDatabase, stalledLimiter, authConfig);
    const refreshOutcome = stalledService.refreshCsrf(login.sessionToken).then(
      () => new Error("Expected CSRF refresh to fail closed."),
      (error: unknown) => error,
    );

    await withSafetyDeadline(consumeStarted, 5_000, "CSRF refresh did not reach the rate limiter.");
    try {
      await bootstrapDatabase
        .transaction()
        .execute((transaction) =>
          transaction
            .selectFrom("sessions")
            .select("id")
            .where("session_hash", "=", sessionHash)
            .forUpdate()
            .noWait()
            .executeTakeFirstOrThrow(),
        );
    } finally {
      rejectConsume(new RateLimitServiceUnavailableException(new Error("simulated Redis stall")));
    }

    expect(
      await withSafetyDeadline(
        refreshOutcome,
        5_000,
        "CSRF refresh did not settle after the limiter failed.",
      ),
    ).toBeInstanceOf(RateLimitServiceUnavailableException);
    const after = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at"])
      .where("session_hash", "=", sessionHash)
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it("revalidates a session that is revoked while the CSRF limiter is pending", async () => {
    const email = "csrf-rate-limit-logout-race@example.com";
    await createTestUser(email);
    const sessionService = new SessionService(applicationDatabase, rateLimiter, authConfig);
    const login = await sessionService.login(
      { email, password: baseCommand.password },
      "127.0.0.114",
    );
    const sessionHash = hashSessionSecret(login.sessionToken);
    const before = await bootstrapDatabase
      .selectFrom("sessions")
      .select("csrf_token_hash")
      .where("session_hash", "=", sessionHash)
      .executeTakeFirstOrThrow();

    let markConsumeStarted!: () => void;
    const consumeStarted = new Promise<void>((resolve) => {
      markConsumeStarted = resolve;
    });
    let resolveConsume!: (result: RateLimitResult) => void;
    const pendingConsume = new Promise<RateLimitResult>((resolve) => {
      resolveConsume = resolve;
    });
    const delayedLimiter = {
      consume: () => {
        markConsumeStarted();
        return pendingConsume;
      },
    } as unknown as RedisRateLimiter;
    const delayedService = new SessionService(applicationDatabase, delayedLimiter, authConfig);
    const refreshOutcome = delayedService.refreshCsrf(login.sessionToken).then(
      () => new Error("Expected the revoked session to fail authentication."),
      (error: unknown) => error,
    );

    await withSafetyDeadline(
      consumeStarted,
      5_000,
      "CSRF refresh did not reach the delayed rate limiter.",
    );
    const logoutOutcome = sessionService.logout(login.sessionToken);
    try {
      await withSafetyDeadline(
        logoutOutcome,
        5_000,
        "Logout waited for the CSRF refresh session lock.",
      );
    } finally {
      resolveConsume({
        allowed: true,
        count: 1,
        limit: 3,
        remaining: 2,
        retryAfterSeconds: 60,
      });
      await Promise.allSettled([logoutOutcome, refreshOutcome]);
    }

    expect(
      await withSafetyDeadline(
        refreshOutcome,
        5_000,
        "CSRF refresh did not settle after the limiter resumed.",
      ),
    ).toBeInstanceOf(UnauthenticatedException);
    const after = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at"])
      .where("session_hash", "=", sessionHash)
      .executeTakeFirstOrThrow();
    expect(after.csrf_token_hash).toEqual(before.csrf_token_hash);
    expect(after.revoked_at).not.toBeNull();
  });

  it("rejects expired teacher login without an account-wide lock after wrong passwords", async () => {
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256").update("expired-login-operator").digest(),
        email_normalized: "expired-login-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const expiredCorrectEmail = "expired-correct-password@example.com";
    const expiredWrongEmail = "expired-wrong-password@example.com";
    const expiredCorrectUserId = await createTestUser(expiredCorrectEmail);
    const expiredWrongUserId = await createTestUser(expiredWrongEmail);
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values(
        [expiredCorrectUserId, expiredWrongUserId].map((userId) => ({
          created_by_operator_id: operator.id,
          temporary_password_expires_at: new Date(Date.now() - 60_000),
          temporary_password_must_change: true,
          user_id: userId,
        })),
      )
      .execute();
    const sessionService = new SessionService(applicationDatabase, rateLimiter, authConfig);

    await expect(
      sessionService.login(
        { email: expiredCorrectEmail, password: baseCommand.password },
        "127.0.0.111",
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    const correctPasswordUser = await bootstrapDatabase
      .selectFrom("users")
      .select(["failed_login_attempts", "locked_until"])
      .where("id", "=", expiredCorrectUserId)
      .executeTakeFirstOrThrow();
    expect(correctPasswordUser).toEqual({ failed_login_attempts: 0, locked_until: null });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        sessionService.login(
          { email: expiredWrongEmail, password: "wrong-password1" },
          "127.0.0.112",
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    }
    await expect(
      sessionService.login(
        { email: expiredWrongEmail, password: "wrong-password1" },
        "127.0.0.112",
      ),
    ).rejects.toBeInstanceOf(RateLimitedException);
    await expect(
      sessionService.login(
        { email: expiredWrongEmail, password: baseCommand.password },
        "127.0.0.117",
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    const wrongPasswordUser = await bootstrapDatabase
      .selectFrom("users")
      .select(["failed_login_attempts", "locked_until"])
      .where("id", "=", expiredWrongUserId)
      .executeTakeFirstOrThrow();
    expect(wrongPasswordUser).toEqual({ failed_login_attempts: 0, locked_until: null });
  }, 30_000);

  it("limits login failures by network and email while preserving shared-school access and private audit", async () => {
    const email = "school-login@example.invalid";
    await createTestUser(email);
    const service = new SessionService(applicationDatabase, rateLimiter, authConfig);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.login(
          { email: "missing-limited@example.invalid", password: "wrong-password1" },
          "127.0.0.99",
        ),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    }
    const limited = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.0.99",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "missing-limited@example.invalid", password: "wrong-password1" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    const events = await waitForSecurityEventsForRequest(String(limited.headers["x-request-id"]));
    expect(events).toEqual([
      expect.objectContaining({
        action: "rate_limited",
        actor_user_id: null,
        deny_reason: "rate_limited",
        sanitized_path: "/api/v1/auth/login",
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/missing-limited|wrong-password1/u);
    await expect(
      service.login({ email, password: baseCommand.password }, "127.0.0.99"),
    ).resolves.toMatchObject({ next_action: "BOOTSTRAP" });
  });

  it("blocks exhausted login admission before touching a known or unknown account", async () => {
    const email = "rate-limited-account@example.invalid";
    const userId = await createTestUser(email);
    const service = new SessionService(applicationDatabase, rateLimiter, authConfig);
    const clientIp = "127.0.0.116";
    const key =
      "login-admission:network:" +
      createPrivacySafeSubject(
        authConfig.emailHmacKey,
        authConfig.emailHmacKeyVersion,
        "login_network",
        clientIp,
      ) +
      ":policy:300:60";
    await securityRedis.set(key, "300", { EX: 60 });
    const query = vi.spyOn(applicationDatabase, "selectFrom");
    try {
      for (const target of [email, "unknown@example.invalid"])
        await expect(
          service.login({ email: target, password: baseCommand.password }, clientIp),
        ).rejects.toBeInstanceOf(RateLimitedException);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
    expect(
      await bootstrapDatabase
        .selectFrom("users")
        .select(["failed_login_attempts", "locked_until"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ failed_login_attempts: 0, locked_until: null });
    expect(
      (
        await bootstrapDatabase
          .selectFrom("sessions")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("user_id", "=", userId)
          .executeTakeFirstOrThrow()
      ).count,
    ).toBe("0");
  });

  it("caps concurrent login attempts without letting attackers lock another network's correct credentials", async () => {
    const email = "concurrent-account-login@example.invalid";
    const userId = await createTestUser(email);
    const service = new SessionService(applicationDatabase, rateLimiter, authConfig);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        service.login({ email, password: "wrong-password1" }, "127.1.0.1"),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(0);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof RateLimitedException,
      ).length,
    ).toBeGreaterThanOrEqual(20);
    expect(
      await bootstrapDatabase
        .selectFrom("users")
        .select(["failed_login_attempts", "locked_until"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ failed_login_attempts: 0, locked_until: null });
    await expect(
      service.login({ email, password: baseCommand.password }, "127.1.0.2"),
    ).resolves.toMatchObject({ next_action: "BOOTSTRAP" });
  }, 30_000);

  it("preserves shared login capacity after 600 blocked requests using real Redis", async () => {
    const admission = new LoginAdmission(rateLimiter, authConfig);
    const { pair: failure } = await admission.enter(
      "blocked-capacity@example.invalid",
      "127.12.0.1",
    );
    await securityRedis.set(
      `${failure.key}:policy:${failure.limit}:${failure.windowSeconds}`,
      String(failure.limit),
      { EX: 60 },
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 600 }, () =>
        admission.enter("blocked-capacity@example.invalid", "127.12.0.1"),
      ),
    );
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === "rejected" && outcome.reason instanceof RateLimitedException,
      ),
    ).toBe(true);
    await expect(securityRedis.get("login-admission:service:v1:policy:600:60")).resolves.toBe("1");
    const email = "other-network-capacity@example.invalid";
    await createTestUser(email);
    const response = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.12.1.1",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("fails closed without creating a session when Redis is unavailable", async () => {
    const email = "redis-fail-closed-login@example.com";
    await authService.signUp(await createCommand(email), "127.0.0.64");
    const unavailableLimiter = createRedisRateLimiter("redis://127.0.0.1:1");
    const sessionService = new SessionService(applicationDatabase, unavailableLimiter, authConfig);

    try {
      await expect(
        sessionService.login({ email, password: baseCommand.password }, "127.0.0.100"),
      ).rejects.toBeInstanceOf(RateLimitServiceUnavailableException);
    } finally {
      await unavailableLimiter.close();
    }

    const sessions = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", await getUserId(email))
      .executeTakeFirstOrThrow();
    expect(sessions.count).toBe("0");
  });

  it("fails login before account work when the admission Redis response stalls", async () => {
    const email = "redis-stalled-wrong-password@example.com";
    const userId = await createTestUser(email);
    const expiredLock = new Date(Date.now() - 60_000);
    await bootstrapDatabase
      .updateTable("users")
      .set({ failed_login_attempts: 3, locked_until: expiredLock })
      .where("id", "=", userId)
      .execute();
    let isOpen = true;
    let isReady = true;
    let markEvalStarted!: () => void;
    const evalStarted = new Promise<void>((resolve) => {
      markEvalStarted = resolve;
    });
    let evalCalls = 0;
    const stalledClient = {
      connect: async () => undefined,
      destroy: () => {
        isOpen = false;
        isReady = false;
      },
      eval: () => {
        evalCalls += 1;
        markEvalStarted();
        return new Promise<never>(() => undefined);
      },
      get isOpen() {
        return isOpen;
      },
      get isReady() {
        return isReady;
      },
      ping: async () => "PONG",
    };
    const stalledLimiter = new RedisRateLimiter(stalledClient as never);
    const stalledService = new SessionService(applicationDatabase, stalledLimiter, authConfig);
    const loginOutcome = stalledService
      .login({ email, password: "wrong-password1" }, "127.0.0.115")
      .then(
        () => new Error("Expected the stalled login to fail closed."),
        (error: unknown) => error,
      );

    await withSafetyDeadline(evalStarted, 5_000, "Login did not reach the Redis EVAL call.");
    expect(
      await withSafetyDeadline(
        loginOutcome,
        5_000,
        "Login did not settle after the Redis operation deadline.",
      ),
    ).toBeInstanceOf(RateLimitServiceUnavailableException);

    await bootstrapDatabase
      .transaction()
      .execute((transaction) =>
        transaction
          .selectFrom("users")
          .select("id")
          .where("id", "=", userId)
          .forUpdate()
          .noWait()
          .executeTakeFirstOrThrow(),
      );
    const user = await bootstrapDatabase
      .selectFrom("users")
      .select(["failed_login_attempts", "locked_until"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const sessions = await bootstrapDatabase
      .selectFrom("sessions")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ failed_login_attempts: 3, locked_until: expiredLock });
    expect(sessions.count).toBe("0");
    expect(evalCalls).toBe(1);
  });

  it("keeps existing 72-character passwords usable, issues only new hashed secrets and keeps five sessions", async () => {
    const email = "session-limit@example.com";
    await authService.signUp(await createCommand(email), "127.0.0.61");
    const legacyPassword = `${"L".repeat(71)}1`;
    await bootstrapDatabase
      .updateTable("users")
      .set({ password_hash: await hashPassword(legacyPassword) })
      .where("email_normalized", "=", email)
      .execute();

    let latestCookies: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${"Z".repeat(43)}`,
          origin: "http://localhost:5173",
          "user-agent": "classhub-integration-test",
        },
        payload: { email, password: legacyPassword },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ next_action: "BOOTSTRAP" });
      latestCookies = responseCookies(response.headers);
    }

    const sessionToken = rawCookie(latestCookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(latestCookies, CSRF_COOKIE_NAME);
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(sessionToken).not.toBe("Z".repeat(43));
    expect(latestCookies[0]).toContain("HttpOnly");
    expect(latestCookies[1]).not.toContain("HttpOnly");

    const userId = await getUserId(email);
    const sessions = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["csrf_token_hash", "revoked_at", "session_hash", "user_agent"])
      .where("user_id", "=", userId)
      .orderBy("issued_at", "asc")
      .execute();
    expect(sessions).toHaveLength(6);
    expect(sessions.filter((session) => session.revoked_at === null)).toHaveLength(5);
    expect(sessions[0]?.revoked_at).not.toBeNull();
    expect(sessions.at(-1)?.session_hash).toEqual(hashSessionSecret(sessionToken));
    expect(sessions.at(-1)?.csrf_token_hash).toEqual(hashSessionSecret(csrfToken));
    expect(sessions.at(-1)?.user_agent).toBe("classhub-integration-test");
  }, 30_000);

  it("uses the same login error for existing, missing and legacy-locked accounts and restores correct login", async () => {
    const email = "generic-login@example.invalid";
    const userId = await createTestUser(email);
    const request = (target: string, password: string, remoteAddress: string) =>
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress,
        headers: { origin: "http://localhost:5173" },
        payload: { email: target, password },
      });
    const missing = await request(
      "generic-missing@example.invalid",
      "wrong-password1",
      "127.9.0.1",
    );
    const existing = await request(email, "wrong-password1", "127.9.0.2");
    await bootstrapDatabase
      .updateTable("users")
      .set({ failed_login_attempts: 3, locked_until: new Date(Date.now() + 60_000) })
      .where("id", "=", userId)
      .execute();
    const locked = await request(email, "wrong-password1", "127.9.0.3");
    for (const response of [missing, existing, locked]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json()).toMatchObject({
        error: { code: missing.json().error.code, message: missing.json().error.message },
      });
    }
    const correct = await request(email, baseCommand.password, "127.9.0.4");
    expect(correct.statusCode, correct.body).toBe(200);
    expect(
      await bootstrapDatabase
        .selectFrom("users")
        .select(["failed_login_attempts", "locked_until"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  it("reports bounded login overload as retryable 503 and accepts a normal login after recovery", async () => {
    const email = "overload-login@example.invalid";
    await createTestUser(email);
    // 과부하만 보려고 계정마다 한 번씩 틀린다. 한 계정에 몰아 틀리면 2026-10-02 계정 기준 대기가 먼저 걸린다.
    const responses = await Promise.all(
      Array.from({ length: 48 }, (_, index) =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: `127.10.0.${index + 1}`,
          headers: { origin: "http://localhost:5173" },
          payload: { email: `overload-${index}@example.invalid`, password: "wrong-password1" },
        }),
      ),
    );
    expect(
      responses.every((response) => response.statusCode === 401 || response.statusCode === 503),
    ).toBe(true);
    const rejected = responses.filter((response) => response.statusCode === 503);
    expect(rejected.length).toBeGreaterThan(0);
    for (const response of rejected) {
      expect(response.headers["retry-after"]).toBe("2");
      expect(response.json()).toMatchObject({
        error: { code: "SERVICE_UNAVAILABLE", message: "요청을 처리하지 못했습니다." },
      });
      expect(response.body).not.toMatch(/argon|capacity|queue|Maria/iu);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const recovered = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.10.1.1",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    console.info(
      JSON.stringify({
        measurement: "login-burst",
        requests: 48,
        capacityRejected: rejected.length,
        recovered: true,
      }),
    );
  });

  it("spaces one account's attempts across networks and clears the wait on a correct login", async () => {
    // 2026-10-02 사용자 결정: 주소와 상관없이 계정 기준 5번 실패 뒤 30초 간격, 바른 로그인으로 해제.
    const email = "account-wait@example.invalid";
    await createTestUser(email);
    const attempt = (index: number, password: string) =>
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: `127.11.0.${index}`,
        headers: { origin: "http://localhost:5173" },
        payload: { email, password },
      });
    for (let index = 1; index <= 5; index += 1) {
      expect((await attempt(index, "wrong-password1")).statusCode).toBe(401);
    }
    expect((await attempt(6, "wrong-password1")).statusCode).toBe(401);
    const spaced = await attempt(7, baseCommand.password);
    expect(spaced.statusCode, spaced.body).toBe(429);
    const waits = await securityRedis.keys("login-*account*");
    if (waits.length > 0) await securityRedis.del(waits);
    for (let index = 8; index <= 12; index += 1) {
      expect((await attempt(index, "wrong-password1")).statusCode).toBe(401);
    }
    const owner = await attempt(13, baseCommand.password);
    expect(owner.statusCode, owner.body).toBe(200);
    expect((await attempt(14, "wrong-password1")).statusCode).toBe(401);
  });

  it("measures generic login rejection for existing, missing and legacy-locked accounts", async () => {
    const existing = "timing-existing@example.invalid",
      locked = "timing-locked@example.invalid";
    await createTestUser(existing);
    const lockedId = await createTestUser(locked);
    await bootstrapDatabase
      .updateTable("users")
      .set({ locked_until: new Date(Date.now() + 60_000), failed_login_attempts: 3 })
      .where("id", "=", lockedId)
      .execute();
    const samples: Record<string, number[]> = { existing: [], missing: [], locked: [] };
    for (let sample = 0; sample < 6; sample += 1) {
      for (const [kind, email] of [
        ["existing", existing],
        ["missing", "timing-missing@example.invalid"],
        ["locked", locked],
      ] as const) {
        const start = performance.now();
        const response = await httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: `127.11.0.${sample + 1}`,
          headers: { origin: "http://localhost:5173" },
          payload: { email, password: "wrong-password1" },
        });
        samples[kind]!.push(Math.round(performance.now() - start));
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
      }
    }
    console.info(JSON.stringify({ measurement: "login-rejection-timing", samples }));
  });

  it("rotates CSRF and logs out idempotently while clearing both cookies", async () => {
    const email = "logout-csrf@example.com";
    await authService.signUp(await createCommand(email), "127.0.0.63");
    const account = await bootstrapDatabase
      .selectFrom("users")
      .select("email_verified_at")
      .where("email_normalized", "=", email)
      .executeTakeFirstOrThrow();
    expect(account.email_verified_at).toBeNull();
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const oldCsrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${oldCsrfToken}`;

    const refreshed = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/csrf-token",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        origin: "http://localhost:5173",
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toEqual({ csrf_refreshed: true });
    const newCsrfToken = rawCookie(responseCookies(refreshed.headers), CSRF_COOKIE_NAME);
    expect(newCsrfToken).not.toBe(oldCsrfToken);

    const stored = await bootstrapDatabase
      .selectFrom("sessions")
      .select("csrf_token_hash")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(stored.csrf_token_hash).toEqual(hashSessionSecret(newCsrfToken));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/csrf-token",
        headers: { cookie: cookieHeader, origin: "http://localhost:5173" },
      });
      expect(response.statusCode).toBe(200);
    }
    const beforeLimited = await bootstrapDatabase
      .selectFrom("sessions")
      .select("csrf_token_hash")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    const limited = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/csrf-token",
      headers: { cookie: cookieHeader, origin: "http://localhost:5173" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/u);
    const afterLimited = await bootstrapDatabase
      .selectFrom("sessions")
      .select("csrf_token_hash")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(afterLimited.csrf_token_hash).toEqual(beforeLimited.csrf_token_hash);

    const activeLogout = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: cookieHeader, origin: "http://localhost:5173" },
    });
    const replayedLogout = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: cookieHeader, origin: "http://localhost:5173" },
    });
    const noCookieLogout = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: "http://localhost:5173" },
    });

    for (const logout of [activeLogout, replayedLogout, noCookieLogout]) {
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ logged_out: true });
      expect(responseCookies(logout.headers)).toEqual([
        expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
        expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
      ]);
    }
    const activeLogoutEvents = await waitForSecurityEventsForRequest(
      String(activeLogout.headers["x-request-id"]),
    );
    expect(activeLogoutEvents).toEqual([
      expect.objectContaining({
        action: "auth.logout",
        actor_user_id: await getUserId(email),
        deny_reason: null,
        resource: "session",
        sanitized_path: "/api/v1/auth/logout",
      }),
    ]);
    await expectNoSecurityEventsForRequest(String(replayedLogout.headers["x-request-id"]));
    await expectNoSecurityEventsForRequest(String(noCookieLogout.headers["x-request-id"]));

    const session = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(session.revoked_at).not.toBeNull();
  }, 30_000);
});

describe("logged-in password change integration", () => {
  it("requires current credentials, updates the hash, clears cookies, and revokes every session", async () => {
    const email = "password-change-student@example.com";
    const newPassword = "Change45";
    const userId = await createTestUser(email);
    const beforeAccount = await bootstrapDatabase
      .selectFrom("users")
      .select(["password_hash", "password_last_changed_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    const logins = await Promise.all(
      Array.from({ length: 2 }, () =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { origin: "http://localhost:5173" },
          payload: { email, password: baseCommand.password },
        }),
      ),
    );
    expect(logins.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    const firstCookies = responseCookies(logins[0]!.headers);
    const firstSession = rawCookie(firstCookies, SESSION_COOKIE_NAME);
    const firstCsrf = rawCookie(firstCookies, CSRF_COOKIE_NAME);
    const firstCookieHeader = `${SESSION_COOKIE_NAME}=${firstSession}; ${CSRF_COOKIE_NAME}=${firstCsrf}`;

    const missingCsrf = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/account/password",
      headers: { cookie: firstCookieHeader, origin: "http://localhost:5173" },
      payload: { current_password: baseCommand.password, new_password: newPassword },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const wrongCurrent = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/account/password",
      headers: {
        cookie: firstCookieHeader,
        origin: "http://localhost:5173",
        "x-csrf-token": firstCsrf,
      },
      payload: { current_password: "wrong-password", new_password: newPassword },
    });
    expect(wrongCurrent.statusCode).toBe(401);
    expect(wrongCurrent.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS", message: "현재 비밀번호가 올바르지 않습니다." },
    });

    const afterWrong = await bootstrapDatabase
      .selectFrom("users")
      .select(["password_hash", "password_last_changed_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const activeAfterWrong = await bootstrapDatabase
      .selectFrom("sessions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(afterWrong).toEqual(beforeAccount);
    expect(activeAfterWrong.count).toBe("2");

    const changed = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/account/password",
      headers: {
        cookie: firstCookieHeader,
        origin: "http://localhost:5173",
        "x-csrf-token": firstCsrf,
      },
      payload: { current_password: baseCommand.password, new_password: newPassword },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ next_action: "LOGIN", password_changed: true });
    expect(responseCookies(changed.headers)).toEqual([
      expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
      expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
    ]);

    const [afterAccount, sessions] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["password_hash", "password_last_changed_at"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("user_id", "=", userId)
        .execute(),
    ]);
    expect(afterAccount.password_hash).not.toBe(beforeAccount.password_hash);
    expect(afterAccount.password_last_changed_at.getTime()).toBeGreaterThanOrEqual(
      beforeAccount.password_last_changed_at.getTime(),
    );
    expect(sessions).toHaveLength(2);
    expect(sessions.every(({ revoked_at }) => revoked_at instanceof Date)).toBe(true);

    const oldSession = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: firstCookieHeader },
    });
    expect(oldSession.statusCode).toBe(401);
    const oldPasswordLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);
    const newPasswordLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: newPassword },
    });
    expect(newPasswordLogin.statusCode).toBe(200);
  }, 30_000);

  it("clears the teacher temporary-password gate in the password transaction", async () => {
    const email = "password-change-teacher@example.com";
    const newPassword = "Teach456";
    const operator = await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256").update("password-change-operator").digest(),
        email_normalized: "password-change-operator@classhub.local",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const teacherId = await createTestUser(email);
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: operator.id,
        temporary_password_expires_at: new Date(Date.now() + 60 * 60 * 1_000),
        temporary_password_must_change: true,
        user_id: teacherId,
      })
      .execute();

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;
    const before = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      destination: "CHANGE_TEMPORARY_PASSWORD",
      teacher_profile: { temporary_password_must_change: true },
    });

    const changed = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/account/password",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
      payload: { current_password: baseCommand.password, new_password: newPassword },
    });
    expect(changed.statusCode).toBe(200);

    const profile = await bootstrapDatabase
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", teacherId)
      .executeTakeFirstOrThrow();
    expect(profile).toEqual({
      temporary_password_expires_at: null,
      temporary_password_must_change: false,
    });

    const relogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: newPassword },
    });
    const reloginSession = rawCookie(responseCookies(relogin.headers), SESSION_COOKIE_NAME);
    const after = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${reloginSession}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      destination: "CREATE_CLASS",
      teacher_profile: { temporary_password_must_change: false },
    });
  }, 30_000);

  it("limits current-password failures by user and client IP without mutating account state", async () => {
    const email = "password-change-limited@example.com";
    const userId = await createTestUser(email);
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;
    const before = await bootstrapDatabase
      .selectFrom("users")
      .select(["password_hash", "password_last_changed_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await httpApplication.inject({
        method: "PATCH",
        url: "/api/v1/account/password",
        headers: {
          cookie,
          origin: "http://localhost:5173",
          "x-csrf-token": csrfToken,
        },
        payload: { current_password: "wrong-password", new_password: "Unused45" },
      });
      expect(failed.statusCode, `attempt ${attempt + 1}`).toBe(401);
    }

    const limited = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/account/password",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
      payload: { current_password: "wrong-password", new_password: "Unused45" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/u);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    const [after, session] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["password_hash", "password_last_changed_at"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("session_hash", "=", hashSessionSecret(sessionToken))
        .executeTakeFirstOrThrow(),
    ]);
    expect(after).toEqual(before);
    expect(session.revoked_at).toBeNull();
  }, 40_000);

  it("rolls back safely when Redis fails while recording a bad current password", async () => {
    const email = "password-change-redis-unavailable@example.com";
    const userId = await createTestUser(email);
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const sessionToken = rawCookie(responseCookies(login.headers), SESSION_COOKIE_NAME);
    const session = await bootstrapDatabase
      .selectFrom("sessions")
      .select(["id", "revoked_at"])
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    const before = await bootstrapDatabase
      .selectFrom("users")
      .select(["password_hash", "password_last_changed_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const unavailableLimiter = {
      consume: () => Promise.reject(new RateLimitServiceUnavailableException()),
      ensureAvailable: () => Promise.resolve(),
    } as unknown as RedisRateLimiter;
    const service = new AccountService(
      applicationDatabase,
      unavailableLimiter,
      authConfig,
      securityAuditPublisher,
    );

    await expect(
      service.changePassword({
        clientIp: "127.0.0.81",
        currentPassword: "wrong-password",
        newPassword: "Unused78",
        sessionId: session.id,
        userId,
      }),
    ).rejects.toBeInstanceOf(RateLimitServiceUnavailableException);

    const [after, afterSession] = await Promise.all([
      bootstrapDatabase
        .selectFrom("users")
        .select(["password_hash", "password_last_changed_at"])
        .where("id", "=", userId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("sessions")
        .select("revoked_at")
        .where("id", "=", session.id)
        .executeTakeFirstOrThrow(),
    ]);
    expect(after).toEqual(before);
    expect(afterSession.revoked_at).toBeNull();
  }, 30_000);
});

describe("membership request integration", () => {
  let fixture: Awaited<ReturnType<typeof createActiveClassFixture>>;
  let membershipService: MembershipService;
  let membersService: MembersService;
  let homeService: HomeService;

  beforeAll(async () => {
    fixture = await createActiveClassFixture();
    membershipService = httpApplication.get(MembershipService);
    membersService = httpApplication.get(MembersService);
    homeService = httpApplication.get(HomeService);
  });

  it("audits valid-session bad Origin and one concurrent logout winner only", async () => {
    const teacherEmail = "membership-teacher@example.com";
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: teacherEmail, password: baseCommand.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const loginCookies = responseCookies(login.headers);
    const sessionToken = rawCookie(loginCookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(loginCookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;
    const invalidOrigin = "https://attacker.invalid";
    const invalidCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: {
        cookie,
        "idempotency-key": randomUUID(),
        origin: "http://localhost:5173",
        "x-csrf-token": "invalid",
      },
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });
    const invalidCsrfEvents = await waitForSecurityEventsForRequest(
      String(invalidCsrf.headers["x-request-id"]),
    );
    expect(invalidCsrfEvents).toEqual([
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_class_id: fixture.classId,
        actor_user_id: fixture.teacherId,
        deny_reason: "csrf_header_invalid",
        sanitized_path: "/api/v1/classes/current/invite-code/rotate",
        target_class_id: fixture.classId,
      }),
    ]);

    const [badOriginLogout, badOriginCsrf] = await Promise.all([
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { cookie, origin: invalidOrigin },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/csrf-token",
        headers: { cookie, origin: invalidOrigin },
      }),
    ]);
    for (const response of [badOriginLogout, badOriginCsrf]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const badOriginRequestIds = [badOriginLogout, badOriginCsrf].map((response) =>
      String(response.headers["x-request-id"]),
    );
    const badOriginEvents = await waitForSecurityEventsForRequests(badOriginRequestIds, 2);
    expect(badOriginEvents).toHaveLength(2);
    for (const event of badOriginEvents) {
      expect(event).toMatchObject({
        action: "auth.csrf_failed",
        actor_class_id: null,
        actor_ip: "127.0.0.1",
        actor_user_id: null,
        deny_reason: "origin_invalid",
        resource: "request",
        target_class_id: null,
      });
    }
    expect(new Set(badOriginEvents.map((event) => event.sanitized_path))).toEqual(
      new Set(["/api/v1/auth/logout", "/api/v1/auth/csrf-token"]),
    );
    const serializedBadOriginEvents = JSON.stringify(badOriginEvents);
    expect(serializedBadOriginEvents).not.toContain(teacherEmail);
    expect(serializedBadOriginEvents).not.toContain(baseCommand.password);
    expect(serializedBadOriginEvents).not.toContain(sessionToken);
    expect(serializedBadOriginEvents).not.toContain(csrfToken);

    const afterBadOrigin = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(afterBadOrigin.revoked_at).toBeNull();

    const beforeVerificationState = await bootstrapDatabase
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", fixture.teacherId)
      .executeTakeFirstOrThrow();
    expect(beforeVerificationState.email_verified_at).not.toBeNull();
    await bootstrapDatabase
      .updateTable("users")
      .set({ email_verified_at: null })
      .where("id", "=", fixture.teacherId)
      .execute();
    try {
      const emailDenied = await httpApplication.inject({
        method: "GET",
        url: "/api/v1/home",
        headers: { cookie },
      });
      expect(emailDenied.statusCode).toBe(403);
      expect(emailDenied.json()).toMatchObject({ error: { code: "EMAIL_NOT_VERIFIED" } });
      const emailDeniedEvents = await waitForSecurityEventsForRequest(
        String(emailDenied.headers["x-request-id"]),
      );
      expect(emailDeniedEvents).toEqual([
        expect.objectContaining({
          action: "authz.denied",
          actor_class_id: fixture.classId,
          actor_user_id: fixture.teacherId,
          deny_reason: "email_not_verified",
          sanitized_path: "/api/v1/home",
          target_class_id: fixture.classId,
        }),
      ]);
    } finally {
      await bootstrapDatabase
        .updateTable("users")
        .set({ email_verified_at: beforeVerificationState.email_verified_at })
        .where("id", "=", fixture.teacherId)
        .execute();
    }

    const beforeTeacherProfile = await bootstrapDatabase
      .selectFrom("teacher_profiles")
      .select(["temporary_password_expires_at", "temporary_password_must_change"])
      .where("user_id", "=", fixture.teacherId)
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        temporary_password_must_change: true,
      })
      .where("user_id", "=", fixture.teacherId)
      .execute();
    try {
      const mealDenied = await httpApplication.inject({
        method: "GET",
        url: "/api/v1/meals/today",
        headers: { cookie },
      });
      expect(mealDenied.statusCode).toBe(403);
      expect(mealDenied.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });
      const mealDeniedEvents = await waitForSecurityEventsForRequest(
        String(mealDenied.headers["x-request-id"]),
      );
      expect(mealDeniedEvents).toEqual([
        expect.objectContaining({
          action: "authz.denied",
          actor_class_id: fixture.classId,
          actor_user_id: fixture.teacherId,
          deny_reason: "role_insufficient",
          sanitized_path: "/api/v1/meals/today",
          target_class_id: fixture.classId,
        }),
      ]);
    } finally {
      await bootstrapDatabase
        .updateTable("teacher_profiles")
        .set({
          temporary_password_expires_at: beforeTeacherProfile.temporary_password_expires_at,
          temporary_password_must_change: beforeTeacherProfile.temporary_password_must_change,
        })
        .where("user_id", "=", fixture.teacherId)
        .execute();
    }

    const revokedLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: teacherEmail, password: baseCommand.password },
    });
    expect(revokedLogin.statusCode, revokedLogin.body).toBe(200);
    const revokedSessionToken = rawCookie(
      responseCookies(revokedLogin.headers),
      SESSION_COOKIE_NAME,
    );
    await bootstrapDatabase
      .updateTable("sessions")
      .set({ revoked_at: new Date() })
      .where("session_hash", "=", hashSessionSecret(revokedSessionToken))
      .execute();

    const sessionService = httpApplication.get(SessionService);
    const lookupFailure = vi
      .spyOn(sessionService, "resolveSecurityAuditIdentity")
      .mockRejectedValueOnce(new Error("postgresql://user:password@db/private"));
    let lookupFailureResponse;
    try {
      lookupFailureResponse = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { cookie, origin: invalidOrigin },
      });
    } finally {
      lookupFailure.mockRestore();
    }
    expect(lookupFailureResponse.statusCode).toBe(403);
    expect(lookupFailureResponse.json()).toMatchObject({
      error: { code: "ORIGIN_NOT_ALLOWED" },
    });

    const randomSessionToken = "z".repeat(43);
    const identitylessResponses = await Promise.all([
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { origin: invalidOrigin },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/csrf-token",
        headers: { origin: invalidOrigin },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${randomSessionToken}`,
          origin: invalidOrigin,
        },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/csrf-token",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${randomSessionToken}`,
          origin: invalidOrigin,
        },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${revokedSessionToken}`,
          origin: invalidOrigin,
        },
      }),
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/csrf-token",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${revokedSessionToken}`,
          origin: invalidOrigin,
        },
      }),
    ]);
    for (const response of identitylessResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    }
    const noEventRequestIds = [lookupFailureResponse, ...identitylessResponses].map((response) =>
      String(response.headers["x-request-id"]),
    );
    await delay(1_100);
    const noEvents = (
      await Promise.all(noEventRequestIds.map((requestId) => securityEventsForRequest(requestId)))
    ).flat();
    expect(noEvents).toEqual([]);

    const concurrentLogouts = await Promise.all(
      Array.from({ length: 8 }, () =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: { cookie, origin: "http://localhost:5173" },
        }),
      ),
    );
    for (const response of concurrentLogouts) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ logged_out: true });
      expect(responseCookies(response.headers)).toEqual([
        expect.stringContaining(`${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`),
        expect.stringContaining(`${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0`),
      ]);
    }
    const logoutRequestIds = concurrentLogouts.map((response) =>
      String(response.headers["x-request-id"]),
    );
    await waitForSecurityEventsForRequests(logoutRequestIds);
    await delay(1_100);
    const logoutEvents = (
      await Promise.all(logoutRequestIds.map((requestId) => securityEventsForRequest(requestId)))
    ).flat();
    expect(logoutEvents).toEqual([
      expect.objectContaining({
        action: "auth.logout",
        actor_class_id: fixture.classId,
        actor_user_id: fixture.teacherId,
        deny_reason: null,
        resource: "session",
        sanitized_path: "/api/v1/auth/logout",
        target_class_id: null,
      }),
    ]);
    const finalSession = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("session_hash", "=", hashSessionSecret(sessionToken))
      .executeTakeFirstOrThrow();
    expect(finalSession.revoked_at).not.toBeNull();
  }, 30_000);

  it("requires authenticated CSRF and atomically creates pending history and audit", async () => {
    const email = "membership-http-student@example.com";
    await createTestUser(email);
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    const missingOrigin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { invite_code: fixture.inviteCode },
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    const originEvents = await waitForSecurityEventsForRequest(
      String(missingOrigin.headers["x-request-id"]),
    );
    expect(originEvents).toEqual([
      expect.objectContaining({
        action: "auth.csrf_failed",
        actor_class_id: null,
        actor_ip: "127.0.0.1",
        actor_user_id: null,
        target_class_id: null,
        deny_reason: "origin_invalid",
        resource: "request",
        sanitized_path: "/api/v1/membership-requests",
      }),
    ]);
    expect(JSON.stringify(originEvents)).not.toContain(sessionToken);
    expect(JSON.stringify(originEvents)).not.toContain(csrfToken);

    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests",
      headers: { cookie, origin: "http://localhost:5173" },
      payload: { invite_code: fixture.inviteCode },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const mismatchedCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": "X".repeat(43),
      },
      payload: { invite_code: fixture.inviteCode },
    });
    expect(mismatchedCsrf.statusCode).toBe(403);
    expect(mismatchedCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const created = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
      payload: { invite_code: ` ${fixture.inviteCode.toLowerCase()} ` },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      class_id: fixture.classId,
      next_action: "BOOTSTRAP",
      row_version: "1",
      status: "pending",
    });

    const memberId = created.json().membership_id as string;
    const [member, history, audit] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["class_id", "role", "row_version", "status"])
        .where("id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["actor_member_id", "actor_user_id", "from_status", "to_status"])
        .where("member_id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "action",
          "actor_member_id",
          "after_json",
          "before_json",
          "request_id",
          "target_id",
          "target_snapshot",
        ])
        .where("action", "=", "member.requested")
        .where("target_id", "=", memberId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(member).toEqual({
      class_id: fixture.classId,
      role: "student",
      row_version: "1",
      status: "pending",
    });
    expect(history).toMatchObject({
      actor_member_id: null,
      from_status: null,
      to_status: "pending",
    });
    expect(history.actor_user_id).toBe(await getUserId(email));
    expect(audit).toMatchObject({
      action: "member.requested",
      actor_member_id: null,
      after_json: expect.objectContaining({ member_id: memberId, status: "pending" }),
      before_json: null,
      request_id: created.headers["x-request-id"],
      target_id: memberId,
      target_snapshot: null,
    });

    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      current_class: {
        id: fixture.classId,
        school_address: "서울특별시 테스트구 학교로 1 (테스트동)",
        school_homepage_url: "https://school.example.com/",
        school_name: "테스트 중학교",
        school_phone_number: "02-1234-5678",
        status: "active",
      },
      current_membership: { id: memberId, role: "student", status: "pending" },
      destination: "MEMBERSHIP_PENDING",
    });
  });

  it("checks global request eligibility before resolving invite validity", async () => {
    const currentUserId = await createTestUser("membership-oracle-current@example.com");
    const currentMemberId = await insertStudentMembership(fixture, currentUserId, "pending");
    const currentBefore = await bootstrapDatabase
      .selectFrom("class_members")
      .select(["row_version", "status"])
      .where("id", "=", currentMemberId)
      .executeTakeFirstOrThrow();
    const historyBefore = await bootstrapDatabase
      .selectFrom("class_member_status_history")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("member_id", "=", currentMemberId)
      .executeTakeFirstOrThrow();
    const rejectedRequestIds: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestId = randomUUID();
      rejectedRequestIds.push(requestId);
      await expect(
        membershipService.createRequest({
          clientIp: `127.0.1.${attempt + 1}`,
          inviteCode: fixture.inviteCode,
          requestId,
          userId: currentUserId,
        }),
      ).rejects.toBeInstanceOf(CurrentMembershipExistsException);
    }

    const currentInvalidRequestId = randomUUID();
    rejectedRequestIds.push(currentInvalidRequestId);
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.1.5",
        inviteCode: "BCDEFGHJ",
        requestId: currentInvalidRequestId,
        userId: currentUserId,
      }),
    ).rejects.toBeInstanceOf(CurrentMembershipExistsException);

    // After the third request, neither valid nor invalid invites bypass P-018.
    for (const inviteCode of [fixture.inviteCode, "BCDEFGHJ"]) {
      const requestId = randomUUID();
      rejectedRequestIds.push(requestId);
      await expect(
        membershipService.createRequest({
          clientIp: "127.0.1.8",
          inviteCode,
          requestId,
          userId: currentUserId,
        }),
      ).rejects.toBeInstanceOf(RateLimitedException);
    }

    const unverifiedUserId = await createTestUser(
      "membership-oracle-unverified@example.com",
      false,
    );
    const unverifiedRequestId = randomUUID();
    rejectedRequestIds.push(unverifiedRequestId);
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.1.6",
        inviteCode: "BCDEFGHJ",
        requestId: unverifiedRequestId,
        userId: unverifiedUserId,
      }),
    ).rejects.toBeInstanceOf(EmailNotVerifiedException);

    const teacherUserId = await createTeacherWithoutClass(
      "membership-oracle-teacher@example.com",
      fixture.operatorId,
    );
    const teacherRequestId = randomUUID();
    rejectedRequestIds.push(teacherRequestId);
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.1.7",
        inviteCode: "BCDEFGHJ",
        requestId: teacherRequestId,
        userId: teacherUserId,
      }),
    ).rejects.toBeInstanceOf(MembershipRequestNotAllowedException);

    const [currentAfter, historyAfter, ineligibleMembers, rejectedAudits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["row_version", "status"])
        .where("id", "=", currentMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("member_id", "=", currentMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("user_id", "in", [unverifiedUserId, teacherUserId])
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("request_id", "in", rejectedRequestIds)
        .executeTakeFirstOrThrow(),
    ]);
    expect(currentAfter).toEqual(currentBefore);
    expect(historyAfter.count).toBe(historyBefore.count);
    expect(ineligibleMembers.count).toBe("0");
    expect(rejectedAudits.count).toBe("0");
  });

  it("enforces current, rejoin, teacher, verification, and invite-code state rules", async () => {
    const concurrentUserId = await createTestUser("membership-concurrent@example.com");
    const concurrent = await Promise.allSettled([
      membershipService.createRequest({
        clientIp: "127.0.0.81",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: concurrentUserId,
      }),
      membershipService.createRequest({
        clientIp: "127.0.0.82",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: concurrentUserId,
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const concurrentFailure = concurrent.find((result) => result.status === "rejected");
    expect(concurrentFailure).toMatchObject({
      reason: expect.any(CurrentMembershipExistsException),
    });

    const canceledUserId = await createTestUser("membership-canceled@example.com");
    const canceledMemberId = await insertStudentMembership(fixture, canceledUserId, "canceled");
    const reused = await membershipService.createRequest({
      clientIp: "127.0.0.83",
      inviteCode: fixture.inviteCode,
      requestId: randomUUID(),
      userId: canceledUserId,
    });
    expect(reused).toMatchObject({
      membership_id: canceledMemberId,
      row_version: "2",
      status: "pending",
    });
    const reusedMember = await bootstrapDatabase
      .selectFrom("class_members")
      .select(["row_version", "status"])
      .where("id", "=", canceledMemberId)
      .executeTakeFirstOrThrow();
    expect(reusedMember).toEqual({ row_version: "2", status: "pending" });
    const reusedAudit = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select(["after_json", "before_json", "target_snapshot"])
      .where("action", "=", "member.requested")
      .where("target_id", "=", canceledMemberId)
      .executeTakeFirstOrThrow();
    expect(reusedAudit).toMatchObject({
      after_json: expect.objectContaining({ status: "pending" }),
      before_json: expect.objectContaining({ status: "canceled" }),
      target_snapshot: null,
    });

    const removedUserId = await createTestUser("membership-removed@example.com");
    const removedMemberId = await insertStudentMembership(fixture, removedUserId, "removed");
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.84",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: removedUserId,
      }),
    ).resolves.toMatchObject({
      membership_id: removedMemberId,
      row_version: "2",
      status: "pending",
    });
    expect(
      await bootstrapDatabase
        .selectFrom("class_members")
        .select("status")
        .where("id", "=", removedMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending" });
    expect(
      await bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["from_status", "to_status"])
        .where("member_id", "=", removedMemberId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(),
    ).toEqual({ from_status: "removed", to_status: "pending" });

    const unverifiedUserId = await createTestUser("membership-unverified@example.com", false);
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.85",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: unverifiedUserId,
      }),
    ).rejects.toBeInstanceOf(EmailNotVerifiedException);

    const teacherUserId = await createTestUser("membership-profile@example.com");
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        created_by_operator_id: fixture.operatorId,
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
        user_id: teacherUserId,
      })
      .execute();
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.86",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: teacherUserId,
      }),
    ).rejects.toBeInstanceOf(MembershipRequestNotAllowedException);

    const invalidCodeUserId = await createTestUser("membership-invalid-code@example.com");
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.87",
        inviteCode: "BCDEFGHJ",
        requestId: randomUUID(),
        userId: invalidCodeUserId,
      }),
    ).rejects.toBeInstanceOf(InvalidInviteCodeException);

    for (let attempt = 0; attempt < 1; attempt += 1) {
      await expect(
        membershipService.createRequest({
          clientIp: "127.0.0.88",
          inviteCode: "BCDEFGHJ",
          requestId: randomUUID(),
          userId: invalidCodeUserId,
        }),
      ).rejects.toBeInstanceOf(InvalidInviteCodeException);
    }
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.88",
        inviteCode: "BCDEFGHJ",
        requestId: randomUUID(),
        userId: invalidCodeUserId,
      }),
    ).rejects.toBeInstanceOf(RateLimitedException);

    const accountLimitedUserId = await createTestUser("membership-account-limit@example.com");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = await membershipService.createRequest({
        clientIp: "127.0.0.89",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: accountLimitedUserId,
      });
      expect(created.status).toBe("pending");
      const canceled = await membershipService.cancelCurrentRequest({
        requestId: randomUUID(),
        userId: accountLimitedUserId,
      });
      expect(canceled.status).toBe("canceled");
    }
    await expect(
      membershipService.createRequest({
        clientIp: "127.0.0.89",
        inviteCode: fixture.inviteCode,
        requestId: randomUUID(),
        userId: accountLimitedUserId,
      }),
    ).rejects.toBeInstanceOf(RateLimitedException);

    const unavailableUserId = await createTestUser("membership-redis-unavailable@example.com");
    const unavailableLimiter = createRedisRateLimiter("redis://127.0.0.1:1");
    const unavailableService = new MembershipService(
      applicationDatabase,
      unavailableLimiter,
      authConfig,
    );
    try {
      await expect(
        unavailableService.createRequest({
          clientIp: "127.0.0.90",
          inviteCode: fixture.inviteCode,
          requestId: randomUUID(),
          userId: unavailableUserId,
        }),
      ).rejects.toBeInstanceOf(RateLimitServiceUnavailableException);
    } finally {
      await unavailableLimiter.close();
    }
    const unavailableMembership = await bootstrapDatabase
      .selectFrom("class_members")
      .select("id")
      .where("user_id", "=", unavailableUserId)
      .executeTakeFirst();
    expect(unavailableMembership).toBeUndefined();
  }, 30_000);

  it("lets a pending student cancel with CSRF, history, audit, and immediate bootstrap release", async () => {
    const email = "membership-self-cancel@example.com";
    const userId = await createTestUser(email);
    const memberId = await insertStudentMembership(fixture, userId, "pending");
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests/current/cancel",
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const canceled = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests/current/cancel",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({
      membership_id: memberId,
      next_action: "BOOTSTRAP",
      row_version: "2",
      status: "canceled",
    });

    const [member, history, audit] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["row_version", "status"])
        .where("id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select([
          "actor_member_id",
          "actor_operator_id",
          "actor_user_id",
          "from_status",
          "to_status",
        ])
        .where("member_id", "=", memberId)
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "actor_member_id",
          "actor_user_id",
          "after_json",
          "before_json",
          "request_id",
          "target_snapshot",
        ])
        .where("action", "=", "member.request_canceled")
        .where("target_id", "=", memberId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(member).toEqual({ row_version: "2", status: "canceled" });
    expect(history).toMatchObject({
      actor_member_id: null,
      actor_operator_id: null,
      actor_user_id: userId,
      from_status: "pending",
      to_status: "canceled",
    });
    expect(audit).toMatchObject({
      actor_member_id: null,
      actor_user_id: userId,
      after_json: expect.objectContaining({ status: "canceled" }),
      before_json: expect.objectContaining({ status: "pending" }),
      request_id: canceled.headers["x-request-id"],
      target_snapshot: null,
    });

    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      current_membership: null,
      destination: "ENTER_INVITE_CODE",
      last_membership_status: "canceled",
    });

    const repeated = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/membership-requests/current/cancel",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: { code: "MEMBERSHIP_STATUS_CHANGED" } });
  }, 30_000);

  it("lets an approved student leave, releases the student number, and blocks teacher self-leave", async () => {
    const email = "membership-self-leave@example.com";
    const userId = await createTestUser(email);
    const memberId = await insertStudentMembership(fixture, userId, "pending");
    await membersService.approve({
      actorUserId: fixture.teacherId,
      displayNameInClass: null,
      memberId,
      requestId: randomUUID(),
      studentNumber: 5,
    });
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrfToken = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    const left = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/memberships/current/leave",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrfToken,
      },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json()).toMatchObject({
      membership_id: memberId,
      next_action: "BOOTSTRAP",
      row_version: "3",
      status: "left",
    });

    const [member, history, audit] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["row_version", "status", "student_number"])
        .where("id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select([
          "actor_member_id",
          "actor_operator_id",
          "actor_user_id",
          "from_status",
          "to_status",
        ])
        .where("member_id", "=", memberId)
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "actor_member_id",
          "actor_user_id",
          "after_json",
          "before_json",
          "request_id",
          "target_snapshot",
        ])
        .where("action", "=", "member.left")
        .where("target_id", "=", memberId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(member).toEqual({ row_version: "3", status: "left", student_number: null });
    expect(history).toMatchObject({
      actor_member_id: memberId,
      actor_operator_id: null,
      actor_user_id: userId,
      from_status: "approved",
      to_status: "left",
    });
    expect(audit).toMatchObject({
      actor_member_id: memberId,
      actor_user_id: userId,
      after_json: expect.objectContaining({ status: "left" }),
      before_json: expect.objectContaining({ status: "approved" }),
      request_id: left.headers["x-request-id"],
      target_snapshot: null,
    });

    const replacementUserId = await createTestUser("membership-number-reuse@example.com");
    const replacementMemberId = await insertStudentMembership(
      fixture,
      replacementUserId,
      "pending",
    );
    await expect(
      membersService.approve({
        actorUserId: fixture.teacherId,
        displayNameInClass: null,
        memberId: replacementMemberId,
        requestId: randomUUID(),
        studentNumber: 5,
      }),
    ).resolves.toMatchObject({ member: { student_number: 5 } });

    await expect(
      membershipService.leaveCurrentMembership({
        requestId: randomUUID(),
        userId: fixture.teacherId,
      }),
    ).rejects.toBeInstanceOf(MembershipStatusChangedException);
    const teacherMember = await bootstrapDatabase
      .selectFrom("class_members")
      .select(["role", "status"])
      .where("id", "=", fixture.teacherMemberId)
      .executeTakeFirstOrThrow();
    expect(teacherMember).toEqual({ role: "teacher", status: "approved" });
  }, 30_000);

  it("allows pending cancel and approved self-leave while the class is suspended", async () => {
    const pendingUserId = await createTestUser("suspended-self-cancel@example.com");
    const pendingMemberId = await insertStudentMembership(fixture, pendingUserId, "pending");
    const approvedUserId = await createTestUser("suspended-self-leave@example.com");
    const approvedMemberId = await insertStudentMembership(fixture, approvedUserId, "pending");
    await membersService.approve({
      actorUserId: fixture.teacherId,
      displayNameInClass: null,
      memberId: approvedMemberId,
      requestId: randomUUID(),
      studentNumber: null,
    });

    await bootstrapDatabase
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: new Date(),
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "격리 테스트",
      })
      .where("id", "=", fixture.classId)
      .execute();
    try {
      await expect(
        membershipService.cancelCurrentRequest({
          requestId: randomUUID(),
          userId: pendingUserId,
        }),
      ).resolves.toMatchObject({ membership_id: pendingMemberId, status: "canceled" });
      await expect(
        membershipService.leaveCurrentMembership({
          requestId: randomUUID(),
          userId: approvedUserId,
        }),
      ).resolves.toMatchObject({ membership_id: approvedMemberId, status: "left" });
    } finally {
      await bootstrapDatabase
        .updateTable("classes")
        .set({
          status: "active",
          suspended_at: null,
          suspended_by_operator_id: null,
          suspended_reason: null,
        })
        .where("id", "=", fixture.classId)
        .execute();
    }
  }, 30_000);

  it("lists masked pending students and approves one with history, audit, and HOME bootstrap", async () => {
    const studentEmail = "member-approval-student@example.com";
    const studentUserId = await createTestUser(studentEmail);
    const studentMemberId = await insertStudentMembership(fixture, studentUserId, "pending");
    const teacherLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "membership-teacher@example.com", password: baseCommand.password },
    });
    expect(teacherLogin.statusCode).toBe(200);
    const teacherCookies = responseCookies(teacherLogin.headers);
    const teacherSession = rawCookie(teacherCookies, SESSION_COOKIE_NAME);
    const teacherCsrf = rawCookie(teacherCookies, CSRF_COOKIE_NAME);
    const teacherCookie = `${SESSION_COOKIE_NAME}=${teacherSession}; ${CSRF_COOKIE_NAME}=${teacherCsrf}`;

    const listed = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/members?status=pending",
      headers: { cookie: teacherCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_state: "active",
          email_masked: "me***@example.com",
          id: studentMemberId,
          requested_at: expect.any(String),
          row_version: "1",
          status: "pending",
        }),
      ]),
    );

    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: `/api/v1/members/${studentMemberId}/approve`,
      headers: { cookie: teacherCookie, origin: "http://localhost:5173" },
      payload: { display_name_in_class: null, student_number: 7 },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const approved = await httpApplication.inject({
      method: "POST",
      url: `/api/v1/members/${studentMemberId}/approve`,
      headers: {
        cookie: teacherCookie,
        origin: "http://localhost:5173",
        "x-csrf-token": teacherCsrf,
      },
      payload: { display_name_in_class: "승인 학생", student_number: 7 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      member: {
        display_name: "승인 학생",
        id: studentMemberId,
        row_version: "2",
        status: "approved",
        student_number: 7,
      },
      warnings: [],
    });

    const [member, history, audit] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["display_name_in_class", "row_version", "status", "student_number"])
        .where("id", "=", studentMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["actor_member_id", "actor_user_id", "from_status", "to_status"])
        .where("member_id", "=", studentMemberId)
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "action",
          "actor_member_id",
          "after_json",
          "before_json",
          "request_id",
          "target_id",
          "target_snapshot",
        ])
        .where("action", "=", "member.approved")
        .where("target_id", "=", studentMemberId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(member).toEqual({
      display_name_in_class: "승인 학생",
      row_version: "2",
      status: "approved",
      student_number: 7,
    });
    expect(history).toMatchObject({
      actor_member_id: fixture.teacherMemberId,
      actor_user_id: fixture.teacherId,
      from_status: "pending",
      to_status: "approved",
    });
    expect(audit).toMatchObject({
      action: "member.approved",
      actor_member_id: fixture.teacherMemberId,
      after_json: expect.objectContaining({ status: "approved" }),
      before_json: expect.objectContaining({ status: "pending" }),
      request_id: approved.headers["x-request-id"],
      target_id: studentMemberId,
      target_snapshot: null,
    });

    const studentLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: studentEmail, password: baseCommand.password },
    });
    const studentSession = rawCookie(responseCookies(studentLogin.headers), SESSION_COOKIE_NAME);
    const studentBootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${studentSession}` },
    });
    expect(studentBootstrap.statusCode).toBe(200);
    expect(studentBootstrap.json()).toMatchObject({
      current_membership: { id: studentMemberId, role: "student", status: "approved" },
      destination: "HOME",
    });
  }, 30_000);

  it("rejects an inactive pending account without changing member, history, or audit", async () => {
    const userId = await createTestUser("member-inactive-pending@example.com");
    const memberId = await insertStudentMembership(fixture, userId, "pending");
    await bootstrapDatabase
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", userId)
      .execute();
    const beforeHistory = await bootstrapDatabase
      .selectFrom("class_member_status_history")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("member_id", "=", memberId)
      .executeTakeFirstOrThrow();

    await expect(
      membersService.approve({
        actorUserId: fixture.teacherId,
        displayNameInClass: null,
        memberId,
        requestId: randomUUID(),
        studentNumber: null,
      }),
    ).rejects.toBeInstanceOf(MemberAccountInactiveException);

    const [member, afterHistory, audit] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["row_version", "status"])
        .where("id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("member_id", "=", memberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("action", "=", "member.approved")
        .where("target_id", "=", memberId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(member).toEqual({ row_version: "1", status: "pending" });
    expect(afterHistory.count).toBe(beforeHistory.count);
    expect(audit.count).toBe("0");
  });

  it("rejects, removes, and allows rejoin with conditional transitions and audits", async () => {
    const rejectedUserId = await createTestUser("member-rejected@example.com");
    const rejectedMemberId = await insertStudentMembership(fixture, rejectedUserId, "pending");
    const removedUserEmail = "member-removed-command@example.com";
    const removedUserId = await createTestUser(removedUserEmail);
    const removedMemberId = await insertStudentMembership(fixture, removedUserId, "pending");
    await membersService.approve({
      actorUserId: fixture.teacherId,
      displayNameInClass: null,
      memberId: removedMemberId,
      requestId: randomUUID(),
      studentNumber: 8,
    });
    const rejoinUserId = await createTestUser("member-rejoin-command@example.com");
    const rejoinMemberId = await insertStudentMembership(fixture, rejoinUserId, "removed");

    const teacherLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "membership-teacher@example.com", password: baseCommand.password },
    });
    const teacherCookies = responseCookies(teacherLogin.headers);
    const teacherSession = rawCookie(teacherCookies, SESSION_COOKIE_NAME);
    const teacherCsrf = rawCookie(teacherCookies, CSRF_COOKIE_NAME);
    const teacherCookie = `${SESSION_COOKIE_NAME}=${teacherSession}; ${CSRF_COOKIE_NAME}=${teacherCsrf}`;
    const commandHeaders = {
      cookie: teacherCookie,
      origin: "http://localhost:5173",
      "x-csrf-token": teacherCsrf,
    };

    const approvedList = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/members?status=approved",
      headers: { cookie: teacherCookie },
    });
    expect(approvedList.statusCode).toBe(200);
    const approvedItem = (approvedList.json().members as Array<Record<string, unknown>>).find(
      (member) => member.id === removedMemberId,
    );
    expect(approvedItem).toMatchObject({
      id: removedMemberId,
      status: "approved",
      student_number: 8,
    });
    expect(approvedItem?.email_masked).toBeUndefined();

    const rejected = await httpApplication.inject({
      method: "POST",
      url: `/api/v1/members/${rejectedMemberId}/reject`,
      headers: commandHeaders,
      payload: { reason: "학급 확인이 필요합니다." },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      member: {
        id: rejectedMemberId,
        reason: "학급 확인이 필요합니다.",
        row_version: "2",
        status: "rejected",
      },
    });

    const studentLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: removedUserEmail, password: baseCommand.password },
    });
    const studentSession = rawCookie(responseCookies(studentLogin.headers), SESSION_COOKIE_NAME);
    const removed = await httpApplication.inject({
      method: "POST",
      url: `/api/v1/members/${removedMemberId}/remove`,
      headers: commandHeaders,
      payload: { reason: "반 배정이 변경되었습니다." },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      member: {
        id: removedMemberId,
        reason: "반 배정이 변경되었습니다.",
        row_version: "3",
        status: "removed",
      },
    });

    const removedBootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${studentSession}` },
    });
    expect(removedBootstrap.statusCode).toBe(200);
    expect(removedBootstrap.json()).toMatchObject({
      current_membership: null,
      destination: "ENTER_INVITE_CODE",
      last_membership_status: "removed",
      last_status_reason: "반 배정이 변경되었습니다.",
    });

    const rejoin = await httpApplication.inject({
      method: "POST",
      url: `/api/v1/members/${rejoinMemberId}/allow-rejoin`,
      headers: commandHeaders,
    });
    expect(rejoin.statusCode).toBe(200);
    expect(rejoin.json()).toMatchObject({
      member: {
        id: rejoinMemberId,
        reason: null,
        row_version: "2",
        status: "rejoin_allowed",
      },
    });

    const [memberRows, histories, audits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["id", "row_version", "status", "student_number"])
        .where("id", "in", [rejectedMemberId, removedMemberId, rejoinMemberId])
        .orderBy("id")
        .execute(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["from_status", "member_id", "reason", "to_status"])
        .where("member_id", "in", [rejectedMemberId, removedMemberId, rejoinMemberId])
        .where("to_status", "in", ["rejected", "removed", "rejoin_allowed"])
        .orderBy("member_id")
        .execute(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select(["action", "after_json", "before_json", "reason", "target_id", "target_snapshot"])
        .where("target_id", "in", [rejectedMemberId, removedMemberId, rejoinMemberId])
        .where("action", "in", ["member.rejected", "member.removed", "member.rejoin_allowed"])
        .orderBy("target_id")
        .execute(),
    ]);
    expect(memberRows).toEqual([
      expect.objectContaining({ id: rejectedMemberId, row_version: "2", status: "rejected" }),
      expect.objectContaining({
        id: removedMemberId,
        row_version: "3",
        status: "removed",
        student_number: null,
      }),
      expect.objectContaining({
        id: rejoinMemberId,
        row_version: "2",
        status: "rejoin_allowed",
      }),
    ]);
    expect(histories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_status: "pending",
          member_id: rejectedMemberId,
          to_status: "rejected",
        }),
        expect.objectContaining({
          from_status: "approved",
          member_id: removedMemberId,
          to_status: "removed",
        }),
        expect.objectContaining({
          from_status: "removed",
          member_id: rejoinMemberId,
          to_status: "rejoin_allowed",
        }),
      ]),
    );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "member.rejected",
          reason: "학급 확인이 필요합니다.",
          target_id: rejectedMemberId,
        }),
        expect.objectContaining({
          action: "member.removed",
          reason: "반 배정이 변경되었습니다.",
          target_id: removedMemberId,
        }),
        expect.objectContaining({
          action: "member.rejoin_allowed",
          reason: null,
          target_id: rejoinMemberId,
        }),
      ]),
    );
    for (const audit of audits) {
      expect(audit.before_json).not.toBeNull();
      expect(audit.after_json).not.toBeNull();
      expect(audit.target_snapshot).toBeNull();
    }
  }, 30_000);

  it("allows exactly one winner when approval and rejection race", async () => {
    const userId = await createTestUser("member-approval-rejection-race@example.com");
    const memberId = await insertStudentMembership(fixture, userId, "pending");
    const results = await Promise.allSettled([
      membersService.approve({
        actorUserId: fixture.teacherId,
        displayNameInClass: null,
        memberId,
        requestId: randomUUID(),
        studentNumber: null,
      }),
      membersService.reject({
        actorUserId: fixture.teacherId,
        memberId,
        reason: null,
        requestId: randomUUID(),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ reason: expect.any(MemberStatusChangedException) });
    const audit = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("target_id", "=", memberId)
      .where("action", "in", ["member.approved", "member.rejected"])
      .executeTakeFirstOrThrow();
    expect(audit.count).toBe("1");
  });

  it("returns a successful empty home and rejects a pending student", async () => {
    const serverToday = await databaseToday();
    const teacherHome = await homeService.getForUser(fixture.teacherId);
    expect(teacherHome).toMatchObject({
      attendance: {
        data: { absent: 0, acknowledged: 0, early: 0, late: 0, pending: 0, total: 0 },
        status: "empty",
      },
      meal: { data: null, status: "empty" },
      notices: { data: [], status: "empty" },
      schedules: { data: [], status: "empty" },
      server_today: serverToday,
      supplies: { data: [], status: "empty" },
    });
    expect(teacherHome.pending_member_count).toBeGreaterThanOrEqual(0);

    const pendingUserId = await createTestUser("home-pending-student@example.com");
    await insertStudentMembership(fixture, pendingUserId, "pending");
    await expect(homeService.getForUser(pendingUserId)).rejects.toBeInstanceOf(
      HomeNotFoundException,
    );

    const teacherLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "membership-teacher@example.com", password: baseCommand.password },
    });
    const teacherSession = rawCookie(responseCookies(teacherLogin.headers), SESSION_COOKIE_NAME);
    const response = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/home",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${teacherSession}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      meal: { data: null, status: "empty" },
      server_today: serverToday,
    });
  }, 30_000);

  it("applies home limits, student states, D-days, and isolated card failures", async () => {
    const serverToday = await databaseToday();
    const tomorrow = addCalendarDays(serverToday, 1);
    const dayAfter = addCalendarDays(serverToday, 2);
    const fixtureNow = new Date();
    const studentUserId = await createTestUser("home-approved-student@example.com");
    const studentMemberId = await insertStudentMembership(fixture, studentUserId, "pending");
    await membersService.approve({
      actorUserId: fixture.teacherId,
      displayNameInClass: null,
      memberId: studentMemberId,
      requestId: randomUUID(),
      studentNumber: null,
    });

    await bootstrapDatabase
      .insertInto("meals")
      .values({
        edu_office_code: "B10",
        meal_date: serverToday,
        meal_type: "lunch",
        menu_json: sql`${JSON.stringify([{ allergens: ["1", "2"], name: "김치볶음밥" }])}::jsonb`,
        school_code: "1234567",
        source_updated_at: fixtureNow,
      })
      .execute();

    const supplies = await bootstrapDatabase
      .insertInto("supplies")
      .values([
        {
          class_id: fixture.classId,
          created_at: new Date(fixtureNow.getTime() - 2_000),
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          needed_on: serverToday,
          title: "색연필",
        },
        {
          class_id: fixture.classId,
          created_at: new Date(fixtureNow.getTime() - 3_000),
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          needed_on: serverToday,
          title: "도화지",
        },
        {
          class_id: fixture.classId,
          created_at: new Date(fixtureNow.getTime() - 4_000),
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          needed_on: tomorrow,
          title: "체육복",
        },
        {
          class_id: fixture.classId,
          created_at: new Date(fixtureNow.getTime() - 5_000),
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          needed_on: tomorrow,
          title: "제외될 준비물",
        },
        {
          class_id: fixture.classId,
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          needed_on: dayAfter,
          title: "모레 준비물",
        },
      ])
      .returning(["content_revision", "id", "title"])
      .execute();
    const checkedSupply = supplies.find((supply) => supply.title === "색연필")!;
    await bootstrapDatabase
      .insertInto("supply_checks")
      .values({
        checked_at: fixtureNow,
        class_id: fixture.classId,
        confirmed_revision: checkedSupply.content_revision,
        is_checked: true,
        member_id: studentMemberId,
        supply_id: checkedSupply.id,
        unchecked_at: null,
      })
      .execute();

    const notices = await bootstrapDatabase
      .insertInto("notices")
      .values([
        ...Array.from({ length: 3 }, (_, index) => ({
          class_id: fixture.classId,
          content: `중요 공지 본문 ${index}`,
          created_by_member_id: fixture.teacherMemberId,
          is_important: true,
          published_at: new Date(fixtureNow.getTime() - (3 - index) * 60_000),
          title: `중요 공지 ${index}`,
        })),
        ...Array.from({ length: 4 }, (_, index) => ({
          class_id: fixture.classId,
          content: `일반 공지 본문 ${index}`,
          created_by_member_id: fixture.teacherMemberId,
          is_important: false,
          published_at: new Date(fixtureNow.getTime() - (10 - index) * 60_000),
          title: `일반 공지 ${index}`,
        })),
      ])
      .returning(["content_revision", "id", "is_important", "title"])
      .execute();
    const confirmedNotice = notices.find((notice) => notice.title === "중요 공지 2")!;
    await bootstrapDatabase
      .insertInto("notice_reads")
      .values({
        class_id: fixture.classId,
        confirmed_at: fixtureNow,
        confirmed_revision: confirmedNotice.content_revision,
        first_confirmed_at: fixtureNow,
        member_id: studentMemberId,
        notice_id: confirmedNotice.id,
      })
      .execute();

    await bootstrapDatabase
      .insertInto("schedules")
      .values(
        Array.from({ length: 4 }, (_, index) => ({
          class_id: fixture.classId,
          created_at: new Date(fixtureNow.getTime() - index * 1_000),
          created_by_member_id: fixture.teacherMemberId,
          description: null,
          due_date: addCalendarDays(serverToday, index),
          schedule_type: index === 0 ? "exam" : "other",
          subject: index === 0 ? "수학" : null,
          title: `일정 ${index}`,
        })),
      )
      .execute();

    const studentHome = await homeService.getForUser(studentUserId);
    expect(studentHome.pending_member_count).toBeNull();
    expect(studentHome.meal).toMatchObject({
      data: {
        calorie_kcal: null,
        menu: [{ allergens: ["1", "2"], name: "김치볶음밥" }],
        source: "seed",
        source_loaded_on: null,
        source_updated_at: fixtureNow.toISOString(),
      },
      status: "ok",
    });
    expect(studentHome.supplies.status).toBe("ok");
    expect(studentHome.supplies.data).toHaveLength(3);
    expect(studentHome.supplies.data[0]).toMatchObject({
      check_state: "checked",
      title: "색연필",
    });
    expect(studentHome.notices.status).toBe("ok");
    expect(studentHome.notices.data).toHaveLength(5);
    expect(studentHome.notices.data[0]).toMatchObject({
      confirmation_state: "confirmed",
      title: "중요 공지 2",
    });
    expect(studentHome.notices.data.map((notice) => notice.is_important)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(studentHome.schedules.data).toHaveLength(3);
    expect(studentHome.schedules.data.map((schedule) => schedule.d_day_label)).toEqual([
      "D-Day",
      "D-1",
      "D-2",
    ]);

    const teacherHome = await homeService.getForUser(fixture.teacherId);
    expect(teacherHome.pending_member_count).toBeGreaterThanOrEqual(1);
    expect(teacherHome.notices.data[0]).not.toHaveProperty("confirmation_state");
    expect(teacherHome.supplies.data[0]).not.toHaveProperty("check_state");

    const failingDatabase = new Proxy(applicationDatabase, {
      get(target, property, receiver) {
        if (property === "selectFrom") {
          return (table: string) => {
            if (table === "schedules as schedule") throw new Error("simulated schedule failure");
            return (target.selectFrom as (table: string) => unknown)(table);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof applicationDatabase;
    const partialHome = await new HomeService(failingDatabase, true).getForUser(studentUserId);
    expect(partialHome.schedules).toEqual({
      data: [],
      error_code: "SCHEDULE_QUERY_FAILED",
      message: "일정을 불러오지 못했어요.",
      status: "error",
    });
    expect(partialHome.meal.status).toBe("ok");

    const allFailingDatabase = new Proxy(applicationDatabase, {
      get(target, property, receiver) {
        if (property === "selectFrom") {
          return (table: string) => {
            if (
              [
                "attendance_notifications as notification",
                "meals",
                "supplies as supply",
                "notices as notice",
                "schedules as schedule",
              ].includes(table)
            ) {
              throw new Error("simulated home database failure");
            }
            return (target.selectFrom as (table: string) => unknown)(table);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof applicationDatabase;
    await expect(
      new HomeService(allFailingDatabase, true).getForUser(studentUserId),
    ).rejects.toBeInstanceOf(HomeUnavailableException);
  }, 30_000);

  it("searches schools and atomically creates a teacher class with its first invite", async () => {
    const email = "class-creation-teacher@example.com";
    const teacherId = await createTeacherWithoutClass(email, fixture.operatorId);
    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: baseCommand.password },
    });
    const cookies = responseCookies(login.headers);
    const session = rawCookie(cookies, SESSION_COOKIE_NAME);
    const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`;

    const shortSearch = await httpApplication.inject({
      method: "GET",
      url: `/api/v1/schools?q=${encodeURIComponent("테")}`,
      headers: { cookie },
    });
    expect(shortSearch.statusCode).toBe(400);

    const search = await httpApplication.inject({
      method: "GET",
      url: `/api/v1/schools?q=${encodeURIComponent("테스트")}`,
      headers: { cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual({
      schools: [
        {
          edu_office_code: "B10",
          edu_office_name: "테스트 교육청",
          region_name: "서울",
          school_code: "1234567",
          school_kind: "middle",
          school_name: "테스트 중학교",
        },
      ],
    });

    const payload = {
      academic_year: 2026,
      edu_office_code: "B10",
      expected_student_count: 28,
      grade: 2,
      name: "새 테스트 반",
      school_code: "1234567",
    };
    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: {
        cookie,
        "idempotency-key": randomUUID(),
        origin: "http://localhost:5173",
      },
      payload,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const commandHeaders = {
      cookie,
      origin: "http://localhost:5173",
      "x-csrf-token": csrf,
    };
    const missingKey = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: commandHeaders,
      payload,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const invalidGrade = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: { ...commandHeaders, "idempotency-key": randomUUID() },
      payload: { ...payload, grade: 4 },
    });
    expect(invalidGrade.statusCode).toBe(400);
    expect(invalidGrade.json()).toMatchObject({ error: { code: "GRADE_NOT_ALLOWED" } });

    /*
     * 초등은 받지 않는다(2026-08-05 결정). 만 14세 미만은 법정대리인 동의와 확인이
     * 필요한데 그 절차가 없어, 학급을 열어두면 학생이 나이 확인란에 거짓 체크를
     * 해야만 가입할 수 있게 된다. 두 층을 다 확인한다 — 검색에서 안 보이고,
     * 코드를 직접 넣어도 거부된다.
     */
    await bootstrapDatabase
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "테스트 교육청",
        region_name: "서울",
        school_code: "1234500",
        school_kind: "elementary",
        school_name: "테스트 초등학교",
      })
      .execute();
    const elementarySearch = await httpApplication.inject({
      method: "GET",
      url: `/api/v1/schools?q=${encodeURIComponent("테스트")}`,
      headers: { cookie },
    });
    expect(elementarySearch.statusCode).toBe(200);
    expect(JSON.stringify(elementarySearch.json())).not.toContain("테스트 초등학교");

    const elementaryClass = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: { ...commandHeaders, "idempotency-key": randomUUID() },
      payload: { ...payload, grade: 3, school_code: "1234500" },
    });
    expect(elementaryClass.statusCode).toBe(400);
    expect(elementaryClass.json()).toMatchObject({
      error: { code: "SCHOOL_KIND_NOT_SUPPORTED" },
    });

    const idempotencyKey = randomUUID();
    const created = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: { ...commandHeaders, "idempotency-key": idempotencyKey },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      class: {
        academic_year: 2026,
        expected_student_count: 28,
        grade: 2,
        name: "새 테스트 반",
        row_version: "1",
        school_name: "테스트 중학교",
        status: "active",
      },
      invite_code: { status: "active" },
      next_action: "HOME",
    });
    expect(created.json().invite_code.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/u);

    const replayed = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: { ...commandHeaders, "idempotency-key": idempotencyKey },
      payload,
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(created.json());

    const createdClassId = created.json().class.id as string;
    const createdMemberId = created.json().teacher_membership_id as string;
    const [createdClass, member, history, invite, audits, idempotencyRows] = await Promise.all([
      bootstrapDatabase
        .selectFrom("classes")
        .select(["created_by_user_id", "name_normalized", "status"])
        .where("id", "=", createdClassId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select(["class_id", "role", "status", "user_id"])
        .where("id", "=", createdMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select(["actor_member_id", "actor_user_id", "from_status", "to_status"])
        .where("member_id", "=", createdMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_invite_codes")
        .select(["code", "created_by_member_id", "expires_at", "revoked_at"])
        .where("class_id", "=", createdClassId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select(["action", "after_json", "before_json", "target_snapshot"])
        .where("class_id", "=", createdClassId)
        .orderBy("id")
        .execute(),
      bootstrapDatabase
        .selectFrom("api_idempotency_keys")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", teacherId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirstOrThrow(),
    ]);
    expect(createdClass).toEqual({
      created_by_user_id: teacherId,
      name_normalized: "새 테스트 반",
      status: "active",
    });
    expect(member).toEqual({
      class_id: createdClassId,
      role: "teacher",
      status: "approved",
      user_id: teacherId,
    });
    expect(history).toEqual({
      actor_member_id: createdMemberId,
      actor_user_id: teacherId,
      from_status: null,
      to_status: "approved",
    });
    expect(invite).toMatchObject({
      code: created.json().invite_code.code,
      created_by_member_id: createdMemberId,
      revoked_at: null,
    });
    expect(invite.expires_at.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1_000);
    expect(audits.map((audit) => audit.action)).toEqual(["class.created", "invite_code.created"]);
    for (const audit of audits) {
      expect(audit.after_json).not.toBeNull();
      expect(audit.before_json).toBeNull();
      expect(audit.target_snapshot).toBeNull();
    }
    expect(JSON.stringify(audits)).not.toContain(invite.code);
    expect(idempotencyRows.count).toBe("1");

    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      current_class: { id: createdClassId, status: "active" },
      destination: "HOME",
    });

    const duplicateEmail = "class-duplicate-teacher@example.com";
    await createTeacherWithoutClass(duplicateEmail, fixture.operatorId);
    const duplicateLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: duplicateEmail, password: baseCommand.password },
    });
    const duplicateCookies = responseCookies(duplicateLogin.headers);
    const duplicateSession = rawCookie(duplicateCookies, SESSION_COOKIE_NAME);
    const duplicateCsrf = rawCookie(duplicateCookies, CSRF_COOKIE_NAME);
    const duplicate = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${duplicateSession}; ${CSRF_COOKIE_NAME}=${duplicateCsrf}`,
        "idempotency-key": randomUUID(),
        origin: "http://localhost:5173",
        "x-csrf-token": duplicateCsrf,
      },
      payload: { ...payload, name: " 새   테스트 반 " },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "CLASS_ALREADY_EXISTS" } });
  }, 30_000);

  it("maps a create-versus-rename identity race to CLASS_ALREADY_EXISTS", async () => {
    const loginTeacher = async (email: string) => {
      const login = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "http://localhost:5173" },
        payload: { email, password: baseCommand.password },
      });
      const cookies = responseCookies(login.headers);
      const session = rawCookie(cookies, SESSION_COOKIE_NAME);
      const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
      return {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
        csrf,
      };
    };

    const editorEmail = "class-race-editor@example.com";
    await createTeacherWithoutClass(editorEmail, fixture.operatorId);
    const editorAuth = await loginTeacher(editorEmail);
    const originalPayload = {
      academic_year: 2029,
      edu_office_code: "B10",
      expected_student_count: 25,
      grade: 3,
      name: "경쟁 원본 반",
      school_code: "1234567",
    };
    const original = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes",
      headers: {
        cookie: editorAuth.cookie,
        "idempotency-key": randomUUID(),
        origin: "http://localhost:5173",
        "x-csrf-token": editorAuth.csrf,
      },
      payload: originalPayload,
    });
    expect(original.statusCode).toBe(201);

    const creatorEmail = "class-race-creator@example.com";
    const creatorId = await createTeacherWithoutClass(creatorEmail, fixture.operatorId);
    const creatorAuth = await loginTeacher(creatorEmail);
    const creatorIdempotencyKey = randomUUID();
    const targetName = "경쟁 목표 반";

    let markAuditLockReady!: () => void;
    const auditLockReady = new Promise<void>((resolve) => {
      markAuditLockReady = resolve;
    });
    let resolveAuditLock!: () => void;
    const auditLockRelease = new Promise<void>((resolve) => {
      resolveAuditLock = resolve;
    });
    let auditLockReleased = false;
    const releaseAuditLock = () => {
      if (auditLockReleased) return;
      auditLockReleased = true;
      resolveAuditLock();
    };
    const auditBlocker = bootstrapDatabase.transaction().execute(async (transaction) => {
      await sql`LOCK TABLE audit_logs IN SHARE MODE`.execute(transaction);
      markAuditLockReady();
      await auditLockRelease;
    });
    await withSafetyDeadline(auditLockReady, 5_000, "Audit table lock was not acquired.");

    const updatePromise = httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: {
        cookie: editorAuth.cookie,
        "if-match": '"1"',
        origin: "http://localhost:5173",
        "x-csrf-token": editorAuth.csrf,
      },
      payload: { name: targetName },
    });
    let pendingCreate: Promise<unknown> | undefined;
    try {
      await waitForApplicationLockWait('insert into "audit_logs"');

      const createPromise = httpApplication.inject({
        method: "POST",
        url: "/api/v1/classes",
        headers: {
          cookie: creatorAuth.cookie,
          "idempotency-key": creatorIdempotencyKey,
          origin: "http://localhost:5173",
          "x-csrf-token": creatorAuth.csrf,
        },
        payload: { ...originalPayload, name: targetName },
      });
      pendingCreate = createPromise;
      await waitForApplicationLockWait('insert into "classes"');

      releaseAuditLock();
      const [updated, collision] = await Promise.all([updatePromise, createPromise]);
      await auditBlocker;

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ name: targetName, row_version: "2" });
      expect(collision.statusCode).toBe(409);
      expect(collision.json()).toMatchObject({
        error: { code: "CLASS_ALREADY_EXISTS" },
      });

      const [targetClasses, creatorMembers, idempotencyRows] = await Promise.all([
        bootstrapDatabase
          .selectFrom("classes")
          .select(["id", "name", "status"])
          .where("academic_year", "=", 2029)
          .where("grade", "=", 3)
          .where("name_normalized", "=", "경쟁 목표 반")
          .where("status", "in", ["active", "suspended"])
          .execute(),
        bootstrapDatabase
          .selectFrom("class_members")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("user_id", "=", creatorId)
          .executeTakeFirstOrThrow(),
        bootstrapDatabase
          .selectFrom("api_idempotency_keys")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("actor_user_id", "=", creatorId)
          .where("idempotency_key", "=", creatorIdempotencyKey)
          .executeTakeFirstOrThrow(),
      ]);
      expect(targetClasses).toHaveLength(1);
      expect(targetClasses[0]).toMatchObject({ name: targetName, status: "active" });
      expect(creatorMembers.count).toBe("0");
      expect(idempotencyRows.count).toBe("0");
    } finally {
      releaseAuditLock();
      await Promise.allSettled([
        auditBlocker,
        updatePromise,
        ...(pendingCreate === undefined ? [] : [pendingCreate]),
      ]);
    }
  }, 30_000);

  it("shows role-safe class details and atomically rotates the teacher invite code", async () => {
    const approvedEmail = "class-detail-student@example.com";
    const approvedUserId = await createTestUser(approvedEmail);
    const approvedMemberId = await insertStudentMembership(fixture, approvedUserId, "pending");
    await membersService.approve({
      actorUserId: fixture.teacherId,
      displayNameInClass: null,
      memberId: approvedMemberId,
      requestId: randomUUID(),
      studentNumber: null,
    });
    const pendingUserId = await createTestUser("invite-rotation-pending@example.com");
    const pendingMemberId = await insertStudentMembership(fixture, pendingUserId, "pending");

    const teacherLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "membership-teacher@example.com", password: baseCommand.password },
    });
    const teacherCookies = responseCookies(teacherLogin.headers);
    const teacherSession = rawCookie(teacherCookies, SESSION_COOKIE_NAME);
    const teacherCsrf = rawCookie(teacherCookies, CSRF_COOKIE_NAME);
    const teacherCookie = `${SESSION_COOKIE_NAME}=${teacherSession}; ${CSRF_COOKIE_NAME}=${teacherCsrf}`;

    const teacherBootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: teacherCookie },
    });
    expect(teacherBootstrap.statusCode).toBe(200);
    expect(teacherBootstrap.json()).toMatchObject({
      current_class: {
        school_address: "서울특별시 테스트구 학교로 1 (테스트동)",
        school_homepage_url: "https://school.example.com/",
        school_name: "테스트 중학교",
        school_phone_number: "02-1234-5678",
      },
    });

    const currentClass = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/classes/current",
      headers: { cookie: teacherCookie },
    });
    expect(currentClass.statusCode).toBe(200);
    expect(currentClass.headers["cache-control"]).toBe("no-store");
    expect(currentClass.headers.etag).toBe('"1"');
    expect(currentClass.json()).toMatchObject({
      academic_year: 2026,
      expected_student_count: 30,
      grade: 1,
      id: fixture.classId,
      name: "1반",
      role: "teacher",
      row_version: "1",
      school_address: "서울특별시 테스트구 학교로 1 (테스트동)",
      school_homepage_url: "https://school.example.com/",
      school_name: "테스트 중학교",
      school_phone_number: "02-1234-5678",
      status: "active",
      teacher_display_name: "테스트 학생",
    });
    expect(currentClass.json().active_student_count).toBeGreaterThanOrEqual(1);

    const currentInvite = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/classes/current/invite-code",
      headers: { cookie: teacherCookie },
    });
    expect(currentInvite.statusCode).toBe(200);
    expect(currentInvite.json()).toMatchObject({
      class_id: fixture.classId,
      invite_code: { code: fixture.inviteCode, status: "active" },
    });

    const studentLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: approvedEmail, password: baseCommand.password },
    });
    const studentSession = rawCookie(responseCookies(studentLogin.headers), SESSION_COOKIE_NAME);
    const studentClass = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/classes/current",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${studentSession}` },
    });
    expect(studentClass.statusCode).toBe(200);
    expect(studentClass.json()).toMatchObject({
      role: "student",
      school_address: "서울특별시 테스트구 학교로 1 (테스트동)",
      school_homepage_url: "https://school.example.com/",
      school_name: "테스트 중학교",
      school_phone_number: "02-1234-5678",
    });
    expect(studentClass.json()).not.toHaveProperty("expected_student_count");
    const studentInvite = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/classes/current/invite-code",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${studentSession}` },
    });
    expect(studentInvite.statusCode).toBe(403);
    expect(studentInvite.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });
    const deniedEvents = await waitForSecurityEventsForRequest(
      String(studentInvite.headers["x-request-id"]),
    );
    expect(deniedEvents).toEqual([
      expect.objectContaining({
        action: "authz.denied",
        actor_user_id: approvedUserId,
        actor_class_id: fixture.classId,
        target_class_id: fixture.classId,
        deny_reason: "role_insufficient",
        method: "GET",
        resource: "classes",
        sanitized_path: "/api/v1/classes/current/invite-code",
      }),
    ]);

    const idempotencyKey = randomUUID();
    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: {
        cookie: teacherCookie,
        "idempotency-key": idempotencyKey,
        origin: "http://localhost:5173",
      },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const commandHeaders = {
      cookie: teacherCookie,
      origin: "http://localhost:5173",
      "x-csrf-token": teacherCsrf,
    };
    const missingKey = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: commandHeaders,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const invalidKey = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: { ...commandHeaders, "idempotency-key": "not-a-uuid" },
    });
    expect(invalidKey.statusCode).toBe(400);
    expect(invalidKey.json()).toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });

    const rotated = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: { ...commandHeaders, "idempotency-key": idempotencyKey },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({
      class_id: fixture.classId,
      invite_code: { status: "active" },
    });
    expect(rotated.json().invite_code.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/u);
    expect(rotated.json().invite_code.code).not.toBe(fixture.inviteCode);

    const replayed = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/invite-code/rotate",
      headers: { ...commandHeaders, "idempotency-key": idempotencyKey },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(rotated.json());

    const [invites, pendingMember, audits, idempotencyRows] = await Promise.all([
      bootstrapDatabase
        .selectFrom("class_invite_codes")
        .select(["code", "revoke_reason", "revoked_at", "revoked_by_member_id"])
        .where("class_id", "=", fixture.classId)
        .orderBy("id")
        .execute(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select("status")
        .where("id", "=", pendingMemberId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select(["action", "after_json", "before_json", "target_snapshot"])
        .where("class_id", "=", fixture.classId)
        .where("action", "in", ["invite_code.revoked", "invite_code.created"])
        .execute(),
      bootstrapDatabase
        .selectFrom("api_idempotency_keys")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", fixture.teacherId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirstOrThrow(),
    ]);
    const previousInvite = invites.find((invite) => invite.code === fixture.inviteCode);
    const newInvite = invites.find((invite) => invite.code === rotated.json().invite_code.code);
    expect(previousInvite).toMatchObject({
      revoke_reason: "재발급",
      revoked_by_member_id: fixture.teacherMemberId,
    });
    expect(previousInvite?.revoked_at).not.toBeNull();
    expect(newInvite?.revoked_at).toBeNull();
    expect(invites.filter((invite) => invite.revoked_at === null)).toHaveLength(1);
    expect(pendingMember.status).toBe("pending");
    expect(idempotencyRows.count).toBe("1");
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "invite_code.revoked",
          target_snapshot: null,
        }),
        expect.objectContaining({
          action: "invite_code.created",
          before_json: null,
          target_snapshot: null,
        }),
      ]),
    );
    const revokedAudit = audits.find((audit) => audit.action === "invite_code.revoked");
    expect(revokedAudit?.before_json).toEqual({ revoke_reason: null, revoked_at: null });
    expect(revokedAudit?.after_json).toEqual({
      revoke_reason: "재발급",
      revoked_at: expect.any(String),
    });
    expect(JSON.stringify(audits)).not.toContain(fixture.inviteCode);
    expect(JSON.stringify(audits)).not.toContain(rotated.json().invite_code.code);
  }, 30_000);

  it("updates only editable class fields with strong If-Match concurrency control", async () => {
    const teacherLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "membership-teacher@example.com", password: baseCommand.password },
    });
    const teacherCookies = responseCookies(teacherLogin.headers);
    const teacherSession = rawCookie(teacherCookies, SESSION_COOKIE_NAME);
    const teacherCsrf = rawCookie(teacherCookies, CSRF_COOKIE_NAME);
    const cookie = `${SESSION_COOKIE_NAME}=${teacherSession}; ${CSRF_COOKIE_NAME}=${teacherCsrf}`;
    const csrfHeaders = {
      cookie,
      origin: "http://localhost:5173",
      "x-csrf-token": teacherCsrf,
    };

    const before = await bootstrapDatabase
      .selectFrom("classes")
      .select(["name", "expected_student_count", "row_version", "updated_at"])
      .where("id", "=", fixture.classId)
      .executeTakeFirstOrThrow();
    expect(before).toMatchObject({
      expected_student_count: 30,
      name: "1반",
      row_version: "1",
    });

    const missingCsrf = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: { cookie, "if-match": '"1"', origin: "http://localhost:5173" },
      payload: { name: "수정 시도" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const missingIfMatch = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: csrfHeaders,
      payload: { name: "수정 시도" },
    });
    expect(missingIfMatch.statusCode).toBe(428);
    expect(missingIfMatch.json()).toMatchObject({ error: { code: "IF_MATCH_REQUIRED" } });

    for (const invalidIfMatch of ["1", 'W/"1"', '"1", "2"', "*"]) {
      const invalid = await httpApplication.inject({
        method: "PATCH",
        url: "/api/v1/classes/current",
        headers: { ...csrfHeaders, "if-match": invalidIfMatch },
        payload: { name: "수정 시도" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: "INVALID_IF_MATCH" } });
    }

    const invalidNull = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: { ...csrfHeaders, "if-match": '"1"' },
      payload: { name: null },
    });
    expect(invalidNull.statusCode).toBe(400);

    const updated = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: { ...csrfHeaders, "if-match": '"1"' },
      payload: { expected_student_count: 28, name: "수정된 1반" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(updated.json()).toMatchObject({
      expected_student_count: 28,
      id: fixture.classId,
      name: "수정된 1반",
      role: "teacher",
      row_version: "2",
    });

    const firstAudit = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select(["after_json", "before_json", "target_snapshot"])
      .where("class_id", "=", fixture.classId)
      .where("action", "=", "class.updated")
      .executeTakeFirstOrThrow();
    expect(firstAudit).toEqual({
      after_json: { expected_student_count: 28, name: "수정된 1반" },
      before_json: { expected_student_count: 30, name: "1반" },
      target_snapshot: null,
    });

    const afterFirstUpdate = await bootstrapDatabase
      .selectFrom("classes")
      .select(["row_version", "updated_at"])
      .where("id", "=", fixture.classId)
      .executeTakeFirstOrThrow();
    expect(afterFirstUpdate.row_version).toBe("2");
    expect(afterFirstUpdate.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.updated_at.getTime(),
    );

    const noOp = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: { ...csrfHeaders, "if-match": '"2"' },
      payload: { expected_student_count: 28, name: "수정된 1반" },
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.headers.etag).toBe('"2"');
    const afterNoOp = await bootstrapDatabase
      .selectFrom("classes")
      .select(["row_version", "updated_at"])
      .where("id", "=", fixture.classId)
      .executeTakeFirstOrThrow();
    expect(afterNoOp).toEqual(afterFirstUpdate);
    const auditCountAfterNoOp = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("class_id", "=", fixture.classId)
      .where("action", "=", "class.updated")
      .executeTakeFirstOrThrow();
    expect(auditCountAfterNoOp.count).toBe("1");

    const stale = await httpApplication.inject({
      method: "PATCH",
      url: "/api/v1/classes/current",
      headers: { ...csrfHeaders, "if-match": '"1"' },
      payload: { name: "오래된 수정" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: "2" } },
    });

    const concurrentResponses = await Promise.all([
      httpApplication.inject({
        method: "PATCH",
        url: "/api/v1/classes/current",
        headers: { ...csrfHeaders, "if-match": '"2"' },
        payload: { name: "동시성 수정 반" },
      }),
      httpApplication.inject({
        method: "PATCH",
        url: "/api/v1/classes/current",
        headers: { ...csrfHeaders, "if-match": '"2"' },
        payload: { expected_student_count: 29 },
      }),
    ]);
    expect(concurrentResponses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = concurrentResponses.find((response) => response.statusCode === 200)!;
    const loser = concurrentResponses.find((response) => response.statusCode === 409)!;
    expect(winner.headers.etag).toBe('"3"');
    expect(winner.json()).toMatchObject({ row_version: "3" });
    expect(loser.json()).toMatchObject({
      error: { code: "RESOURCE_VERSION_CHANGED", details: { current_row_version: "3" } },
    });

    const finalState = await bootstrapDatabase
      .selectFrom("classes")
      .select(["expected_student_count", "name", "row_version"])
      .where("id", "=", fixture.classId)
      .executeTakeFirstOrThrow();
    expect(finalState.row_version).toBe("3");
    expect(
      [
        finalState.name === "동시성 수정 반" && finalState.expected_student_count === 28,
        finalState.name === "수정된 1반" && finalState.expected_student_count === 29,
      ].some(Boolean),
    ).toBe(true);
    const finalAuditCount = await bootstrapDatabase
      .selectFrom("audit_logs")
      .select((expression) => expression.fn.countAll<string>().as("count"))
      .where("class_id", "=", fixture.classId)
      .where("action", "=", "class.updated")
      .executeTakeFirstOrThrow();
    expect(finalAuditCount.count).toBe("2");
  }, 30_000);

  it("archives the active teacher class once with one DB timestamp, ordered histories, and secret-free audits", async () => {
    const archiveFixture = await createArchiveHttpFixture("core", fixture.operatorId);
    const pendingUserId = await createTestUser("archive-core-pending@example.com");
    const pendingMemberId = await insertStudentMembership(archiveFixture, pendingUserId, "pending");
    const approvedEmail = "archive-core-approved@example.com";
    const approvedUserId = await createTestUser(approvedEmail);
    const approvedMemberId = await insertStudentMembership(
      archiveFixture,
      approvedUserId,
      "pending",
    );
    await membersService.approve({
      actorUserId: archiveFixture.teacherId,
      displayNameInClass: "아카이브 승인 학생",
      memberId: approvedMemberId,
      requestId: randomUUID(),
      studentNumber: 9,
    });

    const beforeMembers = await bootstrapDatabase
      .selectFrom("class_members")
      .select(["id", "row_version", "status"])
      .where("class_id", "=", archiveFixture.classId)
      .where("status", "in", ["pending", "approved"])
      .orderBy("id", "asc")
      .execute();
    expect(beforeMembers.map((member) => member.id)).toEqual([
      archiveFixture.teacherMemberId,
      pendingMemberId,
      approvedMemberId,
    ]);

    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/archive",
      headers: {
        cookie: archiveFixture.cookie,
        origin: "http://localhost:5173",
      },
      payload: {
        class_name_confirmation: archiveFixture.className,
        expected_class_id: archiveFixture.classId,
        expected_row_version: "1",
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const mismatch = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/archive",
      headers: {
        cookie: archiveFixture.cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": archiveFixture.csrf,
      },
      payload: {
        class_name_confirmation: `${archiveFixture.className} `,
        expected_class_id: archiveFixture.classId,
        expected_row_version: "1",
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: { code: "CLASS_NAME_CONFIRMATION_MISMATCH" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("classes")
        .select(["row_version", "status"])
        .where("id", "=", archiveFixture.classId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ row_version: "1", status: "active" });
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", archiveFixture.classId)
        .where("action", "=", "class.archived")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const studentLogin = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:5173" },
      payload: { email: approvedEmail, password: baseCommand.password },
    });
    const studentCookies = responseCookies(studentLogin.headers);
    const studentSession = rawCookie(studentCookies, SESSION_COOKIE_NAME);
    const studentCsrf = rawCookie(studentCookies, CSRF_COOKIE_NAME);
    const studentAttempt = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/classes/current/archive",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${studentSession}; ${CSRF_COOKIE_NAME}=${studentCsrf}`,
        origin: "http://localhost:5173",
        "x-csrf-token": studentCsrf,
      },
      payload: {
        class_name_confirmation: archiveFixture.className,
        expected_class_id: archiveFixture.classId,
        expected_row_version: "1",
      },
    });
    expect(studentAttempt.statusCode).toBe(403);
    expect(studentAttempt.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });

    let markUserLockReady!: () => void;
    const userLockReady = new Promise<void>((resolve) => {
      markUserLockReady = resolve;
    });
    let releaseUserLock!: () => void;
    const userLockRelease = new Promise<void>((resolve) => {
      releaseUserLock = resolve;
    });
    let userLockReleased = false;
    const releaseBlocker = () => {
      if (userLockReleased) return;
      userLockReleased = true;
      releaseUserLock();
    };
    const userBlocker = bootstrapDatabase.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", archiveFixture.teacherId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      markUserLockReady();
      await userLockRelease;
    });
    await withSafetyDeadline(userLockReady, 5_000, "Teacher user lock was not acquired.");

    const archiveRequest = () =>
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/classes/current/archive",
        headers: {
          cookie: archiveFixture.cookie,
          origin: "http://localhost:5173",
          "x-csrf-token": archiveFixture.csrf,
        },
        payload: {
          class_name_confirmation: archiveFixture.className,
          expected_class_id: archiveFixture.classId,
          expected_row_version: "1",
        },
      });
    const firstArchive = archiveRequest();
    const secondArchive = archiveRequest();
    try {
      const deadline = Date.now() + 5_000;
      let waiting = 0;
      while (Date.now() < deadline && waiting < 2) {
        const result = await sql<{ waiting: number }>`
          SELECT count(*)::integer AS waiting
          FROM pg_stat_activity
          WHERE usename = 'classhub_app'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%from "users"%'
        `.execute(bootstrapDatabase);
        waiting = result.rows[0]?.waiting ?? 0;
        if (waiting < 2) await delay(20);
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
      releaseBlocker();
    } finally {
      releaseBlocker();
    }

    const concurrent = await withSafetyDeadline(
      Promise.all([firstArchive, secondArchive]),
      10_000,
      "Concurrent class archive requests did not settle.",
    );
    await userBlocker;
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const success = concurrent.find((response) => response.statusCode === 200)!;
    const conflict = concurrent.find((response) => response.statusCode === 409)!;
    expect(success.json()).toMatchObject({
      class_id: archiveFixture.classId,
      next_action: "CREATE_CLASS",
      row_version: "2",
    });
    expect(conflict.json()).toMatchObject({ error: { code: "CLASS_ARCHIVE_CONFLICT" } });

    const requestId = String(success.headers["x-request-id"]);
    const [archivedClass, invite, afterMembers, histories, audits] = await Promise.all([
      bootstrapDatabase
        .selectFrom("classes")
        .select([
          "archived_at",
          "archived_by_operator_id",
          "archived_by_user_id",
          "row_version",
          "status",
          "updated_at",
        ])
        .where("id", "=", archiveFixture.classId)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_invite_codes")
        .select([
          "id",
          "revoke_reason",
          "revoked_at",
          "revoked_by_member_id",
          "revoked_by_operator_id",
        ])
        .where("class_id", "=", archiveFixture.classId)
        .where("code", "=", archiveFixture.inviteCode)
        .executeTakeFirstOrThrow(),
      bootstrapDatabase
        .selectFrom("class_members")
        .select([
          "id",
          "row_version",
          "status",
          "status_changed_at",
          "student_number",
          "updated_at",
        ])
        .where("class_id", "=", archiveFixture.classId)
        .orderBy("id", "asc")
        .execute(),
      bootstrapDatabase
        .selectFrom("class_member_status_history")
        .select([
          "actor_member_id",
          "actor_user_id",
          "created_at",
          "from_status",
          "member_id",
          "reason",
          "to_status",
        ])
        .where("class_id", "=", archiveFixture.classId)
        .where("reason", "=", "반 운영 종료")
        .orderBy("id", "asc")
        .execute(),
      bootstrapDatabase
        .selectFrom("audit_logs")
        .select([
          "action",
          "actor_member_id",
          "actor_role_snapshot",
          "actor_user_id",
          "after_json",
          "before_json",
          "class_id",
          "created_at",
          "reason",
          "target_id",
          "target_snapshot",
          "target_type",
        ])
        .where("class_id", "=", archiveFixture.classId)
        .where("request_id", "=", requestId)
        .orderBy("id", "asc")
        .execute(),
    ]);

    expect(archivedClass).toMatchObject({
      archived_by_operator_id: null,
      archived_by_user_id: archiveFixture.teacherId,
      row_version: "2",
      status: "archived",
    });
    expect(archivedClass.archived_at).toBeInstanceOf(Date);
    const occurredAt = archivedClass.archived_at!.getTime();
    expect(archivedClass.updated_at.getTime()).toBe(occurredAt);
    expect(success.json().archived_at).toBe(archivedClass.archived_at!.toISOString());
    expect(invite).toMatchObject({
      revoke_reason: "반 운영 종료",
      revoked_by_member_id: archiveFixture.teacherMemberId,
      revoked_by_operator_id: null,
    });
    expect(invite.revoked_at?.getTime()).toBe(occurredAt);

    expect(afterMembers).toHaveLength(beforeMembers.length);
    for (const [index, member] of afterMembers.entries()) {
      const before = beforeMembers[index]!;
      expect(member.id).toBe(before.id);
      expect(member.row_version).toBe((BigInt(before.row_version) + 1n).toString());
      expect(member.status).toBe(before.status === "pending" ? "canceled" : "archived");
      expect(member.student_number).toBeNull();
      expect(member.status_changed_at.getTime()).toBe(occurredAt);
      expect(member.updated_at.getTime()).toBe(occurredAt);
    }
    expect(histories.map((history) => history.member_id)).toEqual(
      beforeMembers.map((member) => member.id),
    );
    for (const history of histories) {
      expect(history).toMatchObject({
        actor_member_id: archiveFixture.teacherMemberId,
        actor_user_id: archiveFixture.teacherId,
        reason: "반 운영 종료",
      });
      expect(history.to_status).toBe(history.from_status === "pending" ? "canceled" : "archived");
      expect(history.created_at.getTime()).toBe(occurredAt);
    }

    expect(audits).toEqual([
      {
        action: "class.archived",
        actor_member_id: archiveFixture.teacherMemberId,
        actor_role_snapshot: "teacher",
        actor_user_id: archiveFixture.teacherId,
        after_json: {
          archived_at: archivedClass.archived_at!.toISOString(),
          status: "archived",
        },
        before_json: { archived_at: null, status: "active" },
        class_id: archiveFixture.classId,
        created_at: archivedClass.archived_at,
        reason: null,
        target_id: archiveFixture.classId,
        target_snapshot: null,
        target_type: "class",
      },
      {
        action: "invite_code.revoked",
        actor_member_id: archiveFixture.teacherMemberId,
        actor_role_snapshot: "teacher",
        actor_user_id: archiveFixture.teacherId,
        after_json: {
          revoke_reason: "반 운영 종료",
          revoked_at: archivedClass.archived_at!.toISOString(),
        },
        before_json: { revoke_reason: null, revoked_at: null },
        class_id: archiveFixture.classId,
        created_at: archivedClass.archived_at,
        reason: "반 운영 종료",
        target_id: invite.id,
        target_snapshot: null,
        target_type: "invite_code",
      },
    ]);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(archiveFixture.inviteCode);
    expect(serializedAudits).not.toContain(archiveFixture.teacherEmail);
    expect(serializedAudits).not.toContain(approvedEmail);
    expect(serializedAudits).not.toContain(baseCommand.password);
    expect(serializedAudits).not.toContain('"student_number"');
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", archiveFixture.classId)
        .where("action", "like", "member.%")
        .where("request_id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await bootstrapDatabase
        .selectFrom("class_members")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", archiveFixture.classId)
        .where("status", "in", ["pending", "approved"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await bootstrapDatabase
        .selectFrom("class_invite_codes")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", archiveFixture.classId)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const bootstrap = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie: archiveFixture.cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      current_class: null,
      current_membership: null,
      destination: "CREATE_CLASS",
    });
    const formerCurrent = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/classes/current",
      headers: { cookie: archiveFixture.cookie },
    });
    expect(formerCurrent.statusCode).toBe(404);
  }, 45_000);

  it("archive-state-races fail closed for suspended, temporary-password, account, and profile states", async () => {
    const archiveCall = (target: ArchiveHttpFixture) =>
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/classes/current/archive",
        headers: {
          cookie: target.cookie,
          origin: "http://localhost:5173",
          "x-csrf-token": target.csrf,
        },
        payload: {
          class_name_confirmation: target.className,
          expected_class_id: target.classId,
          expected_row_version: "1",
        },
      });

    const suspended = await createArchiveHttpFixture("suspended", fixture.operatorId);
    const suspendedAt = new Date();
    await bootstrapDatabase
      .updateTable("classes")
      .set({
        row_version: sql`row_version + 1`,
        status: "suspended",
        suspended_at: suspendedAt,
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "아카이브 권한 경합 테스트",
        updated_at: suspendedAt,
      })
      .where("id", "=", suspended.classId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const suspendedResponse = await archiveCall(suspended);
    expect(suspendedResponse.statusCode).toBe(423);
    expect(suspendedResponse.json()).toMatchObject({ error: { code: "CLASS_SUSPENDED" } });

    const temporaryPassword = await createArchiveHttpFixture("temporary", fixture.operatorId);
    await bootstrapDatabase
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: new Date(Date.now() + 60_000),
        temporary_password_must_change: true,
      })
      .where("user_id", "=", temporaryPassword.teacherId)
      .executeTakeFirstOrThrow();
    const temporaryResponse = await archiveCall(temporaryPassword);
    expect(temporaryResponse.statusCode).toBe(403);
    expect(temporaryResponse.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });

    const accountRace = await createArchiveHttpFixture("account-race", fixture.operatorId);
    let markAccountLockReady!: () => void;
    const accountLockReady = new Promise<void>((resolve) => {
      markAccountLockReady = resolve;
    });
    let releaseAccountRace!: () => void;
    const accountRaceRelease = new Promise<void>((resolve) => {
      releaseAccountRace = resolve;
    });
    const accountBlocker = bootstrapDatabase.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", accountRace.teacherId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      markAccountLockReady();
      await accountRaceRelease;
      const changedAt = new Date();
      await transaction
        .updateTable("classes")
        .set({
          row_version: sql`row_version + 1`,
          status: "suspended",
          suspended_at: changedAt,
          suspended_by_operator_id: fixture.operatorId,
          suspended_reason: "계정 비활성화 경합",
          updated_at: changedAt,
        })
        .where("id", "=", accountRace.classId)
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("users")
        .set({ is_active: false, updated_at: changedAt })
        .where("id", "=", accountRace.teacherId)
        .where("is_active", "=", true)
        .executeTakeFirstOrThrow();
    });
    await withSafetyDeadline(accountLockReady, 5_000, "Account race lock was not acquired.");
    const accountArchive = archiveCall(accountRace);
    await waitForApplicationLockWait('from "users"');
    releaseAccountRace();
    const accountResponse = await withSafetyDeadline(
      accountArchive,
      10_000,
      "Account race archive did not settle.",
    );
    await accountBlocker;
    expect(accountResponse.statusCode).toBe(401);
    expect(accountResponse.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    const profileRace = await createArchiveHttpFixture("profile-race", fixture.operatorId);
    let markProfileLockReady!: () => void;
    const profileLockReady = new Promise<void>((resolve) => {
      markProfileLockReady = resolve;
    });
    let releaseProfileRace!: () => void;
    const profileRaceRelease = new Promise<void>((resolve) => {
      releaseProfileRace = resolve;
    });
    const profileBlocker = bootstrapDatabase.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("teacher_profiles")
        .select("user_id")
        .where("user_id", "=", profileRace.teacherId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      markProfileLockReady();
      await profileRaceRelease;
      await transaction
        .updateTable("teacher_profiles")
        .set({
          temporary_password_expires_at: new Date(Date.now() + 60_000),
          temporary_password_must_change: true,
        })
        .where("user_id", "=", profileRace.teacherId)
        .executeTakeFirstOrThrow();
    });
    await withSafetyDeadline(profileLockReady, 5_000, "Profile race lock was not acquired.");
    const profileArchive = archiveCall(profileRace);
    await waitForApplicationLockWait('from "teacher_profiles"');
    releaseProfileRace();
    const profileResponse = await withSafetyDeadline(
      profileArchive,
      10_000,
      "Profile race archive did not settle.",
    );
    await profileBlocker;
    expect(profileResponse.statusCode).toBe(403);
    expect(profileResponse.json()).toMatchObject({ error: { code: "ROLE_INSUFFICIENT" } });

    for (const target of [suspended, temporaryPassword, accountRace, profileRace]) {
      const state = await bootstrapDatabase
        .selectFrom("classes")
        .select("status")
        .where("id", "=", target.classId)
        .executeTakeFirstOrThrow();
      expect(state.status).not.toBe("archived");
      expect(
        await bootstrapDatabase
          .selectFrom("audit_logs")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("class_id", "=", target.classId)
          .where("action", "=", "class.archived")
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: "0" });
    }
  }, 45_000);
});

describe("class archive adversarial integration", () => {
  it("archive-adversarial-operations leave no join, approval, or notice CUD writes after archive wins", async () => {
    const operatorId = (
      await bootstrapDatabase
        .insertInto("operators")
        .values({
          credential_hash: createHash("sha256").update("archive-adversarial-operator").digest(),
          email_normalized: "archive-adversarial-operator@classhub.local",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await bootstrapDatabase
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "보관 경쟁 교육청",
        region_name: "서울",
        school_code: "1234567",
        school_kind: "middle",
        school_name: "보관 경쟁 중학교",
      })
      .onConflict((conflict) => conflict.columns(["edu_office_code", "school_code"]).doNothing())
      .execute();
    const commandHeaders = (target: ArchiveHttpFixture) => ({
      cookie: target.cookie,
      origin: "http://localhost:5173",
      "x-csrf-token": target.csrf,
    });
    const archiveCall = (target: ArchiveHttpFixture) =>
      httpApplication.inject({
        method: "POST",
        url: "/api/v1/classes/current/archive",
        headers: commandHeaders(target),
        payload: {
          class_name_confirmation: target.className,
          expected_class_id: target.classId,
          expected_row_version: "1",
        },
      });
    const createStudentAuth = async (label: string) => {
      const email = "archive-race-" + label + "-" + randomUUID() + "@example.com";
      const userId = await createTestUser(email);
      const login = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: "http://localhost:5173" },
        payload: { email, password: baseCommand.password },
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookies = responseCookies(login.headers);
      const session = rawCookie(cookies, SESSION_COOKIE_NAME);
      const csrf = rawCookie(cookies, CSRF_COOKIE_NAME);
      return {
        cookie: SESSION_COOKIE_NAME + "=" + session + "; " + CSRF_COOKIE_NAME + "=" + csrf,
        csrf,
        userId,
      };
    };
    const seedNotice = async (target: ArchiveHttpFixture, label: string): Promise<string> => {
      const created = await httpApplication.inject({
        method: "POST",
        url: "/api/v1/notices",
        headers: {
          ...commandHeaders(target),
          "idempotency-key": randomUUID(),
        },
        payload: { content: label + " 원문", title: label + " 공지" },
      });
      expect(created.statusCode, created.body).toBe(201);
      return (created.json() as { id: string }).id;
    };
    const raceArchiveFirst = async (
      target: ArchiveHttpFixture,
      startCompetitor: () => Promise<{
        json(): unknown;
        statusCode: number;
      }>,
      competitorWaitFragment: string,
    ): Promise<{ json(): unknown; statusCode: number }> => {
      let markAuditLockReady!: () => void;
      const auditLockReady = new Promise<void>((resolve) => {
        markAuditLockReady = resolve;
      });
      let resolveAuditLock!: () => void;
      const auditLockRelease = new Promise<void>((resolve) => {
        resolveAuditLock = resolve;
      });
      let auditLockReleased = false;
      const releaseAuditLock = () => {
        if (auditLockReleased) return;
        auditLockReleased = true;
        resolveAuditLock();
      };
      const auditBlocker = bootstrapDatabase.transaction().execute(async (transaction) => {
        await sql.raw("LOCK TABLE audit_logs IN SHARE MODE").execute(transaction);
        markAuditLockReady();
        await auditLockRelease;
      });
      await withSafetyDeadline(auditLockReady, 5_000, "Audit table lock was not acquired.");

      const archivePromise = archiveCall(target);
      let competitorPromise: Promise<{ json(): unknown; statusCode: number }> | undefined;
      try {
        await waitForApplicationLockWait('insert into "audit_logs"');
        competitorPromise = startCompetitor();
        await waitForApplicationLockWait(competitorWaitFragment);
        releaseAuditLock();

        const [archiveResponse, competitorResponse] = await Promise.all([
          withSafetyDeadline(archivePromise, 10_000, "Archive operation did not settle."),
          withSafetyDeadline(competitorPromise, 10_000, "Competing operation did not settle."),
        ]);
        await auditBlocker;
        expect(archiveResponse.statusCode, archiveResponse.body).toBe(200);
        return competitorResponse;
      } finally {
        releaseAuditLock();
        await Promise.allSettled([
          auditBlocker,
          archivePromise,
          ...(competitorPromise === undefined ? [] : [competitorPromise]),
        ]);
      }
    };

    const joinFixture = await createArchiveHttpFixture("race-join", operatorId);
    const joiningStudent = await createStudentAuth("join");
    const joinResponse = await raceArchiveFirst(
      joinFixture,
      () =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/membership-requests",
          headers: {
            cookie: joiningStudent.cookie,
            origin: "http://localhost:5173",
            "x-csrf-token": joiningStudent.csrf,
          },
          payload: { invite_code: joinFixture.inviteCode },
        }),
      'from "classes"',
    );
    expect(joinResponse.statusCode).toBe(400);
    expect(joinResponse.json()).toMatchObject({
      error: { code: "INVITE_CODE_INVALID_OR_EXPIRED" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("class_members")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", joinFixture.classId)
        .where("user_id", "=", joiningStudent.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", joinFixture.classId)
        .where("actor_user_id", "=", joiningStudent.userId)
        .where("action", "=", "member.requested")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const approveFixture = await createArchiveHttpFixture("race-approve", operatorId);
    const pendingStudent = await createStudentAuth("approve");
    const pendingMemberId = await insertStudentMembership(
      approveFixture,
      pendingStudent.userId,
      "pending",
    );
    const approveResponse = await raceArchiveFirst(
      approveFixture,
      () =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/members/" + pendingMemberId + "/approve",
          headers: commandHeaders(approveFixture),
          payload: {
            display_name_in_class: "경쟁 승인 학생",
            student_number: 9,
          },
        }),
      'from "users"',
    );
    expect(approveResponse.statusCode).toBe(404);
    expect(approveResponse.json()).toMatchObject({
      error: { code: "MEMBER_NOT_FOUND" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("class_members")
        .select(["row_version", "status", "student_number"])
        .where("id", "=", pendingMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      row_version: "2",
      status: "canceled",
      student_number: null,
    });
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("target_id", "=", pendingMemberId)
        .where("action", "=", "member.approved")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const createFixture = await createArchiveHttpFixture("race-notice-create", operatorId);
    const createKey = randomUUID();
    const createTitle = "보관 경쟁 생성 " + randomUUID();
    const createResponse = await raceArchiveFirst(
      createFixture,
      () =>
        httpApplication.inject({
          method: "POST",
          url: "/api/v1/notices",
          headers: {
            ...commandHeaders(createFixture),
            "idempotency-key": createKey,
          },
          payload: {
            content: "보관 뒤 남으면 안 되는 내용",
            title: createTitle,
          },
        }),
      'from "users"',
    );
    expect(createResponse.statusCode).toBe(404);
    expect(createResponse.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("notices")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("class_id", "=", createFixture.classId)
        .where("title", "=", createTitle)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
    expect(
      await bootstrapDatabase
        .selectFrom("api_idempotency_keys")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("actor_user_id", "=", createFixture.teacherId)
        .where("idempotency_key", "=", createKey)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const updateFixture = await createArchiveHttpFixture("race-notice-update", operatorId);
    const updateNoticeId = await seedNotice(updateFixture, "수정 경쟁");
    const updateBefore = await bootstrapDatabase
      .selectFrom("notices")
      .selectAll()
      .where("id", "=", updateNoticeId)
      .executeTakeFirstOrThrow();
    const updateResponse = await raceArchiveFirst(
      updateFixture,
      () =>
        httpApplication.inject({
          method: "PATCH",
          url: "/api/v1/notices/" + updateNoticeId,
          headers: {
            ...commandHeaders(updateFixture),
            "if-match": '"1"',
          },
          payload: { content: "보관 뒤 반영되면 안 되는 수정" },
        }),
      'from "users"',
    );
    expect(updateResponse.statusCode).toBe(404);
    expect(updateResponse.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", updateNoticeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(updateBefore);
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("target_id", "=", updateNoticeId)
        .where("action", "=", "notice.updated")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });

    const deleteFixture = await createArchiveHttpFixture("race-notice-delete", operatorId);
    const deleteNoticeId = await seedNotice(deleteFixture, "삭제 경쟁");
    const deleteBefore = await bootstrapDatabase
      .selectFrom("notices")
      .selectAll()
      .where("id", "=", deleteNoticeId)
      .executeTakeFirstOrThrow();
    const deleteResponse = await raceArchiveFirst(
      deleteFixture,
      () =>
        httpApplication.inject({
          method: "DELETE",
          url: "/api/v1/notices/" + deleteNoticeId,
          headers: {
            ...commandHeaders(deleteFixture),
            "if-match": '"1"',
          },
          payload: { reason: "보관 뒤 반영되면 안 되는 삭제" },
        }),
      'from "users"',
    );
    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json()).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(
      await bootstrapDatabase
        .selectFrom("notices")
        .selectAll()
        .where("id", "=", deleteNoticeId)
        .executeTakeFirstOrThrow(),
    ).toEqual(deleteBefore);
    expect(
      await bootstrapDatabase
        .selectFrom("audit_logs")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("target_id", "=", deleteNoticeId)
        .where("action", "=", "notice.deleted")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "0" });
  }, 90_000);
});

describe("local test admin integration", () => {
  it("logs in an operator and creates, lists, and deletes only a test account", async () => {
    const rawOperatorToken = "O".repeat(43);
    await bootstrapDatabase
      .insertInto("operators")
      .values({
        credential_hash: createHash("sha256").update(rawOperatorToken).digest(),
        email_normalized: "admin@classhub.local",
      })
      .execute();

    const login = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/local-test-admin/login",
      headers: { origin: "http://localhost:5173" },
      payload: { password: localAdminTestPassword, username: "admin" },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const sessionToken = rawCookie(cookies, LOCAL_ADMIN_SESSION_COOKIE);
    const csrfToken = rawCookie(cookies, LOCAL_ADMIN_CSRF_COOKIE);
    const cookieHeader = `${LOCAL_ADMIN_SESSION_COOKIE}=${sessionToken}; ${LOCAL_ADMIN_CSRF_COOKIE}=${csrfToken}`;
    const accountPayload = {
      display_name: "관리 테스트",
      email: "local-admin-created@example.com",
      email_verified: true,
      password: "Local123",
    };

    const missingCsrf = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/local-test-admin/accounts",
      headers: { cookie: cookieHeader, origin: "http://localhost:5173" },
      payload: accountPayload,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const created = await httpApplication.inject({
      method: "POST",
      url: "/api/v1/local-test-admin/accounts",
      headers: {
        cookie: cookieHeader,
        origin: "http://localhost:5173",
        "x-local-admin-csrf": csrfToken,
      },
      payload: accountPayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: accountPayload.email, email_verified: true });

    const listed = await httpApplication.inject({
      method: "GET",
      url: "/api/v1/local-test-admin/accounts",
      headers: { cookie: cookieHeader },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: accountPayload.email })]),
    );

    const deleted = await httpApplication.inject({
      method: "DELETE",
      url: `/api/v1/local-test-admin/accounts/${created.json().id}`,
      headers: {
        cookie: cookieHeader,
        origin: "http://localhost:5173",
        "x-local-admin-csrf": csrfToken,
      },
      payload: { email: accountPayload.email },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deleted: true,
      deleted_counts: { consents: 3, users: 1 },
    });
    await expect(getUserId(accountPayload.email)).rejects.toThrow();
  });
});
