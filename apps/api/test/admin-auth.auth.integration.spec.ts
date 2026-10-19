import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB, verifyPassword } from "@classhub/db";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RESET_MAILER } from "../src/auth/auth.tokens.js";
import type { PasswordResetMailer } from "../src/mail/password-reset-mailer.js";

import { provisionAdmin } from "../../operator-cli/src/admin-provision.js";
import { createApplication } from "../src/app.factory.js";
import { decodeBase32, hotp, totpCodeAt } from "../src/admin-auth/admin-auth.crypto.js";
import {
  ADMIN_CHALLENGE_COOKIE_NAME,
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
} from "../src/admin-auth/admin-auth.cookies.js";
import { AdminUsersService } from "../src/admin-management/admin-users.service.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import { hashPassword } from "../src/auth/password-hasher.js";
import { hashSessionSecret, issueSessionSecrets } from "../src/auth/session-crypto.js";
import { loadEnvironment } from "../src/config/environment.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const publicOrigin = "https://classhub.test";
const operatorToken = randomBytes(32).toString("base64url");
const adminEmail = "security-admin@example.com";
const clientIp = "203.0.113.42";

let postgres: StartedNativeTestService;
let redis: StartedNativeTestService;
let requestLimitObserver: RedisClientType;
let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let application: NestFastifyApplication;
let integrationEnvironment: ReturnType<typeof loadEnvironment>;
let adminAccountId: string;
let initialPassword: string;
let manualKey: string;
let sessionCookie: string;
let csrfToken: string;
let enrollmentCode: string;
let stepUpCode: string;

function reachableHost(container: StartedNativeTestService): string {
  return container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
}

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${reachableHost(postgres)}:${postgres.getMappedPort(5432)}/classhub_dev`;
}

function responseCookies(headers: {
  "set-cookie"?: number | string | string[] | undefined;
}): string[] {
  const value = headers["set-cookie"];
  if (value === undefined || typeof value === "number") return [];
  return Array.isArray(value) ? value : [value];
}

function rawCookie(cookies: string[], name: string): string {
  const cookie = cookies.find(
    (value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`),
  );
  const raw = cookie?.slice(name.length + 1).split(";", 1)[0];
  if (raw === undefined || raw.length === 0) throw new Error(`${name} cookie is missing.`);
  return raw;
}

function expectHardenedCookie(cookie: string | undefined, httpOnly: boolean): void {
  expect(cookie).toBeDefined();
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  if (httpOnly) expect(cookie).toContain("HttpOnly");
  else expect(cookie).not.toContain("HttpOnly");
}

/*
 * 테스트용 PostgreSQL은 WSL에서 돌아 challenge.created_at(DB clock_timestamp)이 Windows 앱 시계보다
 * 수백 ms 앞설 수 있다(2026-09-24 실측 -0.65~+0.1초). 그러면 앱 시계로 적는 consumed_at이
 * consumed_at >= created_at 검사에 걸려 500이 난다. 운영처럼 DB·앱이 같은 시계를 쓰도록
 * 열린 challenge의 생성 시각만 몇 초 앞당긴다. (DB·앱이 다른 기계가 될 때의 규칙은 별도 과제)
 */
async function absorbTestDatabaseClockSkew(): Promise<void> {
  await bootstrapDatabase
    .updateTable("admin_login_challenges")
    .set({ created_at: sql<Date>`created_at - interval '5 seconds'` })
    .where("consumed_at", "is", null)
    .execute();
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
  await bootstrapDatabase
    .insertInto("operators")
    .values({
      credential_hash: createHash("sha256").update(operatorToken, "utf8").digest(),
      email_normalized: "operator@example.com",
    })
    .execute();

  const environment = loadEnvironment({
    ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
    ADMIN_MFA_KEY_VERSION: "integration-1",
    ADMIN_WEB_ENABLED: "true",
    DATABASE_URL: postgresUrl("classhub_app", "local_app_password"),
    EMAIL_HMAC_KEY: "admin-auth-integration-hmac-key-32-bytes",
    EMAIL_HMAC_KEY_VERSION: "integration-1",
    LOG_LEVEL: "fatal",
    NODE_ENV: "test",
    PUBLIC_API_ORIGIN: publicOrigin,
    PUBLIC_APP_ORIGIN: publicOrigin,
    REDIS_URL: `redis://${reachableHost(redis)}:${redis.getMappedPort(6379)}`,
    SERVE_WEB: "false",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
  });
  integrationEnvironment = environment;
  ({ app: application } = await createApplication({ environment }));
  requestLimitObserver = createClient({ url: environment.REDIS_URL });
  requestLimitObserver.on("error", () => undefined);
  await requestLimitObserver.connect();
}, 120_000);

beforeEach(async () => {
  // Tests share domain fixtures, while each scenario owns its request budget.
  const keys = await requestLimitObserver.keys("*:policy:*");
  if (keys.length > 0) await requestLimitObserver.del(keys);
});

afterAll(async () => {
  if (requestLimitObserver?.isOpen) requestLimitObserver.destroy();
  const outcomes = await Promise.allSettled([
    application?.close(),
    bootstrapDatabase?.destroy(),
    redis?.stop(),
    postgres?.stop(),
  ]);
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}, 120_000);

describe.sequential("admin auth foundation", () => {
  it("provisions one role through the authenticated operator CLI and is idempotent", async () => {
    const result = await provisionAdmin({
      displayName: "보안 감사 관리자",
      email: adminEmail,
      operatorDatabaseUrl: postgresUrl("classhub_operator", "local_operator_password"),
      operatorToken,
      role: "security_auditor",
    });
    expect(result.created).toBe(true);
    if (!result.created) throw new Error("expected a newly provisioned admin");
    adminAccountId = result.adminAccountId;
    initialPassword = result.rawInitialPassword;

    const repeated = await provisionAdmin({
      displayName: "무시되는 이름",
      email: adminEmail.toUpperCase(),
      operatorDatabaseUrl: postgresUrl("classhub_operator", "local_operator_password"),
      operatorToken,
      role: "security_auditor",
    });
    expect(repeated).toMatchObject({
      adminAccountId,
      created: false,
      rawInitialPassword: null,
      status: "pending_mfa",
    });

    const audits = await bootstrapDatabase
      .selectFrom("operator_audit_logs")
      .select(["action", "after_json"])
      .where("action", "=", "admin.created")
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "admin.created",
      after_json: {
        admin_account_id: adminAccountId,
        admin_account_status: "pending_mfa",
        role: "security_auditor",
      },
    });
    expect(JSON.stringify(audits)).not.toContain(adminEmail);
    expect(JSON.stringify(audits)).not.toContain(initialPassword);
  });

  it("enrolls TOTP and issues cookies separated from product-user sessions", async () => {
    const login = await application.inject({
      headers: { origin: publicOrigin, "x-forwarded-for": clientIp },
      method: "POST",
      payload: { email: adminEmail, password: initialPassword },
      url: "/api/v1/admin/auth/login",
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json<{
      challenge_expires_at: string;
      next_step: string;
      setup: { manual_key: string; otpauth_uri: string };
    }>();
    expect(loginBody.next_step).toBe("enroll_totp");
    expect(loginBody.setup.otpauth_uri).toContain("otpauth://totp/");
    manualKey = loginBody.setup.manual_key;
    const loginCookies = responseCookies(login.headers);
    const challengeToken = rawCookie(loginCookies, ADMIN_CHALLENGE_COOKIE_NAME);
    expectHardenedCookie(
      loginCookies.find((cookie) => cookie.startsWith(`${ADMIN_CHALLENGE_COOKIE_NAME}=`)),
      true,
    );
    expect(loginCookies.join("\n")).not.toContain("__Host-classhub_session=");

    const secret = decodeBase32(manualKey);
    enrollmentCode = totpCodeAt(secret, Date.now());
    await absorbTestDatabaseClockSkew();
    const complete = await application.inject({
      headers: {
        cookie: `${ADMIN_CHALLENGE_COOKIE_NAME}=${challengeToken}`,
        origin: publicOrigin,
        "x-forwarded-for": clientIp,
      },
      method: "POST",
      payload: { totp_code: enrollmentCode },
      url: "/api/v1/admin/auth/totp",
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      account: {
        email: adminEmail,
        id: adminAccountId,
        roles: ["security_auditor"],
      },
    });
    const issuedSession = complete.json<{
      server_now: string;
      session: {
        issued_at: string;
        absolute_expires_at: string;
      };
    }>();
    expect(
      Date.parse(issuedSession.session.absolute_expires_at) -
        Date.parse(issuedSession.session.issued_at),
    ).toBe(30 * 60_000);
    expect(Date.parse(issuedSession.server_now)).toBeLessThan(
      Date.parse(issuedSession.session.absolute_expires_at),
    );
    const sessionCookies = responseCookies(complete.headers);
    sessionCookie = rawCookie(sessionCookies, ADMIN_SESSION_COOKIE_NAME);
    csrfToken = rawCookie(sessionCookies, ADMIN_CSRF_COOKIE_NAME);
    expectHardenedCookie(
      sessionCookies.find((cookie) => cookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)),
      true,
    );
    expectHardenedCookie(
      sessionCookies.find((cookie) => cookie.startsWith(`${ADMIN_CSRF_COOKIE_NAME}=`)),
      false,
    );

    const account = await bootstrapDatabase
      .selectFrom("admin_accounts")
      .select(["status", "last_login_at"])
      .where("id", "=", adminAccountId)
      .executeTakeFirstOrThrow();
    const factor = await bootstrapDatabase
      .selectFrom("admin_mfa_factors")
      .select(["secret_ciphertext", "status"])
      .where("admin_account_id", "=", adminAccountId)
      .executeTakeFirstOrThrow();
    expect(account.status).toBe("active");
    expect(account.last_login_at).toBeInstanceOf(Date);
    expect(factor.status).toBe("active");
    expect(factor.secret_ciphertext.equals(Buffer.from(manualKey, "utf8"))).toBe(false);
  });

  it("requires recent step-up for changes but renews without another password or OTP", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const headers = { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken };
    const issuedAt = new Date(Date.now() - 15 * 60_000);
    const oldExpiry = new Date(issuedAt.getTime() + 30 * 60_000);
    await bootstrapDatabase
      .updateTable("admin_sessions")
      .set({
        issued_at: issuedAt,
        mfa_verified_at: issuedAt,
        reauthenticated_at: null,
        absolute_expires_at: oldExpiry,
      })
      .where("session_hash", "=", hashSessionSecret(sessionCookie))
      .execute();
    // This account-management check needs a disposable account-manager role, then restores it.
    await bootstrapDatabase
      .updateTable("admin_account_roles")
      .set({ role: "account_manager" })
      .where("admin_account_id", "=", adminAccountId)
      .execute();
    const target = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "세션 검증 대상",
        email_normalized: "session-target@example.com",
        password_hash: "synthetic-unused-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const before = await application.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/admin/auth/session",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().session.absolute_expires_at).toBe(oldExpiry.toISOString());
    const changed = await application.inject({
      headers,
      method: "PATCH",
      payload: { reason: "격리 계정 관리 검증", status: "inactive" },
      url: `/api/v1/admin/users/${target.id}/status`,
    });
    expect(changed.statusCode).toBe(401);
    expect(changed.json()).toMatchObject({ error: { code: "ADMIN_STEP_UP_REQUIRED" } });
    const unchanged = await application.inject({
      headers,
      method: "PATCH",
      payload: { reason: "동일 상태 확인", status: "inactive" },
      url: `/api/v1/admin/users/${target.id}/status`,
    });
    expect(unchanged.statusCode).toBe(401);
    expect(unchanged.json()).toMatchObject({ error: { code: "ADMIN_STEP_UP_REQUIRED" } });
    const auditBefore = await bootstrapDatabase
      .selectFrom("admin_auth_audit_logs")
      .select("id")
      .where("admin_account_id", "=", adminAccountId)
      .execute();
    for (const rejectedHeaders of [
      { cookie, origin: publicOrigin },
      { ...headers, origin: "https://untrusted.example" },
    ]) {
      const rejected = await application.inject({
        headers: rejectedHeaders,
        method: "POST",
        url: "/api/v1/admin/auth/renew",
      });
      expect(rejected.statusCode).toBe(403);
    }
    const renewed = await application.inject({
      headers,
      method: "POST",
      url: "/api/v1/admin/auth/renew",
    });
    expect(renewed.statusCode).toBe(200);
    const renewedBody = renewed.json();
    const newExpiry = Date.parse(renewedBody.session.absolute_expires_at);
    expect(newExpiry - Date.parse(renewedBody.server_now)).toBeGreaterThan(29 * 60_000);
    expect(newExpiry - Date.parse(renewedBody.server_now)).toBeLessThanOrEqual(30 * 60_000);
    expect(renewedBody.session.mfa_verified_at).toBe(issuedAt.toISOString());
    expect(renewedBody.session.reauthenticated_at).toBeNull();
    const stillDenied = await application.inject({
      headers,
      method: "PATCH",
      payload: { reason: "연장 후 확인", status: "inactive" },
      url: `/api/v1/admin/users/${target.id}/status`,
    });
    expect(stillDenied.statusCode).toBe(401);
    const unchangedUser = await bootstrapDatabase
      .selectFrom("users")
      .select("is_active")
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(unchangedUser.is_active).toBe(true);
    const cookies = responseCookies(renewed.headers);
    expect(rawCookie(cookies, ADMIN_SESSION_COOKIE_NAME)).toBe(sessionCookie);
    expect(rawCookie(cookies, ADMIN_CSRF_COOKIE_NAME)).toBe(csrfToken);
    expectHardenedCookie(
      cookies.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)),
      true,
    );
    expectHardenedCookie(
      cookies.find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE_NAME}=`)),
      false,
    );
    expect(cookies.every((value) => /Max-Age=17\d\d|Max-Age=1800/u.test(value))).toBe(true);
    const after = await application.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/admin/auth/session",
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().session.absolute_expires_at).toBe(renewedBody.session.absolute_expires_at);
    const auditAfter = await bootstrapDatabase
      .selectFrom("admin_auth_audit_logs")
      .select("id")
      .where("admin_account_id", "=", adminAccountId)
      .execute();
    expect(auditAfter).toEqual(auditBefore);
    await bootstrapDatabase
      .updateTable("admin_account_roles")
      .set({ role: "security_auditor" })
      .where("admin_account_id", "=", adminAccountId)
      .execute();
  });

  it("rejects TOTP replay, then records a fresh password-plus-TOTP step-up", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const replay = await application.inject({
      headers: { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken },
      method: "POST",
      payload: { password: initialPassword, totp_code: enrollmentCode },
      url: "/api/v1/admin/auth/step-up",
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "ADMIN_MFA_INVALID" } });

    const factor = await bootstrapDatabase
      .selectFrom("admin_mfa_factors")
      .select("last_accepted_timestep")
      .where("admin_account_id", "=", adminAccountId)
      .executeTakeFirstOrThrow();
    const nextTimestep = BigInt(factor.last_accepted_timestep!) + 1n;
    stepUpCode = hotp(decodeBase32(manualKey), nextTimestep);
    const succeeded = await application.inject({
      headers: { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken },
      method: "POST",
      payload: { password: initialPassword, totp_code: stepUpCode },
      url: "/api/v1/admin/auth/step-up",
    });
    expect(succeeded.statusCode).toBe(200);
    expect(succeeded.json()).toEqual({
      reauthenticated_at: expect.any(String),
      valid_until: expect.any(String),
    });
  });

  it("allows a fresh proof, rejects its five-minute expiry and keeps renewal separate", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const headers = { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken };
    const proof = await bootstrapDatabase
      .selectFrom("admin_sessions")
      .select("reauthenticated_at")
      .where("session_hash", "=", hashSessionSecret(sessionCookie))
      .executeTakeFirstOrThrow();
    expect(proof.reauthenticated_at).toBeInstanceOf(Date);
    await bootstrapDatabase
      .updateTable("admin_account_roles")
      .set({ role: "account_manager" })
      .where("admin_account_id", "=", adminAccountId)
      .execute();
    const target = await bootstrapDatabase
      .selectFrom("users")
      .select("id")
      .where("email_normalized", "=", "session-target@example.com")
      .executeTakeFirstOrThrow();
    const url = `/api/v1/admin/users/${target.id}/status`;
    const changed = await application.inject({
      headers,
      method: "PATCH",
      url,
      payload: { reason: "재인증 후 변경", status: "inactive" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ user: { is_active: false } });
    await bootstrapDatabase
      .updateTable("admin_sessions")
      .set({ reauthenticated_at: new Date(Date.now() - 300001) })
      .where("session_hash", "=", hashSessionSecret(sessionCookie))
      .execute();
    const renewed = await application.inject({
      headers,
      method: "POST",
      url: "/api/v1/admin/auth/renew",
    });
    expect(renewed.statusCode).toBe(200);
    const denied = await application.inject({
      headers,
      method: "PATCH",
      url,
      payload: { reason: "만료된 증명", status: "active" },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ error: { code: "ADMIN_STEP_UP_REQUIRED" } });
    expect(
      (
        await bootstrapDatabase
          .selectFrom("users")
          .select("is_active")
          .where("id", "=", target.id)
          .executeTakeFirstOrThrow()
      ).is_active,
    ).toBe(false);
    await bootstrapDatabase
      .updateTable("admin_sessions")
      .set({ reauthenticated_at: proof.reauthenticated_at })
      .where("session_hash", "=", hashSessionSecret(sessionCookie))
      .execute();
    await bootstrapDatabase
      .updateTable("admin_account_roles")
      .set({ role: "security_auditor" })
      .where("admin_account_id", "=", adminAccountId)
      .execute();
  });

  it("expires a separate idle session at 30 minutes and keeps the original session usable", async () => {
    const idleSecrets = issueSessionSecrets();
    const issuedAt = new Date(Date.now() - 31 * 60 * 1_000);
    const absoluteExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await bootstrapDatabase
      .insertInto("admin_sessions")
      .values({
        absolute_expires_at: absoluteExpiresAt,
        admin_account_id: adminAccountId,
        created_ip_hmac: "a".repeat(43),
        csrf_token_hash: idleSecrets.csrfTokenHash,
        hmac_key_version: "integration-1",
        issued_at: issuedAt,
        last_seen_at: issuedAt,
        mfa_verified_at: issuedAt,
        session_hash: idleSecrets.sessionTokenHash,
      })
      .execute();

    const expired = await application.inject({
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${idleSecrets.sessionToken}` },
      method: "GET",
      url: "/api/v1/admin/auth/session",
    });
    expect(expired.statusCode).toBe(401);
    const refusedRenewal = await application.inject({
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${idleSecrets.sessionToken}; ${ADMIN_CSRF_COOKIE_NAME}=${idleSecrets.csrfToken}`,
        origin: publicOrigin,
        "x-admin-csrf": idleSecrets.csrfToken,
      },
      method: "POST",
      url: "/api/v1/admin/auth/renew",
    });
    expect(refusedRenewal.statusCode).toBe(401);

    const current = await application.inject({
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}` },
      method: "GET",
      url: "/api/v1/admin/auth/session",
    });
    expect(current.statusCode).toBe(200);
  });

  it("enforces the security-auditor boundary before granting a disposable super-admin role", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const readStatuses: Array<{ statusCode: number; url: string }> = [];
    for (const url of [
      "/api/v1/admin/audit-logs",
      "/api/v1/admin/auth-audit-logs",
      "/api/v1/admin/operation-audit-logs",
      "/api/v1/admin/terms/versions",
      "/api/v1/admin/system-state",
    ]) {
      const response = await application.inject({ headers: { cookie }, method: "GET", url });
      readStatuses.push({ statusCode: response.statusCode, url });
    }

    const deniedUserLookup = await application.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/admin/users?search=account",
    });
    expect(deniedUserLookup.statusCode).toBe(403);
    expect(deniedUserLookup.json()).toMatchObject({
      error: { code: "ADMIN_ROLE_INSUFFICIENT" },
    });
    const deniedSystemWrite = await application.inject({
      headers: { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken },
      method: "PATCH",
      payload: { value: { enabled: false } },
      url: "/api/v1/admin/system-state/maintenance_mode",
    });
    expect(deniedSystemWrite.statusCode).toBe(403);
    expect(deniedSystemWrite.json()).toMatchObject({
      error: { code: "ADMIN_ROLE_INSUFFICIENT" },
    });

    const operator = await bootstrapDatabase
      .selectFrom("operators")
      .select("id")
      .where("email_normalized", "=", "operator@example.com")
      .executeTakeFirstOrThrow();
    async function replaceDisposableRole(
      role: "account_manager" | "super_admin" | "support",
    ): Promise<void> {
      await bootstrapDatabase.transaction().execute(async (transaction) => {
        await transaction
          .deleteFrom("admin_account_roles")
          .where("admin_account_id", "=", adminAccountId)
          .execute();
        await transaction
          .insertInto("admin_account_roles")
          .values({
            admin_account_id: adminAccountId,
            granted_by_operator_id: operator.id,
            role,
          })
          .execute();
      });
    }

    await replaceDisposableRole("support");
    for (const url of ["/api/v1/admin/users?search=account", "/api/v1/admin/inquiries"]) {
      const response = await application.inject({ headers: { cookie }, method: "GET", url });
      expect(response.statusCode, `support ${url}`).toBe(200);
    }
    for (const url of [
      "/api/v1/admin/members?search=account",
      "/api/v1/admin/audit-logs",
      "/api/v1/admin/terms/versions",
    ]) {
      const response = await application.inject({ headers: { cookie }, method: "GET", url });
      expect(response.statusCode, `support ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ADMIN_ROLE_INSUFFICIENT" } });
    }

    await replaceDisposableRole("account_manager");
    for (const url of [
      "/api/v1/admin/signup-approvals",
      "/api/v1/admin/users?search=account",
      "/api/v1/admin/members?search=account",
    ]) {
      const response = await application.inject({ headers: { cookie }, method: "GET", url });
      expect(response.statusCode, `account manager ${url}`).toBe(200);
    }
    for (const url of [
      "/api/v1/admin/accounts",
      "/api/v1/admin/inquiries",
      "/api/v1/admin/audit-logs",
    ]) {
      const response = await application.inject({ headers: { cookie }, method: "GET", url });
      expect(response.statusCode, `account manager ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ADMIN_ROLE_INSUFFICIENT" } });
    }

    await replaceDisposableRole("super_admin");
    const elevatedSession = await application.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/admin/auth/session",
    });
    expect(elevatedSession.statusCode).toBe(200);
    expect(elevatedSession.json()).toMatchObject({
      account: { roles: ["super_admin"] },
    });
    expect(readStatuses).toEqual(readStatuses.map(({ url }) => ({ statusCode: 200, url })));
  });

  it("records every personal-data admin screen in the access log and withholds data it cannot log (T-ADMIN-ACCESS-LOG)", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const logged = async () =>
      (
        await sql<{
          access_kind: string;
          admin_account_id: string;
          client_ip: string;
          request_id: string;
          searched: boolean;
          subject_count: number;
          subject_ids: string[];
          subject_type: string;
        }>`SELECT * FROM admin_access_logs ORDER BY id`.execute(bootstrapDatabase)
      ).rows;
    // 스위치가 꺼진 기존 앱은 기록하지 않는다(설치 전 운영과 같다).
    const before = (await logged()).length;
    const unlogged = await application.inject({
      headers: { cookie },
      method: "GET",
      remoteAddress: "198.51.100.7",
      url: "/api/v1/admin/people",
    });
    expect(unlogged.statusCode).toBe(200);
    expect(await logged()).toHaveLength(before);

    const { app: recording } = await createApplication({
      environment: { ...integrationEnvironment, ADMIN_ACCESS_LOGS_DATABASE_INSTALLED: true },
    });
    try {
      const screens = [
        ["/api/v1/admin/people", "people.list", "user", false],
        ["/api/v1/admin/users?search=account", "users.list", "user", true],
        ["/api/v1/admin/members?search=account", "members.list", "member", true],
        ["/api/v1/admin/classes", "classes.list", "class", false],
        ["/api/v1/admin/audit-logs", "class_audit.list", "audit_log", false],
        ["/api/v1/admin/operation-audit-logs", "operation_audit.list", "audit_log", false],
        ["/api/v1/admin/auth-audit-logs", "auth_audit.list", "audit_log", false],
        [
          "/api/v1/admin/terms/consents?consent_type=terms&policy_version=v1",
          "terms_consents.list",
          "user",
          false,
        ],
        ["/api/v1/admin/inquiries", "inquiries.list", "inquiry", false],
        ["/api/v1/admin/sessions", "sessions.list", "session", false],
        ["/api/v1/admin/signup-approvals", "signup_approvals.list", "signup_approval", false],
        ["/api/v1/admin/accounts", "admin_accounts.list", "admin_account", false],
        [
          "/api/v1/admin/signup-approvals/account?email=2%40naver.com&role=student",
          "signup_account.lookup",
          "user",
          true,
        ],
      ] as const;
      const bodies: unknown[] = [];
      for (const [url] of screens) {
        const response = await recording.inject({
          headers: { cookie },
          method: "GET",
          remoteAddress: "198.51.100.7",
          url,
        });
        expect(response.statusCode, url).toBe(200);
        bodies.push(response.json());
      }
      const rows = (await logged()).slice(before);
      expect(
        rows.map(({ access_kind, searched, subject_type }) => [
          access_kind,
          subject_type,
          searched,
        ]),
      ).toEqual(screens.map(([, kind, subject, searched]) => [kind, subject, searched]));
      for (const row of rows) {
        expect(row).toMatchObject({ admin_account_id: adminAccountId, client_ip: "198.51.100.7" });
        expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/u);
        expect(row.subject_count).toBe(row.subject_ids.length);
      }
      // 화면에 나온 사람의 내부 번호가 그대로 남는다(이름·메일·검색어 원문은 남기지 않는다).
      const people = (bodies[0] as { people: Array<{ id: string }> }).people;
      expect(people.length).toBeGreaterThan(0);
      expect(rows[0]!.subject_ids).toEqual(people.map(({ id }) => id));
      expect(JSON.stringify(rows)).not.toContain("account@");
      expect(JSON.stringify(rows)).not.toContain("naver.com");
      const lookup = bodies[12] as { account: { user_id: string } | null };
      expect(rows[12]!.subject_ids).toEqual(lookup.account ? [lookup.account.user_id] : []);

      // 기록을 남길 수 없으면 자료를 내보내지 않는다.
      await sql`REVOKE INSERT ON admin_access_logs FROM classhub_app`.execute(bootstrapDatabase);
      try {
        const refused = await recording.inject({
          headers: { cookie },
          method: "GET",
          remoteAddress: "198.51.100.7",
          url: "/api/v1/admin/people",
        });
        expect(refused.statusCode).toBe(500);
        expect(refused.json()).not.toHaveProperty("people");
      } finally {
        await sql`GRANT INSERT ON admin_access_logs TO classhub_app`.execute(bootstrapDatabase);
      }
      expect(await logged()).toHaveLength(before + screens.length);
    } finally {
      await recording.close();
    }
  });

  it("keeps full email identities and signup roles separate through signup, search, issuance and redemption", async () => {
    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const adminHeaders = { cookie: adminCookie, origin: publicOrigin, "x-admin-csrf": csrfToken };
    const matrix = [
      ["1@naver.com", "student"],
      ["2@naver.com", "teacher"],
      ["1@gmail.com", "teacher"],
      ["2@gmail.com", "student"],
      ["t-e.s_t+room42@school.example.org", "teacher"],
      ["student_2026@sub.example.co.kr", "student"],
    ] as const;
    for (const [index, [email, role]] of matrix.entries()) {
      const password = "Synthetic-example-River-88!";
      const body = {
        email,
        role,
        password,
        display_name: "동일한 이름",
        age_route: "over_14",
        consents: { terms: true, privacy: true },
      };
      const signup = await application.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        // Independent identities use independent clients; P-018 remains enabled.
        remoteAddress: `203.0.113.${50 + index}`,
        headers: { origin: publicOrigin },
        payload: body,
      });
      // 가입은 새 주소·기존 주소 모두 같은 202로 응답한다(계정 존재 여부 비노출, 7f30eff).
      expect(signup.statusCode, `${email} signup`).toBe(202);
      const stored = await bootstrapDatabase
        .selectFrom("users")
        .select(["id", "signup_role", "signup_approved_at"])
        .where("email_normalized", "=", email)
        .executeTakeFirstOrThrow();
      expect(stored.signup_role).toBe(role);
      expect(stored.signup_approved_at).toBeNull();
      // 관리자 승인번호는 이메일 인증을 마친 계정에만 발급된다(d6a8538). 메일 왕복 대신 인증 완료로 둔다.
      await bootstrapDatabase
        .updateTable("users")
        .set({ email_verified_at: new Date() })
        .where("id", "=", stored.id)
        .execute();
      const wrongRole = role === "student" ? "teacher" : "student";
      for (const selectedRole of [role, wrongRole]) {
        const search = await application.inject({
          method: "GET",
          headers: { cookie: adminCookie },
          url: `/api/v1/admin/signup-approvals/account?email=${encodeURIComponent(email)}&role=${selectedRole}`,
        });
        expect(search.statusCode).toBe(200);
        if (selectedRole === role)
          expect(search.json()).toMatchObject({
            account: { user_id: stored.id, email, signup_role: role },
          });
        else expect(search.json()).toEqual({ account: null });
      }
      const wrongIssue = await application.inject({
        method: "POST",
        url: "/api/v1/admin/signup-approvals",
        headers: adminHeaders,
        payload: { email, role: wrongRole },
      });
      expect(wrongIssue.statusCode).toBe(409);
      expect(wrongIssue.json()).toMatchObject({ error: { code: "SIGNUP_ROLE_MISMATCH" } });
      const issued = await application.inject({
        method: "POST",
        url: "/api/v1/admin/signup-approvals",
        headers: adminHeaders,
        payload: { email, role },
      });
      expect(issued.statusCode).toBe(201);
      const login = await application.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: publicOrigin },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = responseCookies(login.headers);
      const userCookie = `${SESSION_COOKIE_NAME}=${rawCookie(cookies, SESSION_COOKIE_NAME)}; ${CSRF_COOKIE_NAME}=${rawCookie(cookies, CSRF_COOKIE_NAME)}`;
      const userHeaders = {
        cookie: userCookie,
        origin: publicOrigin,
        "x-csrf-token": rawCookie(cookies, CSRF_COOKIE_NAME),
      };
      const overwrite = await application.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/role",
        headers: userHeaders,
        payload: { role: wrongRole },
      });
      expect(overwrite.statusCode).toBe(409);
      expect(overwrite.json()).toMatchObject({ error: { code: "SIGNUP_ROLE_ALREADY_SET" } });
      const confirmed = await application.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/confirm",
        headers: userHeaders,
        payload: { approval_code: issued.json().code },
      });
      expect(confirmed.statusCode).toBe(200);
      const profile = await bootstrapDatabase
        .selectFrom("teacher_profiles")
        .select("id")
        .where("user_id", "=", stored.id)
        .executeTakeFirst();
      expect(profile !== undefined).toBe(role === "teacher");
      if (email === "1@naver.com") {
        const duplicate = await application.inject({
          method: "POST",
          url: "/api/v1/auth/sign-up",
          remoteAddress: `203.0.113.${50 + index}`,
          headers: { origin: publicOrigin },
          payload: { ...body, email: " 1@NAVER.COM " },
        });
        // 이미 가입된 주소도 새 주소와 같은 202를 받는다. 대신 계정이 하나 더 생기지 않아야 한다.
        expect(duplicate.statusCode).toBe(202);
        const sameAddress = await bootstrapDatabase
          .selectFrom("users")
          .select("id")
          .where("email_normalized", "=", email)
          .execute();
        expect(sameAddress).toEqual([{ id: stored.id }]);
      }
    }
  });

  it("recovers a missing legacy signup type once under concurrent requests, with session and CSRF checks", async () => {
    const email = "legacy.pending@example.org",
      password = "Legacy-example-River-88!";
    const legacy = await bootstrapDatabase
      .insertInto("users")
      .values({
        email_normalized: email,
        display_name: "기존 가입자",
        password_hash: await hashPassword(password),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: publicOrigin },
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = responseCookies(login.headers);
    const cookie = `${SESSION_COOKIE_NAME}=${rawCookie(cookies, SESSION_COOKIE_NAME)}; ${CSRF_COOKIE_NAME}=${rawCookie(cookies, CSRF_COOKIE_NAME)}`;
    const headers = {
      cookie,
      origin: publicOrigin,
      "x-csrf-token": rawCookie(cookies, CSRF_COOKIE_NAME),
    };
    const url = "/api/v1/auth/signup-approval/role";
    for (const [rejectedHeaders, status] of [
      [{ origin: publicOrigin }, 401],
      [{ cookie, origin: publicOrigin }, 403],
      [{ ...headers, origin: "https://untrusted.example" }, 403],
    ] as const) {
      const denied = await application.inject({
        method: "POST",
        url,
        headers: rejectedHeaders,
        payload: { role: "student" },
      });
      expect(denied.statusCode).toBe(status);
    }
    const forged = await application.inject({
      method: "POST",
      url,
      headers,
      payload: { role: "student", user_id: "1" },
    });
    expect(forged.statusCode).toBe(400);
    const results = await Promise.all(
      (["student", "teacher"] as const).map((role) =>
        application.inject({ method: "POST", url, headers, payload: { role } }),
      ),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const selected = results.find((result) => result.statusCode === 200)!.json().signup_role;
    const stored = await bootstrapDatabase
      .selectFrom("users")
      .select(["signup_role", "signup_approved_at"])
      .where("id", "=", legacy.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ signup_role: selected, signup_approved_at: null });
    expect(
      await bootstrapDatabase
        .selectFrom("teacher_profiles")
        .select("id")
        .where("user_id", "=", legacy.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    const bootstrap = await application.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      destination: "SIGNUP_APPROVAL_REQUIRED",
      account: { signup_role: selected },
    });
  });

  it("shares accounts, administrator identity and approval codes between two API origins with separate sessions", async () => {
    const phoneOrigin = "https://classhub-phone.test";
    const { app: phone } = await createApplication({
      environment: {
        ...integrationEnvironment,
        PUBLIC_API_ORIGIN: phoneOrigin,
        PUBLIC_APP_ORIGIN: phoneOrigin,
      },
    });
    try {
      const pcUserOnPhone = await phone.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: phoneOrigin },
        payload: {
          email: "2@naver.com",
          password: "Synthetic-example-River-88!",
        },
      });
      expect(pcUserOnPhone.statusCode).toBe(200);
      const adminOnPhone = await phone.inject({
        method: "POST",
        url: "/api/v1/admin/auth/login",
        headers: { origin: phoneOrigin },
        payload: {
          email: adminEmail,
          password: initialPassword,
        },
      });
      expect(adminOnPhone.statusCode).toBe(200);
      expect(adminOnPhone.json()).toMatchObject({ next_step: "verify_totp" });
      const email = "from.phone+shared@example.net",
        password = "Device-example-River-88!";
      const created = await phone.inject({
        method: "POST",
        url: "/api/v1/auth/sign-up",
        headers: { origin: phoneOrigin },
        payload: {
          email,
          password,
          role: "student",
          display_name: "기기 공유 가입",
          age_route: "over_14",
          consents: { terms: true, privacy: true },
        },
      });
      expect(created.statusCode).toBe(202);
      const pcLogin = await application.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: publicOrigin },
        payload: { email, password },
      });
      const phoneLogin = await phone.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin: phoneOrigin },
        payload: { email, password },
      });
      expect(pcLogin.statusCode).toBe(200);
      expect(phoneLogin.statusCode).toBe(200);
      const phoneCookies = responseCookies(phoneLogin.headers);
      expect(rawCookie(phoneCookies, SESSION_COOKIE_NAME)).not.toBe(
        rawCookie(responseCookies(pcLogin.headers), SESSION_COOKIE_NAME),
      );
      await bootstrapDatabase
        .updateTable("users")
        .set({ email_verified_at: new Date() })
        .where("email_normalized", "=", email)
        .execute();
      const issued = await application.inject({
        method: "POST",
        url: "/api/v1/admin/signup-approvals",
        headers: {
          cookie: `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`,
          origin: publicOrigin,
          "x-admin-csrf": csrfToken,
        },
        payload: { email, role: "student" },
      });
      expect(issued.statusCode).toBe(201);
      const phoneCookie = `${SESSION_COOKIE_NAME}=${rawCookie(phoneCookies, SESSION_COOKIE_NAME)}; ${CSRF_COOKIE_NAME}=${rawCookie(phoneCookies, CSRF_COOKIE_NAME)}`;
      const confirmed = await phone.inject({
        method: "POST",
        url: "/api/v1/auth/signup-approval/confirm",
        headers: {
          cookie: phoneCookie,
          origin: phoneOrigin,
          "x-csrf-token": rawCookie(phoneCookies, CSRF_COOKIE_NAME),
        },
        payload: { approval_code: issued.json().code },
      });
      expect(confirmed.statusCode).toBe(200);
      const pcCookies = responseCookies(pcLogin.headers);
      const pcCookie = `${SESSION_COOKIE_NAME}=${rawCookie(pcCookies, SESSION_COOKIE_NAME)}; ${CSRF_COOKIE_NAME}=${rawCookie(pcCookies, CSRF_COOKIE_NAME)}`;
      const pcState = await application.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: { cookie: pcCookie },
      });
      const phoneState = await phone.inject({
        method: "GET",
        url: "/api/v1/bootstrap",
        headers: { cookie: phoneCookie },
      });
      expect(pcState.statusCode).toBe(200);
      expect(phoneState.statusCode).toBe(200);
      expect(phoneState.json().account).toEqual(pcState.json().account);
      expect(phoneState.json().destination).toBe(pcState.json().destination);
      expect(pcState.json().destination).toBe("ENTER_INVITE_CODE");
    } finally {
      await phone.close();
    }
  });

  it("runs stage-five admin workflows without persisting returned secrets in audit", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const mutationHeaders = { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken };

    const approvalEmail = "approval-target@example.com";
    await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "승인 대기 계정",
        email_normalized: approvalEmail,
        email_verified_at: new Date(),
        signup_role: "student",
        password_hash: "synthetic-unused-hash",
      })
      .execute();
    const issuedApproval = await application.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { email: approvalEmail, role: "student" },
      url: "/api/v1/admin/signup-approvals",
    });
    expect(issuedApproval.statusCode).toBe(201);
    const approval = issuedApproval.json<{ code: string; expiresAt: string; id: string }>();
    expect(approval.code).toMatch(/^\d{6}$/u);
    expect(new Date(approval.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const listedApprovals = await application.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/admin/signup-approvals",
    });
    expect(listedApprovals.statusCode).toBe(200);
    expect(listedApprovals.json()).toMatchObject({
      approvals: expect.arrayContaining([
        expect.objectContaining({ id: approval.id, role: "student", status: "active" }),
      ]),
    });
    expect(listedApprovals.body).not.toContain(approval.code);
    expect(listedApprovals.body).not.toContain(approvalEmail);

    const revokedApproval = await application.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { id: approval.id },
      url: "/api/v1/admin/signup-approvals/revoke",
    });
    expect(revokedApproval.statusCode).toBe(200);
    expect(revokedApproval.json()).toEqual({ revoked: true });

    const managedAdminEmail = "support-admin@example.com";
    const createdAdmin = await application.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: {
        display_name: "지원 관리자",
        email: managedAdminEmail,
        roles: ["support"],
      },
      url: "/api/v1/admin/accounts",
    });
    expect(createdAdmin.statusCode).toBe(201);
    const createdAdminBody = createdAdmin.json<{
      account: { id: string; roles: string[]; status: string };
      created: boolean;
      initial_password: string;
    }>();
    expect(createdAdminBody).toMatchObject({
      account: { roles: ["support"], status: "pending_mfa" },
      created: true,
    });
    expect(createdAdminBody.initial_password).toMatch(/^A1-[A-Za-z0-9_-]{32}$/u);

    const repeatedAdmin = await application.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: {
        display_name: "무시되는 이름",
        email: managedAdminEmail.toUpperCase(),
        roles: ["support"],
      },
      url: "/api/v1/admin/accounts",
    });
    expect(repeatedAdmin.statusCode).toBe(201);
    expect(repeatedAdmin.json()).toMatchObject({
      account: { id: createdAdminBody.account.id, roles: ["support"], status: "pending_mfa" },
      created: false,
      initial_password: null,
    });

    const systemUpdate = await application.inject({
      headers: mutationHeaders,
      method: "PATCH",
      payload: { value: { enabled: true, message: "검증용 공지" } },
      url: "/api/v1/admin/system-state/announcement",
    });
    expect(systemUpdate.statusCode).toBe(200);
    expect(systemUpdate.json()).toMatchObject({
      state: { key: "announcement", value_json: { enabled: true, message: "검증용 공지" } },
    });

    const createdTerms = await application.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: {
        content: "검증 환경에서만 사용하는 이용약관 본문입니다.",
        document_type: "terms",
        policy_version: "integration-2026-09",
        title: "통합 검증 이용약관",
      },
      url: "/api/v1/admin/terms/versions",
    });
    expect(createdTerms.statusCode).toBe(201);
    const terms = createdTerms.json<{
      version: { content_sha256: string; id: string; status: string };
    }>().version;
    expect(terms).toMatchObject({ status: "draft" });
    expect(terms.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const unpublished = await application.inject({
      method: "GET",
      url: "/api/v1/legal/documents/terms",
    });
    expect(unpublished.statusCode).toBe(200);
    expect(unpublished.json()).toEqual({ version: null, versions: [] });
    const publishedTerms = await application.inject({
      headers: mutationHeaders,
      method: "PATCH",
      payload: {
        effective_at: new Date(Date.now() - 1_000).toISOString(),
        reason: "통합 검증 게시",
        status: "published",
      },
      url: `/api/v1/admin/terms/versions/${terms.id}/status`,
    });
    expect(publishedTerms.statusCode).toBe(200);
    expect(publishedTerms.json()).toMatchObject({ version: { id: terms.id, status: "published" } });
    const publicTerms = await application.inject({
      method: "GET",
      url: "/api/v1/legal/documents/terms",
    });
    expect(publicTerms.statusCode).toBe(200);
    expect(publicTerms.json()).toMatchObject({
      version: {
        id: terms.id,
        status: "published",
        content_sha256: terms.content_sha256,
        policy_version: "integration-2026-09",
      },
    });
    expect(publicTerms.body).not.toContain("created_by_admin_account_id");
    expect(publicTerms.headers["cache-control"]).toBe("no-store");

    const inquiry = await bootstrapDatabase
      .insertInto("admin_inquiries")
      .values({ body: "통합 검증 문의 본문", subject: "통합 검증 문의" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const assignedInquiry = await application.inject({
      headers: mutationHeaders,
      method: "PATCH",
      payload: {
        assigned_admin_account_id: adminAccountId,
        response: "확인했습니다.",
        status: "in_progress",
      },
      url: `/api/v1/admin/inquiries/${inquiry.id}`,
    });
    expect(assignedInquiry.statusCode).toBe(200);
    expect(assignedInquiry.json()).toMatchObject({
      inquiry: { assigned_admin_account_id: adminAccountId, status: "in_progress" },
    });
    const unassignedInquiry = await application.inject({
      headers: mutationHeaders,
      method: "PATCH",
      payload: { assigned_admin_account_id: null, status: "open" },
      url: `/api/v1/admin/inquiries/${inquiry.id}`,
    });
    expect(unassignedInquiry.statusCode).toBe(200);
    expect(unassignedInquiry.json()).toMatchObject({
      inquiry: { assigned_admin_account_id: null, status: "open" },
    });

    const operationAudits = await bootstrapDatabase
      .selectFrom("admin_operation_audit_logs")
      .select(["action", "after_json", "before_json", "reason"])
      .where("actor_admin_account_id", "=", adminAccountId)
      .orderBy("id")
      .execute();
    expect(operationAudits.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "admin.signup_approval.issued",
        "admin.signup_approval.revoked",
        "admin.account.created",
        "admin.system_state.updated",
        "admin.terms.created",
        "admin.terms.published",
        "admin.inquiry.updated",
      ]),
    );
    const serializedAudits = JSON.stringify(operationAudits);
    expect(serializedAudits).not.toContain(approval.code);
    expect(serializedAudits).not.toContain(approvalEmail);
    expect(serializedAudits).not.toContain(createdAdminBody.initial_password);
    expect(serializedAudits).not.toContain(managedAdminEmail);
  }, 30_000);

  it("updates administrator roles and status, retires terms, and resolves inquiries through protected HTTP writes", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const headers = { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken };
    const target = await bootstrapDatabase
      .selectFrom("admin_accounts")
      .select("id")
      .where("email_normalized", "=", "support-admin@example.com")
      .executeTakeFirstOrThrow();
    const roles = await application.inject({
      headers,
      method: "PUT",
      url: `/api/v1/admin/accounts/${target.id}/roles`,
      payload: { roles: ["account_manager", "support"], reason: "합성 관리자 역할 변경" },
    });
    expect(roles.statusCode).toBe(200);
    expect(
      (
        await bootstrapDatabase
          .selectFrom("admin_account_roles")
          .select("role")
          .where("admin_account_id", "=", target.id)
          .orderBy("role")
          .execute()
      ).map((row) => row.role),
    ).toEqual(["account_manager", "support"]);
    for (const status of ["suspended", "active", "revoked"] as const) {
      const changed = await application.inject({
        headers,
        method: "PATCH",
        url: `/api/v1/admin/accounts/${target.id}/status`,
        payload: { status, reason: "합성 관리자 상태 검증" },
      });
      expect(changed.statusCode, status).toBe(200);
      expect(
        await bootstrapDatabase
          .selectFrom("admin_accounts")
          .select("status")
          .where("id", "=", target.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status });
    }
    const revive = await application.inject({
      headers,
      method: "PATCH",
      url: `/api/v1/admin/accounts/${target.id}/status`,
      payload: { status: "active", reason: "폐기 계정 재활성화 차단" },
    });
    expect(revive.statusCode).toBe(400);
    const self = await application.inject({
      headers,
      method: "PATCH",
      url: `/api/v1/admin/accounts/${adminAccountId}/status`,
      payload: { status: "suspended", reason: "자기 계정 중지 차단" },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ error: { code: "ADMIN_CANNOT_DISABLE_SELF" } });
    const terms = await bootstrapDatabase
      .selectFrom("admin_terms_versions")
      .select("id")
      .where("policy_version", "=", "integration-2026-09")
      .executeTakeFirstOrThrow();
    const retired = await application.inject({
      headers,
      method: "PATCH",
      url: `/api/v1/admin/terms/versions/${terms.id}/status`,
      payload: { status: "retired", reason: "합성 약관 게시 종료" },
    });
    expect(retired.statusCode).toBe(409);
    expect(retired.json()).toMatchObject({
      error: { code: "TERMS_VERSION_REPLACEMENT_REQUIRED" },
    });
    const replacementDraft = await application.inject({
      headers,
      method: "POST",
      url: "/api/v1/admin/terms/versions",
      payload: {
        content: "합성 후속 약관입니다.",
        document_type: "terms",
        policy_version: "integration-2026-10",
        title: "합성 후속 약관",
      },
    });
    expect(replacementDraft.statusCode).toBe(201);
    const replacementId = replacementDraft.json<{ version: { id: string } }>().version.id;
    const published = await application.inject({
      headers,
      method: "PATCH",
      url: `/api/v1/admin/terms/versions/${replacementId}/status`,
      payload: {
        status: "published",
        effective_at: new Date(Date.now() - 1_000).toISOString(),
        reason: "합성 후속 약관 게시",
      },
    });
    expect(published.statusCode).toBe(200);
    expect(
      await bootstrapDatabase
        .selectFrom("admin_terms_versions")
        .select("status")
        .where("id", "=", terms.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "retired" });
    const publicTerms = await application.inject({
      method: "GET",
      url: "/api/v1/legal/documents/terms",
    });
    expect(publicTerms.statusCode).toBe(200);
    expect(publicTerms.json()).toMatchObject({
      version: { id: replacementId, status: "published" },
    });
    const inquiry = await bootstrapDatabase
      .selectFrom("admin_inquiries")
      .select("id")
      .where("subject", "=", "통합 검증 문의")
      .executeTakeFirstOrThrow();
    const resolved = await application.inject({
      headers,
      method: "PATCH",
      url: `/api/v1/admin/inquiries/${inquiry.id}`,
      payload: { status: "resolved", response: "합성 문의 해결 확인" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      inquiry: { status: "resolved", response: "합성 문의 해결 확인" },
    });
  });

  it("lets an account manager approve, remove and allow rejoining while support cannot change membership", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const headers = { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken };
    const operator = await bootstrapDatabase
      .selectFrom("operators")
      .select("id")
      .where("email_normalized", "=", "operator@example.com")
      .executeTakeFirstOrThrow();
    const owner = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "소속 검수 교사",
        email_normalized: "member-owner@example.invalid",
        password_hash: "synthetic-unused",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const pupil = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "소속 검수 학생",
        email_normalized: "member-pupil@example.invalid",
        password_hash: "synthetic-unused",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("teacher_profiles")
      .values({
        user_id: owner.id,
        created_by_operator_id: operator.id,
        temporary_password_must_change: false,
      })
      .execute();
    await bootstrapDatabase
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        school_code: "9900101",
        school_name: "소속 검수 학교",
        school_kind: "middle",
        region_name: "합성 지역",
        edu_office_name: "합성 교육청",
      })
      .execute();
    const group = await bootstrapDatabase.transaction().execute(async (transaction) => {
      const created = await transaction
        .insertInto("classes")
        .values({
          name: "소속 검수반",
          academic_year: 2026,
          grade: 2,
          edu_office_code: "B10",
          school_code: "9900101",
          expected_student_count: 1,
          created_by_user_id: owner.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("class_members")
        .values({ class_id: created.id, user_id: owner.id, role: "teacher", status: "approved" })
        .execute();
      return created;
    });
    const member = await bootstrapDatabase
      .insertInto("class_members")
      .values({
        class_id: group.id,
        user_id: pupil.id,
        role: "student",
        status: "pending",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const replaceRole = async (role: "support" | "account_manager" | "super_admin") => {
      await bootstrapDatabase.transaction().execute(async (transaction) => {
        await transaction
          .deleteFrom("admin_account_roles")
          .where("admin_account_id", "=", adminAccountId)
          .execute();
        await transaction
          .insertInto("admin_account_roles")
          .values({ admin_account_id: adminAccountId, role, granted_by_operator_id: operator.id })
          .execute();
      });
    };
    try {
      await replaceRole("support");
      const denied = await application.inject({
        headers,
        method: "PATCH",
        url: `/api/v1/admin/members/${member.id}/status`,
        payload: { status: "approved" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: "ADMIN_ROLE_INSUFFICIENT" } });
      await replaceRole("account_manager");
      for (const status of ["approved", "removed", "rejoin_allowed"] as const) {
        const changed = await application.inject({
          headers,
          method: "PATCH",
          url: `/api/v1/admin/members/${member.id}/status`,
          payload: { status, reason: "합성 소속 상태 검증" },
        });
        expect(changed.statusCode, status).toBe(200);
        expect(
          await bootstrapDatabase
            .selectFrom("class_members")
            .select("status")
            .where("id", "=", member.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status });
      }
      const invalid = await application.inject({
        headers,
        method: "PATCH",
        url: `/api/v1/admin/members/${member.id}/status`,
        payload: { status: "approved" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: { code: "ADMIN_MEMBER_STATUS_TRANSITION_INVALID" },
      });
      expect(
        (
          await bootstrapDatabase
            .selectFrom("class_member_status_history")
            .select("to_status")
            .where("member_id", "=", member.id)
            .orderBy("id")
            .execute()
        ).map((row) => row.to_status),
      ).toEqual(["approved", "removed", "rejoin_allowed"]);
      expect(
        await bootstrapDatabase
          .selectFrom("class_members")
          .select("student_number")
          .where("id", "=", member.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ student_number: null });
    } finally {
      await replaceRole("super_admin");
    }
  });

  it("requires the admin CSRF pair, logs out, and rejects a reused TOTP in a new challenge", async () => {
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${sessionCookie}; ${ADMIN_CSRF_COOKIE_NAME}=${csrfToken}`;
    const missingCsrf = await application.inject({
      headers: { cookie, origin: publicOrigin },
      method: "POST",
      url: "/api/v1/admin/auth/logout",
    });
    expect(missingCsrf.statusCode).toBe(403);

    const logout = await application.inject({
      headers: { cookie, origin: publicOrigin, "x-admin-csrf": csrfToken },
      method: "POST",
      url: "/api/v1/admin/auth/logout",
    });
    expect(logout.statusCode).toBe(200);

    const login = await application.inject({
      headers: { origin: publicOrigin },
      method: "POST",
      payload: { email: adminEmail, password: initialPassword },
      url: "/api/v1/admin/auth/login",
    });
    expect(login.json()).toMatchObject({ next_step: "verify_totp" });
    const challengeToken = rawCookie(responseCookies(login.headers), ADMIN_CHALLENGE_COOKIE_NAME);
    const replay = await application.inject({
      headers: {
        cookie: `${ADMIN_CHALLENGE_COOKIE_NAME}=${challengeToken}`,
        origin: publicOrigin,
      },
      method: "POST",
      payload: { totp_code: stepUpCode },
      url: "/api/v1/admin/auth/totp",
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "ADMIN_MFA_INVALID" } });
  });

  it("keeps secrets and raw identifiers out of auth audit rows and enforces role ACLs", async () => {
    const auditRows = await bootstrapDatabase
      .selectFrom("admin_auth_audit_logs")
      .selectAll()
      .orderBy("id")
      .execute();
    const serialized = JSON.stringify(auditRows);
    expect(auditRows.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "admin.auth.password_verified",
        "admin.auth.mfa_enrolled",
        "admin.auth.login_succeeded",
        "admin.auth.step_up_failed",
        "admin.auth.step_up_succeeded",
        "admin.auth.session_expired",
        "admin.auth.logout",
      ]),
    );
    expect(serialized).not.toContain(initialPassword);
    expect(serialized).not.toContain(manualKey);
    expect(serialized).not.toContain(enrollmentCode);
    expect(serialized).not.toContain(stepUpCode);
    expect(serialized).not.toContain(adminEmail);
    expect(serialized).not.toContain(clientIp);

    const privileges = await bootstrapDatabase.executeQuery(
      sql<{
        app_can_insert_account: boolean;
        app_can_read_audit: boolean;
        operator_can_insert_email: boolean;
        operator_can_insert_locked_until: boolean;
        operator_can_update_account: boolean;
      }>`
        SELECT
          has_table_privilege('classhub_app', 'admin_accounts', 'INSERT') AS app_can_insert_account,
          has_table_privilege('classhub_app', 'admin_auth_audit_logs', 'SELECT') AS app_can_read_audit,
          has_column_privilege('classhub_operator', 'admin_accounts', 'email_normalized', 'INSERT') AS operator_can_insert_email,
          has_column_privilege('classhub_operator', 'admin_accounts', 'locked_until', 'INSERT') AS operator_can_insert_locked_until,
          has_table_privilege('classhub_operator', 'admin_accounts', 'UPDATE') AS operator_can_update_account
      `.compile(bootstrapDatabase),
    );
    expect(privileges.rows[0]).toEqual({
      app_can_insert_account: false,
      app_can_read_audit: false,
      operator_can_insert_email: true,
      operator_can_insert_locked_until: false,
      operator_can_update_account: false,
    });

    expect(hashSessionSecret(sessionCookie)).toHaveLength(32);
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("manages ordinary user status and issues a one-use reset link without exposing it in audit", async () => {
    const service = application.get(AdminUsersService);
    const user = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "계정%대상",
        email_normalized: "managed-user@example.com",
        password_hash: "old-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const unrelated = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "다른 계정",
        email_normalized: "unrelated-user@example.com",
        password_hash: "old-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const userSession = issueSessionSecrets();
    await bootstrapDatabase
      .insertInto("sessions")
      .values({
        created_ip: "203.0.113.51",
        csrf_token_hash: userSession.csrfTokenHash,
        expires_at: new Date(Date.now() + 60 * 60 * 1_000),
        session_hash: userSession.sessionTokenHash,
        user_id: user.id,
      })
      .execute();

    const searched = await service.list("%대");
    expect(searched.users.map(({ id }) => id)).toEqual([user.id]);
    expect(searched.users.map(({ id }) => id)).not.toContain(unrelated.id);

    await service.updateStatus(
      user.id,
      "inactive",
      "운영 확인에 따른 비활성화",
      adminAccountId,
      randomUUID(),
    );
    const inactive = await bootstrapDatabase
      .selectFrom("users")
      .select("is_active")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    const revokedSession = await bootstrapDatabase
      .selectFrom("sessions")
      .select("revoked_at")
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(inactive.is_active).toBe(false);
    expect(revokedSession.revoked_at).toBeInstanceOf(Date);

    await service.updateStatus(
      user.id,
      "active",
      "운영 확인에 따른 재활성화",
      adminAccountId,
      randomUUID(),
    );
    // 총검수 C2-05: 링크는 사용자 메일로만 간다. 실제 발송 대신 메일로 나간 값을 잡아 확인한다.
    const resetMail = vi
      .spyOn(application.get<PasswordResetMailer>(PASSWORD_RESET_MAILER), "sendPasswordResetEmail")
      .mockResolvedValue(undefined);
    const issued = await service.issuePasswordReset(
      user.id,
      "본인 확인 뒤 재설정 링크 발급",
      adminAccountId,
      randomUUID(),
      "203.0.113.52",
    );
    expect(issued).toMatchObject({ mail: "sent" });
    expect(JSON.stringify(issued)).not.toMatch(/token|reset-password/u);
    expect(resetMail).toHaveBeenCalledOnce();
    const [mailedTo, resetToken] = resetMail.mock.calls[0]!;
    expect(mailedTo).toBe("managed-user@example.com");
    expect(resetToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    resetMail.mockRestore();

    const confirmation = await application.inject({
      headers: { origin: publicOrigin },
      method: "POST",
      payload: { new_password: "AdminIssuedReset-12345", token: resetToken },
      url: "/api/v1/auth/password-resets/confirm",
    });
    expect(confirmation.statusCode).toBe(200);
    const resetState = await bootstrapDatabase
      .selectFrom("password_reset_tokens")
      .select(["issued_by_admin_account_id", "used_at"])
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();
    const updatedUser = await bootstrapDatabase
      .selectFrom("users")
      .select(["is_active", "password_hash"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(resetState.issued_by_admin_account_id).toBe(adminAccountId);
    expect(resetState.used_at).toBeInstanceOf(Date);
    expect(updatedUser.is_active).toBe(true);
    await expect(verifyPassword("AdminIssuedReset-12345", updatedUser.password_hash)).resolves.toBe(
      true,
    );

    const operationAudits = await bootstrapDatabase
      .selectFrom("admin_operation_audit_logs")
      .select(["action", "after_json", "before_json", "reason"])
      .where("target_type", "=", "user")
      .where("target_id", "=", user.id)
      .orderBy("id")
      .execute();
    expect(operationAudits.map(({ action }) => action)).toEqual([
      "admin.user.status_changed",
      "admin.user.status_changed",
      "admin.user.password_reset_issued",
    ]);
    expect(JSON.stringify(operationAudits)).not.toContain(resetToken);
    expect(JSON.stringify(operationAudits)).not.toContain("managed-user@example.com");
  }, 30_000);

  it("requires teacher transfer before disabling the owner of an active class", async () => {
    const service = application.get(AdminUsersService);
    const teacher = await bootstrapDatabase
      .insertInto("users")
      .values({
        display_name: "운영 담임",
        email_normalized: "active-teacher@example.com",
        password_hash: "old-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrapDatabase
      .insertInto("schools")
      .values({
        edu_office_code: "B10",
        edu_office_name: "서울특별시교육청",
        region_name: "서울특별시",
        school_code: "7010001",
        school_kind: "middle",
        school_name: "관리 검증 중학교",
      })
      .execute();
    await bootstrapDatabase.transaction().execute(async (transaction) => {
      const operator = await transaction
        .selectFrom("operators")
        .select("id")
        .where("email_normalized", "=", "operator@example.com")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("teacher_profiles")
        .values({
          created_by_operator_id: operator.id,
          temporary_password_expires_at: null,
          temporary_password_must_change: false,
          user_id: teacher.id,
        })
        .execute();
      const createdClass = await transaction
        .insertInto("classes")
        .values({
          academic_year: 2026,
          created_by_user_id: teacher.id,
          edu_office_code: "B10",
          expected_student_count: 25,
          grade: 2,
          name: "관리 검증반",
          school_code: "7010001",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("class_members")
        .values({
          class_id: createdClass.id,
          role: "teacher",
          status: "approved",
          user_id: teacher.id,
        })
        .execute();
      return createdClass;
    });

    await expect(
      service.updateStatus(
        teacher.id,
        "inactive",
        "담임 비활성화 시도",
        adminAccountId,
        randomUUID(),
      ),
    ).rejects.toSatisfy(
      // b2452e05부터 응답 본문은 {code, 한국어 message}이고 예외 message는 코드로 남는다(admin-error.ts).
      (error: { getResponse(): { code?: string }; getStatus(): number; message: string }) =>
        error.getStatus() === 409 &&
        error.message === "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED" &&
        error.getResponse().code === "ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED",
    );
    const state = await bootstrapDatabase
      .selectFrom("users")
      .select("is_active")
      .where("id", "=", teacher.id)
      .executeTakeFirstOrThrow();
    expect(state.is_active).toBe(true);
  });

  it("does not let wrong passwords from other networks block the real administrator (total audit C1-03)", async () => {
    const attempt = (remoteAddress: string, password: string) =>
      application.inject({
        headers: { origin: publicOrigin },
        method: "POST",
        payload: { email: adminEmail, password },
        remoteAddress,
        url: "/api/v1/admin/auth/login",
      });
    for (let index = 1; index <= 4; index += 1) {
      expect(
        (await attempt(`198.51.100.${index}`, "Synthetic-wrong-password-only")).statusCode,
      ).toBe(401);
    }
    // 예전에는 이메일 단위 한도·DB 잠금 때문에 여기서 진짜 관리자도 막혔다.
    const owner = await attempt("192.0.2.77", initialPassword);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(
      await bootstrapDatabase
        .selectFrom("admin_accounts")
        .select(["locked_until"])
        .where("id", "=", adminAccountId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ locked_until: null });
    // 같은 출처에서 계속 틀리면 그 출처만 멈춘다.
    for (let index = 0; index < 3; index += 1) await attempt("198.51.100.9", "Synthetic-wrong-1");
    expect((await attempt("198.51.100.9", "Synthetic-wrong-1")).statusCode).toBe(429);
  });

  it("clears an expired admin lock window while preserving password and MFA verification", async () => {
    await bootstrapDatabase
      .updateTable("admin_accounts")
      .set({ failed_login_attempts: 5, locked_until: new Date(Date.now() - 1000) })
      .where("id", "=", adminAccountId)
      .execute();
    const failed = await application.inject({
      headers: { origin: publicOrigin },
      method: "POST",
      payload: { email: adminEmail, password: "Synthetic-wrong-password-only" },
      url: "/api/v1/admin/auth/login",
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.json()).toMatchObject({ error: { code: "ADMIN_INVALID_CREDENTIALS" } });
    expect(
      await bootstrapDatabase
        .selectFrom("admin_accounts")
        .select(["failed_login_attempts", "locked_until"])
        .where("id", "=", adminAccountId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ failed_login_attempts: 1, locked_until: null });

    const valid = await application.inject({
      headers: { origin: publicOrigin },
      method: "POST",
      payload: { email: adminEmail, password: initialPassword },
      url: "/api/v1/admin/auth/login",
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ next_step: "verify_totp" });
    expect(
      responseCookies(valid.headers).some(
        (cookie) =>
          cookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`) &&
          !cookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=;`),
      ),
    ).toBe(false);
    expect(
      await bootstrapDatabase
        .selectFrom("admin_accounts")
        .select(["failed_login_attempts", "locked_until"])
        .where("id", "=", adminAccountId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ failed_login_attempts: 0, locked_until: null });
  });
});
