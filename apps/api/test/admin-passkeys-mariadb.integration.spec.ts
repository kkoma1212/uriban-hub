import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createMariaDbDatabase, createMysql2MariaDbPool, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, MysqlDialect, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVirtualPasskeyBrowser } from "../../../browser-qa/lib/admin-passkey-virtual.mjs";
import { AdminAuthService } from "../src/admin-auth/admin-auth.service.js";
import { AdminPasskeysService } from "../src/admin-auth/admin-passkeys.service.js";
import { adminFactorDatabase } from "../src/admin-auth/admin-passkeys.database.js";
import { adminAuthDate } from "../src/admin-auth/admin-auth.database.js";
import { encryptTotpSecret, totpCodeAt } from "../src/admin-auth/admin-auth.crypto.js";
import type { AuthenticatedAdminSession } from "../src/admin-auth/admin-auth.types.js";
import { hashPassword } from "../src/auth/password-hasher.js";
import type { RedisRateLimiter } from "../src/common/rate-limit/redis-rate-limiter.js";
import { DEFAULT_REQUEST_LIMIT_POLICY } from "../src/common/rate-limit/request-limit-policy.js";
import type { AppEnvironment } from "../src/config/environment.js";

const path = process.env.AUTH_QA_MARIADB_CONFIG;
if (!path)
  throw new Error(
    "Run node QUALITY/auth-isolated-mariadb.mjs; an owned temporary TLS MariaDB is mandatory.",
  );
const password = randomBytes(24).toString("base64url"),
  secret = randomBytes(20),
  key = randomBytes(32).toString("base64url");
const metadata = {
  clientIp: "127.0.0.1",
  requestId: randomUUID(),
  userAgent: "isolated-auth-mariadb",
};
let admin: Kysely<DB>, app: Kysely<DB>, auth: AdminAuthService, factors: AdminPasskeysService;
let browser: Awaited<ReturnType<typeof startVirtualPasskeyBrowser>>,
  session: AuthenticatedAdminSession;
let credentialId: string;
const date = (value: Date) => adminAuthDate(value, "mariadb");
async function strong() {
  await admin
    .updateTable("admin_mfa_factors")
    .set({ last_accepted_timestep: null })
    .where("admin_account_id", "=", "1")
    .execute();
  await auth.stepUp(session, password, totpCodeAt(secret, Date.now()), metadata);
}
beforeAll(async () => {
  const target = JSON.parse(await readFile(path!, "utf8"));
  expect(target.kind).toBe("classhub-auth-isolated-qa");
  expect([3000, 3301, 3306, 3307, 5173, 5174, 6380]).not.toContain(target.port);
  const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
  const mysql = require("mysql2");
  const options = {
    host: target.host,
    port: target.port,
    database: target.database,
    sslCa: target.sslCa,
  };
  admin = new Kysely<DB>({
    dialect: new MysqlDialect({
      pool: mysql.createPool({
        host: target.host,
        port: target.port,
        database: target.database,
        user: target.user,
        password: target.password,
        ssl: { ca: target.sslCa, rejectUnauthorized: true, verifyIdentity: true },
        timezone: "Z",
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        multipleStatements: true,
        connectionLimit: 3,
      }),
    }),
  });
  app = createMariaDbDatabase<DB>(createMysql2MariaDbPool, {
    ...options,
    user: target.appUser,
    password: target.appPassword,
  });
  browser = await startVirtualPasskeyBrowser();
  const config = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: "mariadb",
    ADMIN_WEB_ENABLED: true,
    ADMIN_PASSKEYS_ENABLED: true,
    ADMIN_WEBAUTHN_RP_ID: "localhost",
    PUBLIC_APP_ORIGIN: browser.origin,
    ADMIN_MFA_ENCRYPTION_KEY: key,
    ADMIN_MFA_KEY_VERSION: "qa-1",
    EMAIL_HMAC_KEY: randomBytes(32).toString("base64url"),
    EMAIL_HMAC_KEY_VERSION: "qa-1",
  });
  // Redis policy is covered by PostgreSQL+HTTP tests. This gate tests the real MariaDB driver/locks/ACL.
  const limiter = {
    getPolicy: async () => DEFAULT_REQUEST_LIMIT_POLICY,
    consume: async () => ({
      allowed: true,
      count: 1,
      limit: 100,
      remaining: 99,
      retryAfterSeconds: 0,
    }),
    // 0cfa68d1(관리자 로그인 출처·계정 한도)·93e619d8(2단계 오답 한도)가 쓰는 읽기·비우기도 둔다.
    peek: async () => ({
      allowed: true,
      count: 0,
      limit: 100,
      remaining: 100,
      retryAfterSeconds: 0,
    }),
    clear: async () => undefined,
    reset: async () => undefined,
  } as unknown as RedisRateLimiter;
  factors = new AdminPasskeysService(app, config, limiter);
  auth = new AdminAuthService(app, limiter, config, undefined, factors);
  await admin
    .insertInto("operators")
    .values({
      id: "1",
      email_normalized: "operator@example.test",
      credential_hash: randomBytes(32),
    })
    .execute();
  await admin
    .insertInto("admin_accounts")
    .values({
      id: "1",
      email_normalized: "admin@example.test",
      display_name: "격리 관리자",
      password_hash: await hashPassword(password),
      created_by_operator_id: "1",
      status: "active",
    })
    .execute();
  await admin
    .insertInto("admin_account_roles")
    .values({ admin_account_id: "1", role: "super_admin", granted_by_operator_id: "1" })
    .execute();
  const encrypted = encryptTotpSecret(secret, key, "qa-1", "1");
  await admin
    .insertInto("admin_mfa_factors")
    .values({
      admin_account_id: "1",
      secret_ciphertext: encrypted.ciphertext,
      secret_iv: encrypted.iv,
      secret_auth_tag: encrypted.authTag,
      key_version: "qa-1",
      status: "active",
      activated_at: date(new Date()),
    })
    .execute();
  const login = await auth.beginLogin("admin@example.test", password, metadata);
  // Deliberately put the DB6 creation clock ahead of the app's millisecond clock.
  await admin
    .updateTable("admin_login_challenges")
    .set({ created_at: sql<Date>`DATE_ADD(created_at, INTERVAL 1 SECOND)` })
    .where("admin_account_id", "=", "1")
    .where("consumed_at", "is", null)
    .execute();
  session = (
    await auth.completeTotp(login.challengeToken, totpCodeAt(secret, Date.now()), metadata)
  ).session;
}, 120000);
afterAll(async () => {
  await Promise.allSettled([app?.destroy(), admin?.destroy(), browser?.close()]);
}, 120000);

describe.sequential("administrator factors with isolated MariaDB TLS and runtime ACL", () => {
  it("uses TOTP step-up and registers a real browser passkey through the restricted app role", async () => {
    await strong();
    const options = await factors.registrationOptions(session, metadata);
    const response = await browser.registration(options.options);
    credentialId = response.id;
    expect(
      await factors.register(session, options.ceremony_id, response, "격리 노트북", metadata),
    ).toEqual({ registered: true });
    expect(await factors.factors(session)).toMatchObject({
      enabled: true,
      passkeys: [{ id: credentialId, used_at: null }],
    });
  });
  it("issues a session and passkey step-up using real signatures and decoded MariaDB timestamps", async () => {
    const login = await auth.beginLogin("admin@example.test", password, metadata);
    const options = await auth.beginPasskeyLogin(login.challengeToken, metadata);
    const issued = await auth.completeAlternativeLogin(
      login.challengeToken,
      {
        kind: "passkey",
        ceremonyId: options.ceremony_id,
        response: await browser.authentication(options.options),
      },
      metadata,
    );
    session = issued.session;
    const step = await auth.beginPasskeyStepUp(session, metadata);
    await auth.stepUpAlternative(
      session,
      password,
      {
        kind: "passkey",
        ceremonyId: step.ceremony_id,
        response: await browser.authentication(step.options),
      },
      metadata,
    );
    expect(await factors.factors(session)).toMatchObject({
      passkeys: [{ used_at: expect.any(String) }],
    });
  });
  it("atomically consumes one recovery code, forbids weaker factor changes and revokes old codes", async () => {
    const { codes } = await factors.regenerateRecoveryCodes(session, metadata);
    const login = await auth.beginLogin("admin@example.test", password, metadata);
    const issued = await auth.completeAlternativeLogin(
      login.challengeToken,
      { kind: "recovery", code: codes[0]! },
      metadata,
    );
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        auth.stepUpAlternative(
          issued.session,
          password,
          { kind: "recovery", code: codes[1]! },
          metadata,
        ),
      ),
    );
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    await expect(factors.regenerateRecoveryCodes(issued.session, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_STRONG_STEP_UP_REQUIRED" },
    });
    const replay = await auth.beginLogin("admin@example.test", password, metadata);
    await expect(
      auth.completeAlternativeLogin(
        replay.challengeToken,
        { kind: "recovery", code: codes[0]! },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
    await strong();
    await factors.regenerateRecoveryCodes(session, metadata);
    const old = await auth.beginLogin("admin@example.test", password, metadata);
    await expect(
      auth.completeAlternativeLogin(
        old.challengeToken,
        { kind: "recovery", code: codes[2]! },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
  });
  it("denies key/hash tampering and deleting the last durable factor; foreign keys are active", async () => {
    await expect(
      adminFactorDatabase(app)
        .updateTable("admin_passkeys")
        .set({ public_key: randomBytes(32) })
        .where("credential_id", "=", credentialId)
        .execute(),
    ).rejects.toThrow(/denied/iu);
    await expect(
      adminFactorDatabase(app)
        .updateTable("admin_recovery_codes")
        .set({ code_hash: randomBytes(32) })
        .execute(),
    ).rejects.toThrow(/denied/iu);
    await expect(
      adminFactorDatabase(admin)
        .insertInto("admin_recovery_codes")
        .values({
          id: randomUUID(),
          admin_account_id: "99999",
          code_hash: randomBytes(32),
          created_at: date(new Date()),
          used_at: null,
          revoked_at: null,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/iu);
    await strong();
    await factors.revoke(session, null, metadata);
    await expect(factors.revoke(session, credentialId, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_LAST_FACTOR" },
    });
  });
});
