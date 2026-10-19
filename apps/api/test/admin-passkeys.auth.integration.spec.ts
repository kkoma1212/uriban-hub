import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "kysely";
import { createClient, type RedisClientType } from "redis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  SECURITY_CHANGE_MAILER,
  type SecurityChangeMailer,
} from "../src/mail/security-change-mailer.js";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { startVirtualPasskeyBrowser } from "../../../browser-qa/lib/admin-passkey-virtual.mjs";
import { createApplication } from "../src/app.factory.js";
import { loadEnvironment } from "../src/config/environment.js";
import { hashPassword } from "../src/auth/password-hasher.js";
import { AdminAuthService } from "../src/admin-auth/admin-auth.service.js";
import { AdminPasskeysService } from "../src/admin-auth/admin-passkeys.service.js";
import { AdminAccountsService } from "../src/admin-accounts/admin-accounts.service.js";
import { adminFactorDatabase } from "../src/admin-auth/admin-passkeys.database.js";
import { encryptTotpSecret, totpCodeAt } from "../src/admin-auth/admin-auth.crypto.js";
import type { AuthenticatedAdminSession } from "../src/admin-auth/admin-auth.types.js";
import { loadAllTestMigrationPaths } from "./migration-test-source.js";

let postgres: StartedNativeTestService, redis: StartedNativeTestService;
let bootstrap: ReturnType<typeof createDatabase<DB>>, app: NestFastifyApplication;
let observer: RedisClientType, browser: Awaited<ReturnType<typeof startVirtualPasskeyBrowser>>;
let auth: AdminAuthService, factors: AdminPasskeysService, session: AuthenticatedAdminSession;
let securityNotices: MockInstance<SecurityChangeMailer["sendSecurityChange"]>;
const noticeKinds = () => securityNotices.mock.calls.map(([notice]) => notice.kind);
let accountId: string, credentialId: string;
const password = randomBytes(24).toString("base64url"),
  totpSecret = randomBytes(20),
  encryptionKey = randomBytes(32).toString("base64url");
const metadata = {
  clientIp: "127.0.0.1",
  requestId: randomUUID(),
  userAgent: "isolated-auth-test",
};
const email = "passkey-qa@example.test";
const url = (user: string, secret: string) =>
  `postgresql://${user}:${secret}@127.0.0.1:${postgres.getMappedPort(5432)}/classhub_dev`;
async function resetTotp() {
  await bootstrap
    .updateTable("admin_mfa_factors")
    .set({ last_accepted_timestep: null })
    .where("admin_account_id", "=", accountId)
    .execute();
}
async function loginChallenge() {
  const challenge = await auth.beginLogin(email, password, metadata);
  await bootstrap
    .updateTable("admin_login_challenges")
    .set({ created_at: sql<Date>`created_at - interval '5 seconds'` })
    .where("consumed_at", "is", null)
    .execute();
  return challenge;
}
async function strongStepUp() {
  await resetTotp();
  await auth.stepUp(session, password, totpCodeAt(totpSecret, Date.now()), metadata);
}
async function register() {
  const options = await factors.registrationOptions(session, metadata);
  const response = await browser.registration(options.options);
  await factors.register(session, options.ceremony_id, response, "가상 Windows Hello", metadata);
  return { options, response };
}

beforeAll(async () => {
  const started = await Promise.allSettled([
    startNativeTestService("postgres", {
      POSTGRES_DB: "classhub_dev",
      POSTGRES_PASSWORD: "local_bootstrap_password",
      POSTGRES_USER: "classhub_bootstrap",
    }).then((value) => {
      postgres = value;
    }),
    startNativeTestService("redis").then((value) => {
      redis = value;
    }),
    startVirtualPasskeyBrowser().then((value) => {
      browser = value;
    }),
  ]);
  const failure = started.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  bootstrap = createDatabase<DB>(url("classhub_bootstrap", "local_bootstrap_password"));
  await sql
    .raw(
      await readFile(
        new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
        "utf8",
      ),
    )
    .execute(bootstrap);
  const migrator = createDatabase<DB>(url("classhub_migrator", "local_migrator_password"));
  try {
    await sql
      .raw(
        "CREATE TABLE pgmigrations (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, run_on TIMESTAMPTZ NOT NULL)",
      )
      .execute(migrator);
    for (const path of await loadAllTestMigrationPaths()) {
      const up = (await readFile(path, "utf8"))
        .split("-- Down Migration", 1)[0]!
        .replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
  const operator = await bootstrap
    .insertInto("operators")
    .values({ credential_hash: randomBytes(32), email_normalized: "operator@example.test" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const account = await bootstrap
    .insertInto("admin_accounts")
    .values({
      email_normalized: email,
      display_name: "검수 관리자",
      password_hash: await hashPassword(password),
      created_by_operator_id: operator.id,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  accountId = account.id;
  await bootstrap
    .insertInto("admin_account_roles")
    .values({
      admin_account_id: accountId,
      role: "super_admin",
      granted_by_operator_id: operator.id,
    })
    .execute();
  const encrypted = encryptTotpSecret(totpSecret, encryptionKey, "qa-1", accountId);
  await bootstrap
    .insertInto("admin_mfa_factors")
    .values({
      admin_account_id: accountId,
      secret_ciphertext: encrypted.ciphertext,
      secret_iv: encrypted.iv,
      secret_auth_tag: encrypted.authTag,
      key_version: "qa-1",
      status: "active",
      activated_at: new Date(),
    })
    .execute();
  const environment = loadEnvironment({
    NODE_ENV: "development",
    DATABASE_URL: url("classhub_app", "local_app_password"),
    EMAIL_HMAC_KEY: randomBytes(32).toString("base64url"),
    EMAIL_HMAC_KEY_VERSION: "qa-1",
    ADMIN_MFA_ENCRYPTION_KEY: encryptionKey,
    ADMIN_MFA_KEY_VERSION: "qa-1",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_PASSKEYS_ENABLED: "true",
    ADMIN_WEBAUTHN_RP_ID: "localhost",
    REDIS_URL: `redis://127.0.0.1:${redis.getMappedPort(6379)}`,
    PUBLIC_APP_ORIGIN: browser.origin,
    PUBLIC_API_ORIGIN: browser.origin,
    LOG_LEVEL: "fatal",
    SERVE_WEB: "false",
  });
  ({ app } = await createApplication({ environment }));
  observer = createClient({ url: environment.REDIS_URL });
  observer.on("error", () => undefined);
  await observer.connect();
  auth = app.get(AdminAuthService);
  factors = app.get(AdminPasskeysService);
  // 총검수 C1-05: 실제 메일 대신 보낸 알림 종류만 기록한다.
  securityNotices = vi
    .spyOn(app.get<SecurityChangeMailer>(SECURITY_CHANGE_MAILER), "sendSecurityChange")
    .mockResolvedValue("accepted");
  const challenge = await loginChallenge();
  session = (
    await auth.completeTotp(challenge.challengeToken, totpCodeAt(totpSecret, Date.now()), metadata)
  ).session;
}, 120000);
beforeEach(async () => {
  if (observer?.isOpen) await observer.flushDb();
});
afterAll(async () => {
  observer?.destroy();
  await Promise.allSettled([
    app?.close(),
    bootstrap?.destroy(),
    browser?.close(),
    redis?.stop(),
    postgres?.stop(),
  ]);
}, 120000);

describe.sequential("administrator passkeys and recovery in isolated PostgreSQL", () => {
  it("requires a fresh strong step-up then verifies a real browser registration and rejects replay", async () => {
    await expect(factors.registrationOptions(session, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_STRONG_STEP_UP_REQUIRED" },
    });
    await strongStepUp();
    const { options, response } = await register();
    credentialId = response.id;
    expect(noticeKinds()).toContain("admin_passkey_registered");
    expect(await factors.factors(session)).toMatchObject({
      enabled: true,
      passkeys: [{ id: response.id }],
    });
    await expect(
      factors.register(session, options.ceremony_id, response, "재사용", metadata),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
  });
  it("logs in with the passkey and performs passkey step-up using the original password", async () => {
    const login = await loginChallenge();
    expect(login.methods).toEqual(["totp", "passkey"]);
    const options = await auth.beginPasskeyLogin(login.challengeToken, metadata);
    const response = await browser.authentication(options.options);
    const issued = await auth.completeAlternativeLogin(
      login.challengeToken,
      { kind: "passkey", ceremonyId: options.ceremony_id, response },
      metadata,
    );
    const stepUp = await auth.beginPasskeyStepUp(issued.session, metadata);
    await auth.stepUpAlternative(
      issued.session,
      password,
      {
        kind: "passkey",
        ceremonyId: stepUp.ceremony_id,
        response: await browser.authentication(stepUp.options),
      },
      metadata,
    );
    session = issued.session;
    expect((await factors.regenerateRecoveryCodes(session, metadata)).codes).toHaveLength(10);
  });
  it("rejects a missing user-verification flag and consumes the ceremony", async () => {
    const login = await loginChallenge();
    const options = await auth.beginPasskeyLogin(login.challengeToken, metadata);
    await browser.setUserVerified(false);
    let response;
    try {
      response = await browser.authentication({
        ...options.options,
        userVerification: "discouraged",
      });
    } finally {
      await browser.setUserVerified(true);
    }
    await expect(
      auth.completeAlternativeLogin(
        login.challengeToken,
        { kind: "passkey", ceremonyId: options.ceremony_id, response },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
    expect(
      (
        await adminFactorDatabase(bootstrap)
          .selectFrom("admin_webauthn_challenges")
          .select("consumed_at")
          .where("id", "=", options.ceremony_id)
          .executeTakeFirstOrThrow()
      ).consumed_at,
    ).not.toBeNull();
  });
  it.each(["origin", "challenge", "credential", "expired"])(
    "rejects wrong %s without issuing a session",
    async (tamper) => {
      const login = await loginChallenge();
      const options = await auth.beginPasskeyLogin(login.challengeToken, metadata);
      const response = await browser.authentication(options.options);
      if (tamper === "credential") response.id = randomBytes(32).toString("base64url");
      else if (tamper === "expired")
        await adminFactorDatabase(bootstrap)
          .updateTable("admin_webauthn_challenges")
          .set({
            created_at: new Date(Date.now() - 240000),
            expires_at: new Date(Date.now() - 120000),
          })
          .where("id", "=", options.ceremony_id)
          .execute();
      else {
        const client = JSON.parse(
          Buffer.from(response.response.clientDataJSON, "base64url").toString(),
        );
        client[tamper] =
          tamper === "origin" ? "https://attacker.example" : randomBytes(32).toString("base64url");
        response.response.clientDataJSON = Buffer.from(JSON.stringify(client)).toString(
          "base64url",
        );
      }
      await expect(
        auth.completeAlternativeLogin(
          login.challengeToken,
          { kind: "passkey", ceremonyId: options.ceremony_id, response },
          metadata,
        ),
      ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
    },
  );
  it("uses recovery codes once, stores only hashes and forbids recovery factor management", async () => {
    await strongStepUp();
    const { codes } = await factors.regenerateRecoveryCodes(session, metadata);
    expect(noticeKinds()).toContain("admin_recovery_codes_issued");
    const stored = await adminFactorDatabase(bootstrap)
      .selectFrom("admin_recovery_codes")
      .selectAll()
      .execute();
    expect(stored.every((row) => row.code_hash.length === 32)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(codes[0]);
    const login = await loginChallenge();
    const issued = await auth.completeAlternativeLogin(
      login.challengeToken,
      { kind: "recovery", code: codes[0]! },
      metadata,
    );
    expect(noticeKinds()).toContain("admin_recovery_code_used");
    const replay = await loginChallenge();
    await expect(
      auth.completeAlternativeLogin(
        replay.challengeToken,
        { kind: "recovery", code: codes[0]! },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        auth.stepUpAlternative(
          issued.session,
          password,
          { kind: "recovery", code: codes[1]! },
          metadata,
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(factors.regenerateRecoveryCodes(issued.session, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_STRONG_STEP_UP_REQUIRED" },
    });
    await expect(factors.registrationOptions(issued.session, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_STRONG_STEP_UP_REQUIRED" },
    });
    await expect(factors.revoke(issued.session, credentialId, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_STRONG_STEP_UP_REQUIRED" },
    });
    await observer.flushDb(); // The following independent reissue scenario has its own request budget.
    await strongStepUp();
    await factors.regenerateRecoveryCodes(session, metadata);
    const old = await loginChallenge();
    await expect(
      auth.completeAlternativeLogin(
        old.challengeToken,
        { kind: "recovery", code: codes[2]! },
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: "ADMIN_MFA_INVALID" } });
    const audits = await bootstrap.selectFrom("admin_auth_audit_logs").selectAll().execute();
    expect(audits.some((row) => row.action === "admin.auth.recovery_code_used")).toBe(true);
    expect(codes.some((code) => JSON.stringify(audits).includes(code))).toBe(false);
  });
  it("retains the final durable factor and allows a new device before revocation", async () => {
    await strongStepUp();
    await factors.revoke(session, null, metadata);
    await expect(factors.revoke(session, credentialId, metadata)).rejects.toMatchObject({
      response: { code: "ADMIN_LAST_FACTOR" },
    });
    await browser.newDevice();
    await register();
    await factors.revoke(session, credentialId, metadata);
    expect(noticeKinds()).toEqual(
      expect.arrayContaining(["admin_totp_removed", "admin_passkey_removed"]),
    );
    expect(await factors.factors(session)).toMatchObject({
      enabled: true,
      totp_enabled: false,
      passkeys: [expect.anything()],
    });
  });
  it("enforces HTTP origin/session guards and hides the feature when disabled", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/auth/passkeys/login/options",
          headers: { origin: "https://attacker.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/auth/recovery-codes",
          headers: { origin: browser.origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const config = app.get(ConfigService);
    config.set("ADMIN_PASSKEYS_ENABLED", false);
    try {
      expect(await factors.factors(session)).toEqual({ enabled: false });
      await expect(factors.registrationOptions(session, metadata)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        auth.beginPasskeyLogin(randomBytes(32).toString("base64url"), metadata),
      ).rejects.toMatchObject({ status: 401 });
    } finally {
      config.set("ADMIN_PASSKEYS_ENABLED", true);
    }
  });
  it("revokes passkeys and recovery codes when another super admin resets this account's MFA", async () => {
    // 총검수 C1-01: 초기화 뒤 옛 패스키·복구 코드가 다시 로그인 수단이 되지 않아야 한다.
    // 앞 시험이 세션을 끝냈으므로 살아 있는 패스키·복구 코드를 DB에 직접 둔다.
    await adminFactorDatabase(bootstrap)
      .insertInto("admin_passkeys")
      .values({
        credential_id: randomBytes(16).toString("base64url"),
        admin_account_id: accountId,
        public_key: randomBytes(32),
        user_handle: randomBytes(16).toString("base64url"),
        signature_counter: 0,
        transports_json: "[]",
        device_type: "singleDevice",
        backed_up: false,
        label: "초기화 전 기기",
        created_at: new Date(),
      } as never)
      .execute();
    await adminFactorDatabase(bootstrap)
      .insertInto("admin_recovery_codes")
      .values({
        id: randomUUID(),
        admin_account_id: accountId,
        code_hash: randomBytes(32),
        created_at: new Date(),
      } as never)
      .execute();
    const operator = await bootstrap.selectFrom("operators").select("id").executeTakeFirstOrThrow();
    const anchor = await bootstrap
      .insertInto("admin_accounts")
      .values({
        email_normalized: "anchor-admin@example.test",
        display_name: "다른 최고 관리자",
        password_hash: await hashPassword(password),
        created_by_operator_id: operator.id,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await bootstrap
      .insertInto("admin_account_roles")
      .values({
        admin_account_id: anchor.id,
        role: "super_admin",
        granted_by_operator_id: operator.id,
      })
      .execute();
    const factorRows = adminFactorDatabase(bootstrap);
    const live = async () => ({
      passkeys: (
        await factorRows
          .selectFrom("admin_passkeys")
          .select("credential_id")
          .where("admin_account_id", "=", accountId)
          .where("revoked_at", "is", null)
          .execute()
      ).length,
      codes: (
        await factorRows
          .selectFrom("admin_recovery_codes")
          .select("id")
          .where("admin_account_id", "=", accountId)
          .where("revoked_at", "is", null)
          .where("used_at", "is", null)
          .execute()
      ).length,
    });
    const before = await live();
    expect(before.passkeys).toBeGreaterThan(0);
    expect(before.codes).toBeGreaterThan(0);
    await app.get(AdminAccountsService).resetMfa(accountId, "합성 초기화", anchor.id, randomUUID());
    expect(await live()).toEqual({ passkeys: 0, codes: 0 });
  });
});
