import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import {
  app,
  database,
  publicOrigin,
  setupSuppliesHarnessWithRedisAndApplicationFactory,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";
import { createApplication } from "../src/app.factory.js";
import { loadEnvironment } from "../src/config/environment.js";
import { hashPassword, verifyPassword } from "../src/auth/password-hasher.js";
import { hashVerificationToken } from "../src/auth/auth-crypto.js";
import { issueSessionSecrets } from "../src/auth/session-crypto.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/auth/session-cookie.js";
import { PasswordResetService } from "../src/auth/password-reset.service.js";
import { AdminAuthService } from "../src/admin-auth/admin-auth.service.js";
import { AdminAccountsService } from "../src/admin-accounts/admin-accounts.service.js";
import { AdminUsersService } from "../src/admin-management/admin-users.service.js";
import {
  decodeBase32,
  encryptTotpSecret,
  totpCodeAt,
} from "../src/admin-auth/admin-auth.crypto.js";
import type { AuthenticatedAdminSession } from "../src/admin-auth/admin-auth.types.js";
import {
  SECURITY_CHANGE_MAILER,
  SmtpSecurityChangeMailer,
} from "../src/mail/security-change-mailer.js";

let mailpit: StartedNativeTestService;
let initialHash: string;
let operatorId: string;
let anchorId: string;
const initialPassword = "Saffron42!";
const nextPassword = "Orchid74!";
// 2026-10-02 사용자 결정: 관리자 새 비밀번호는 12자 이상.
const nextAdminPassword = "Orchid74!Maple";
const mfaKey = Buffer.alloc(32, 67).toString("base64url");
const metadata = () => ({
  clientIp: "127.0.0.1",
  requestId: randomUUID(),
  userAgent: "synthetic-security-notice",
});
const mailOrigin = () => `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
beforeAll(async () => {
  mailpit = await startNativeTestService("mailpit", { MP_SMTP_DISABLE_RDNS: "true" });
  await setupSuppliesHarnessWithRedisAndApplicationFactory(async () =>
    createApplication({
      environment: loadEnvironment({
        ...process.env,
        ADMIN_WEB_ENABLED: "true",
        ADMIN_MFA_ENCRYPTION_KEY: mfaKey,
        ADMIN_MFA_KEY_VERSION: "synthetic-5d",
        PASSWORD_RESET_ENABLED: "true",
        SMTP_HOST: mailpit.getHost() === "localhost" ? "127.0.0.1" : mailpit.getHost(),
        SMTP_PORT: String(mailpit.getMappedPort(1025)),
        SMTP_FROM: "notice@example.invalid",
        SMTP_SECURE: "false",
        SMTP_REQUIRE_TLS: "false",
        SMTP_USERNAME: undefined,
        SMTP_PASSWORD: undefined,
      }),
    }),
  );
  initialHash = await hashPassword(initialPassword);
  operatorId = (
    await database
      .insertInto("operators")
      .values({
        email_normalized: "security-notice-operator@example.invalid",
        credential_hash: randomBytes(32),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  const anchor = await admin("active");
  anchorId = anchor.id;
  await database
    .updateTable("admin_account_roles")
    .set({ role: "super_admin" })
    .where("admin_account_id", "=", anchorId)
    .execute();
}, 120_000);
afterAll(async () => {
  const outcomes = await Promise.allSettled([teardownSuppliesHarness(), mailpit?.stop()]);
  const failure = outcomes.find(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );
  if (failure) throw failure.reason;
}, 120_000);

async function user(verified = true) {
  const email = `notice-${randomUUID()}@example.invalid`;
  const row = await database
    .insertInto("users")
    .values({
      display_name: "보안 안내 사용자",
      email_normalized: email,
      password_hash: initialHash,
      password_input_version: "nfc_v1",
      email_verified_at: verified ? new Date() : null,
      signup_approved_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const secrets = issueSessionSecrets();
  await database
    .insertInto("sessions")
    .values({
      user_id: row.id,
      session_hash: secrets.sessionTokenHash,
      csrf_token_hash: secrets.csrfTokenHash,
      created_ip: "127.0.0.1",
      expires_at: new Date(Date.now() + 60_000),
    })
    .execute();
  return {
    id: row.id,
    email,
    headers: {
      origin: publicOrigin,
      cookie: `${SESSION_COOKIE_NAME}=${secrets.sessionToken}; ${CSRF_COOKIE_NAME}=${secrets.csrfToken}`,
      "x-csrf-token": secrets.csrfToken,
    },
  };
}
async function admin(status: "active" | "pending_mfa" | "suspended" = "active") {
  const email = `admin-notice-${randomUUID()}@example.invalid`;
  const row = await database
    .insertInto("admin_accounts")
    .values({
      email_normalized: email,
      display_name: "보안 안내 관리자",
      status,
      password_hash: initialHash,
      password_input_version: "nfc_v1",
      created_by_operator_id: operatorId,
      created_by_admin_account_id: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await database
    .insertInto("admin_account_roles")
    .values({ admin_account_id: row.id, role: "support", granted_by_operator_id: operatorId })
    .execute();
  return { id: row.id, email };
}
async function adminSession(
  target: Awaited<ReturnType<typeof admin>>,
): Promise<AuthenticatedAdminSession> {
  const now = new Date(),
    expires = new Date(now.getTime() + 60_000),
    secrets = issueSessionSecrets();
  const row = await database
    .insertInto("admin_sessions")
    .values({
      admin_account_id: target.id,
      session_hash: secrets.sessionTokenHash,
      csrf_token_hash: secrets.csrfTokenHash,
      created_ip_hmac: "x".repeat(43),
      hmac_key_version: "test-v1",
      issued_at: now,
      last_seen_at: now,
      mfa_verified_at: now,
      reauthenticated_at: now,
      absolute_expires_at: expires,
      revoked_at: null,
      user_agent: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return {
    absoluteExpiresAt: expires,
    adminAccountId: target.id,
    csrfTokenHash: secrets.csrfTokenHash,
    displayName: "보안 안내 관리자",
    email: target.email,
    issuedAt: now,
    lastSeenAt: now,
    mfaVerifiedAt: now,
    reauthenticatedAt: now,
    roles: ["support"],
    sessionId: row.id,
  };
}
interface MailSummary {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
}
async function messages(email: string, expected: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`${mailOrigin()}/api/v1/messages`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { messages: MailSummary[] };
    const found = body.messages.filter((message) => message.To.some((to) => to.Address === email));
    if (found.length >= expected) return found;
    await delay(50);
  }
  throw new Error("Synthetic security mail did not arrive");
}
async function expectNotice(email: string, phrase: string, count = 1) {
  const received = await messages(email, count);
  expect(received).toHaveLength(count);
  const detail = (await fetch(`${mailOrigin()}/api/v1/message/${received[0]!.ID}`).then(
    (response) => response.json(),
  )) as { Text: string; HTML: string };
  expect(detail.Text).toContain(phrase);
  expect(detail.Text).not.toContain(initialPassword);
  expect(detail.Text).not.toContain(nextPassword);
  expect(detail.Text).not.toContain(nextAdminPassword);
  expect(detail.HTML).not.toContain("/admin/login");
  const receipts = await database
    .selectFrom("mail_delivery_logs")
    .select(["status", "subject", "failure_code"])
    .where("recipient_email", "=", email)
    .execute();
  expect(receipts).toHaveLength(count);
  expect(
    receipts.every((receipt) => receipt.status === "accepted" && receipt.failure_code === null),
  ).toBe(true);
}
function changePassword(actor: Awaited<ReturnType<typeof user>>, password = initialPassword) {
  return app.inject({
    method: "PATCH",
    url: "/api/v1/account/password",
    headers: actor.headers,
    payload: { current_password: password, new_password: nextPassword },
  });
}
async function resetToken(id: string) {
  const raw = randomBytes(32).toString("base64url");
  await database
    .insertInto("password_reset_tokens")
    .values({
      user_id: id,
      token_hash: hashVerificationToken(raw),
      expires_at: new Date(Date.now() + 60_000),
      requested_ip: "127.0.0.1",
    })
    .execute();
  return raw;
}

describe.sequential(
  "committed account security notifications with real PostgreSQL and SMTP",
  () => {
    it("resolves the production notification provider and sends only after password and session changes complete", async () => {
      expect(app.get(SECURITY_CHANGE_MAILER)).toBeInstanceOf(SmtpSecurityChangeMailer);
      const actor = await user();
      const response = await changePassword(actor);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ next_action: "LOGIN", password_changed: true });
      const row = await database
        .selectFrom("users")
        .select("password_hash")
        .where("id", "=", actor.id)
        .executeTakeFirstOrThrow();
      expect(await verifyPassword(nextPassword, row.password_hash)).toBe(true);
      expect(
        await database
          .selectFrom("sessions")
          .select("id")
          .where("user_id", "=", actor.id)
          .where("revoked_at", "is", null)
          .execute(),
      ).toHaveLength(0);
      await expectNotice(actor.email, "계정 비밀번호가 바뀌었어요");
      expect((await changePassword(actor)).statusCode).toBe(401);
      expect(await messages(actor.email, 1)).toHaveLength(1);
    });
    it("does not mail failed password checks or expose delivery fields in the API", async () => {
      const actor = await user();
      const response = await changePassword(actor, "Wrong43!");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
      expect(await messages(actor.email, 0)).toHaveLength(0);
      expect(
        await database
          .selectFrom("mail_delivery_logs")
          .select("id")
          .where("recipient_email", "=", actor.email)
          .execute(),
      ).toHaveLength(0);
    });
    it("sends one reset completion notice and rejects token replay without a second mail", async () => {
      const actor = await user(),
        token = await resetToken(actor.id),
        service = app.get(PasswordResetService);
      await expect(service.confirmReset(token, nextPassword, metadata())).resolves.toEqual({
        next_action: "LOGIN",
        password_reset: true,
      });
      await expectNotice(actor.email, "비밀번호가 새로 정해졌어요");
      await expect(service.confirmReset(token, nextPassword, metadata())).rejects.toThrow();
      expect(await messages(actor.email, 1)).toHaveLength(1);
    });
    it("does not send security mail to an unverified user address", async () => {
      const actor = await user(false);
      await app
        .get(PasswordResetService)
        .confirmReset(await resetToken(actor.id), nextPassword, metadata());
      expect(await messages(actor.email, 0)).toHaveLength(0);
    });
    it.each([false, true])(
      "notifies verified user status changes through the real app provider (active=%s)",
      async (active) => {
        const actor = await user();
        if (active)
          await database
            .updateTable("users")
            .set({ is_active: false })
            .where("id", "=", actor.id)
            .execute();
        await app
          .get(AdminUsersService)
          .updateStatus(
            actor.id,
            active ? "active" : "inactive",
            "합성 확인",
            anchorId,
            randomUUID(),
          );
        await expectNotice(
          actor.email,
          active ? "계정을 다시 쓸 수 있게 됐어요" : "계정 이용이 정지",
        );
      },
    );
    it("stops second-factor checks after 10 failures an hour and mails the administrator once (total audit C1-04)", async () => {
      const target = await admin();
      const secret = randomBytes(20);
      const sealed = encryptTotpSecret(secret, mfaKey, "synthetic-5d", target.id);
      await database
        .insertInto("admin_mfa_factors")
        .values({
          admin_account_id: target.id,
          key_version: "synthetic-5d",
          secret_ciphertext: sealed.ciphertext,
          secret_iv: sealed.iv,
          secret_auth_tag: sealed.authTag,
          status: "active",
          activated_at: new Date(),
        })
        .execute();
      const wrongCode = totpCodeAt(secret, Date.now()) === "000000" ? "111111" : "000000";
      const auth = app.get(AdminAuthService);
      // 세션마다 재확인 한도가 따로라 새 세션으로 시도한다. 계정 기준 누적은 세션과 상관없이 이어진다.
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await expect(
          auth.stepUp(await adminSession(target), initialPassword, wrongCode, metadata()),
        ).rejects.toMatchObject({ status: 401 });
      }
      await expect(
        auth.stepUp(await adminSession(target), initialPassword, wrongCode, metadata()),
      ).rejects.toMatchObject({ status: 429 });
      await expectNotice(target.email, "2단계 확인이 1시간 안에 여러 번 틀렸어요");
    });
    it("notifies administrator password change without mailing the new password or reviving other sessions", async () => {
      const target = await admin(),
        session = await adminSession(target);
      await adminSession(target);
      await app.get(AdminAuthService).changePassword(session, nextAdminPassword, metadata());
      await expectNotice(target.email, "관리자 계정 비밀번호가 바뀌었어요");
      const sessions = await database
        .selectFrom("admin_sessions")
        .select("id")
        .where("admin_account_id", "=", target.id)
        .where("revoked_at", "is", null)
        .execute();
      expect(sessions.map((row) => row.id)).toEqual([session.sessionId]);
    });
    it.each(["roles", "credentials", "mfa", "suspend", "revoke", "activate"] as const)(
      "sends a notice for administrator %s only to the affected account",
      async (action) => {
        const target = await admin(action === "activate" ? "suspended" : "active"),
          service = app.get(AdminAccountsService),
          requestId = randomUUID();
        if (action === "roles")
          await service.replaceRoles(
            target.id,
            ["security_auditor"],
            "합성 역할",
            anchorId,
            requestId,
          );
        else if (action === "credentials")
          await service.resetCredentials(target.id, "합성 초기화", anchorId, requestId);
        else if (action === "mfa")
          await service.resetMfa(target.id, "합성 초기화", anchorId, requestId);
        else
          await service.updateStatus(
            target.id,
            action === "activate" ? "active" : action === "suspend" ? "suspended" : "revoked",
            "합성 상태",
            anchorId,
            requestId,
          );
        await expectNotice(target.email, "관리자 계정");
        if (action === "roles") {
          await service.replaceRoles(
            target.id,
            ["security_auditor"],
            "합성 동일 역할",
            anchorId,
            randomUUID(),
          );
          expect(await messages(target.email, 1)).toHaveLength(1);
        }
      },
    );
    it("notifies successful MFA enrollment once and sends no notice for invalid/replayed challenges", async () => {
      const service = app.get(AdminAuthService);
      const target = await admin("pending_mfa");
      const started = await service.beginLogin(target.email, initialPassword, metadata());
      if (!started.setup) throw new Error("Synthetic MFA setup was not issued");
      const challenge = started.challengeToken,
        secret = decodeBase32(started.setup.manualKey);
      await expect(service.completeTotp("invalid", "000000", metadata())).rejects.toThrow();
      await service.completeTotp(challenge, totpCodeAt(secret, Date.now()), metadata());
      await expectNotice(target.email, "2단계 인증이 등록됐어요");
      await expect(
        service.completeTotp(challenge, totpCodeAt(secret, Date.now()), metadata()),
      ).rejects.toThrow();
      expect(await messages(target.email, 1)).toHaveLength(1);
    });
    it("keeps a committed password change successful when the mail receipt write fails, without sending an unrecorded mail", async () => {
      const actor = await user();
      await sql`CREATE FUNCTION synthetic_security_mail_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER synthetic_security_mail_failure BEFORE INSERT ON mail_delivery_logs FOR EACH ROW EXECUTE FUNCTION synthetic_security_mail_failure()`.execute(
        database,
      );
      try {
        const response = await changePassword(actor);
        expect(response.statusCode, response.body).toBe(200);
        const row = await database
          .selectFrom("users")
          .select("password_hash")
          .where("id", "=", actor.id)
          .executeTakeFirstOrThrow();
        expect(await verifyPassword(nextPassword, row.password_hash)).toBe(true);
        expect(await messages(actor.email, 0)).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER synthetic_security_mail_failure ON mail_delivery_logs`.execute(
          database,
        );
        await sql`DROP FUNCTION synthetic_security_mail_failure()`.execute(database);
      }
    });
  },
);
