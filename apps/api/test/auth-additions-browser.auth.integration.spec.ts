import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { socialAuthHarness } from "./social-auth-test-harness.js";
import { verifyAuthUi } from "../../../browser-qa/auth-additions-ui.mjs";
import { AdminAuthService } from "../src/admin-auth/admin-auth.service.js";
import { encryptTotpSecret, totpCodeAt } from "../src/admin-auth/admin-auth.crypto.js";
import { hashPassword } from "../src/auth/password-hasher.js";

let h: Awaited<ReturnType<typeof socialAuthHarness>>;
beforeAll(async () => {
  h = await socialAuthHarness(false, true);
}, 120000);
afterAll(async () => {
  await h?.close();
}, 120000);
it("completes source-UI social signup/link and admin passkey/recovery with an isolated CDP authenticator", async () => {
  const password = randomBytes(24).toString("base64url"),
    secret = randomBytes(20),
    email = "social-admin@example.test";
  const admin = await h.admin
    .selectFrom("admin_accounts")
    .select(["id", "created_by_operator_id"])
    .where("email_normalized", "=", email)
    .executeTakeFirstOrThrow();
  await h.admin
    .updateTable("admin_accounts")
    .set({ password_hash: await hashPassword(password) })
    .where("id", "=", admin.id)
    .execute();
  await h.admin
    .insertInto("admin_account_roles")
    .values({
      admin_account_id: admin.id,
      role: "super_admin",
      granted_by_operator_id: admin.created_by_operator_id,
    })
    .execute();
  const encrypted = encryptTotpSecret(
    secret,
    h.config.getOrThrow("ADMIN_MFA_ENCRYPTION_KEY"),
    "qa-1",
    admin.id,
  );
  await h.admin
    .insertInto("admin_mfa_factors")
    .values({
      admin_account_id: admin.id,
      secret_ciphertext: encrypted.ciphertext,
      secret_iv: encrypted.iv,
      secret_auth_tag: encrypted.authTag,
      key_version: "qa-1",
      status: "active",
      activated_at: new Date(),
    })
    .execute();
  const auth = h.http!.get(AdminAuthService),
    metadata = { clientIp: "127.0.0.1", requestId: randomUUID(), userAgent: "isolated-source-ui" };
  const ageChallenge = async () => {
    await h.admin
      .updateTable("admin_login_challenges")
      .set({ created_at: sql<Date>`created_at - interval '5 seconds'` })
      .where("consumed_at", "is", null)
      .execute();
  };
  const result = await verifyAuthUi(h, {
    email,
    password,
    ageChallenge,
    totp: () => totpCodeAt(secret, Date.now()),
    resetTotp: async () => {
      await h.admin
        .updateTable("admin_mfa_factors")
        .set({ last_accepted_timestep: null })
        .where("admin_account_id", "=", admin.id)
        .execute();
    },
    issue: async () => {
      const challenge = await auth.beginLogin(email, password, metadata);
      await ageChallenge();
      return auth.completeTotp(challenge.challengeToken, totpCodeAt(secret, Date.now()), metadata);
    },
  });
  expect(result).toMatchObject({
    socialSignup: true,
    passkeyLogin: true,
    recoveryLogin: true,
    screenshots: 5,
  });
}, 180000);
