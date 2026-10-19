import { randomBytes, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { socialAuthHarness } from "./social-auth-test-harness.js";
import { type MockFault } from "./social-auth.mock-provider.js";
import { SocialAuthProvider } from "../src/auth/social/social-auth.provider.js";
import { socialDatabase, SOCIAL_ONLY_PASSWORD } from "../src/auth/social/social-auth.database.js";
import {
  socialSettingsSchema,
  type SocialProvider,
} from "../src/auth/social/social-auth.environment.js";
import type { SignUpCommand } from "../src/auth/auth.types.js";
import { hashPassword, verifyPassword } from "../src/auth/password-hasher.js";
import { hashSessionSecret } from "../src/auth/session-crypto.js";

export function socialAuthScenarios(maria: boolean) {
  let h: Awaited<ReturnType<typeof socialAuthHarness>>;
  const ip = "127.0.0.1",
    context = { requestId: randomUUID(), userAgent: "social-isolated-qa" };
  const identities = () => socialDatabase(h.admin, maria);
  const command = (email: string): Omit<SignUpCommand, "password"> => ({
    email,
    display_name: "검수 학생",
    role: "student",
    age_route: "over_14",
    consents: { privacy: true, terms: true },
    legal_documents: h.snapshot,
  });
  async function authorize(
    provider: SocialProvider = "google",
    overrides: { email?: string; subject?: string; verified?: boolean } = {},
  ) {
    const identity = {
      email: `${randomUUID()}@example.test`,
      subject: randomUUID(),
      verified: true,
      ...overrides,
    };
    h.mock.identity(provider, identity);
    const start = await h.social.start(provider, ip, undefined, "signup_over_14");
    const parameters = await h.mock.authorize(start.url);
    return {
      identity,
      start,
      parameters,
      async complete(rawSession?: string) {
        return h.social.callback(
          provider,
          parameters,
          start.browserSecret,
          rawSession,
          ip,
          context.userAgent,
        );
      },
    };
  }
  async function signup(
    provider: SocialProvider = "google",
    overrides: { email?: string; subject?: string; verified?: boolean } = {},
    role: "student" | "teacher" = "student",
  ) {
    const flow = await authorize(provider, overrides),
      pending = await flow.complete();
    if (pending.kind !== "signup") throw new Error("Expected pending signup");
    const session = await h.social.signUp(
      pending.browserSecret,
      { ...command(flow.identity.email), role },
      ip,
      context,
    );
    const user = await h.admin
      .selectFrom("users")
      .selectAll()
      .where("email_normalized", "=", flow.identity.email)
      .executeTakeFirstOrThrow();
    return { ...flow, pending, session, user };
  }
  async function linkedAccount() {
    const result = await signup();
    const session = await h.sessions.authenticate(result.session.sessionToken);
    return { ...result, authenticated: session };
  }
  beforeAll(async () => {
    h = await socialAuthHarness(maria);
  }, 120000);
  beforeEach(async () => {
    if (h) await h.resetLimits();
  });
  afterAll(async () => {
    await h?.close();
  }, 120000);
  describe.sequential(
    `social authentication with real mock OIDC and isolated ${maria ? "MariaDB TLS" : "PostgreSQL"}`,
    () => {
      for (const provider of ["google", "naver", "kakao"] as const)
        it(`${provider}: PKCE signup, stored consent and subsequent subject login`, async () => {
          const first = await signup(provider);
          expect(first.user.password_hash).toBe(SOCIAL_ONLY_PASSWORD);
          expect(await verifyPassword(first.user.password_hash, SOCIAL_ONLY_PASSWORD)).toBe(false);
          expect(first.user.signup_approved_at).toBeNull();
          const consent = await h.admin
            .selectFrom("user_consents")
            .select(["document_snapshot", "consent_type"])
            .where("user_id", "=", first.user.id)
            .execute();
          expect(consent.map((row) => row.consent_type).sort()).toEqual([
            "age_over_14",
            "privacy",
            "terms",
          ]);
          expect(consent[0]?.document_snapshot).toBeTruthy();
          expect(await h.sessions.authenticate(first.session.sessionToken)).toMatchObject({
            userId: first.user.id,
            currentClassId: null,
          });
          await h.resetLimits();
          const login = await authorize(provider, {
            subject: first.identity.subject,
            email: "changed-at-provider@example.test",
          });
          const result = await login.complete();
          expect(result.kind).toBe("session");
          if (result.kind === "session")
            expect(await h.sessions.authenticate(result.session.sessionToken)).toMatchObject({
              userId: first.user.id,
            });
          expect(
            await identities()
              .selectFrom("social_identities")
              .selectAll()
              .where("user_id", "=", first.user.id)
              .execute(),
          ).toHaveLength(1);
          await expect(
            h.social.signUp(
              first.pending.browserSecret,
              command(first.identity.email),
              ip,
              context,
            ),
          ).rejects.toMatchObject({ response: { code: "SOCIAL_AUTH_INVALID" } });
        });
      it("keeps teacher approval and unverified-email gates; never trusts an edited address", async () => {
        const teacher = await signup("google", {}, "teacher");
        await expect(h.sessions.authenticate(teacher.session.sessionToken)).rejects.toBeDefined();
        expect(
          await h.sessions.authenticate(teacher.session.sessionToken, {
            allowUnverifiedEmail: true,
          }),
        ).toMatchObject({ userId: teacher.user.id });
        await h.resetLimits();
        const student = await signup("naver", { verified: false });
        expect(student.user.email_verified_at).toBeNull();
        await expect(h.sessions.authenticate(student.session.sessionToken)).rejects.toBeDefined();
        await h.resetLimits();
        const flow = await authorize("kakao"),
          pending = await flow.complete();
        if (pending.kind !== "signup") throw new Error("Expected signup");
        const email = `${randomUUID()}@example.test`;
        await h.social.signUp(pending.browserSecret, command(email), ip, context);
        expect(
          (
            await h.admin
              .selectFrom("users")
              .select("email_verified_at")
              .where("email_normalized", "=", email)
              .executeTakeFirstOrThrow()
          ).email_verified_at,
        ).toBeNull();
      });
      it("rejects absent age/guardian/legal consent, stale policy, and records approved guardian proof", async () => {
        const flow = await authorize(),
          pending = await flow.complete();
        if (pending.kind !== "signup") throw new Error("Expected signup");
        const base = command(flow.identity.email);
        for (const invalid of [
          { ...base, age_route: undefined },
          { ...base, consents: { terms: false, privacy: true } },
          { ...base, age_route: "guardian_consent" },
          { ...base, legal_documents: undefined },
          {
            ...base,
            legal_documents: {
              ...h.snapshot,
              terms: { ...h.snapshot.terms, content_sha256: "0".repeat(64) },
            },
          },
        ]) {
          await h.resetLimits();
          await expect(
            h.social.signUp(pending.browserSecret, invalid as unknown as typeof base, ip, context),
          ).rejects.toBeDefined();
        }
        expect(
          await h.admin
            .selectFrom("users")
            .select("id")
            .where("email_normalized", "=", base.email)
            .executeTakeFirst(),
        ).toBeUndefined();
        await h.resetLimits();
        const request = await h.guardianAuth.requestGuardianConsent(
          `guardian-${randomUUID()}@example.test`,
          ip,
          h.snapshot,
        );
        await h.guardianAuth.confirmGuardianConsent(h.guardianMessages.at(-1)!, h.snapshot);
        await h.resetLimits();
        const guardianCommand = {
          ...base,
          age_route: "guardian_consent" as const,
          guardian_consent: {
            completion_token: request.completion_token,
            request_id: request.request_id,
          },
        };
        await expect(
          h.social.signUp(pending.browserSecret, guardianCommand, ip, context),
        ).rejects.toMatchObject({ response: { code: "SOCIAL_AUTH_INVALID" } });
        await h.guardianAuth.signUp(
          { ...guardianCommand, password: "GuardianPath789" },
          ip,
          context,
        );
        const user = await h.admin
          .selectFrom("users")
          .select("id")
          .where("email_normalized", "=", base.email)
          .executeTakeFirstOrThrow();
        const row = await h.admin
          .selectFrom("guardian_consent_requests")
          .select(["user_id", "completion_token_hash", "consumed_at"])
          .where("id", "=", request.request_id)
          .executeTakeFirstOrThrow();
        expect(row.user_id).toBe(user.id);
        expect(row.completion_token_hash).toBeNull();
        expect(row.consumed_at).not.toBeNull();
        expect(
          await identities()
            .selectFrom("social_identities")
            .select("identity_id")
            .where("user_id", "=", user.id)
            .execute(),
        ).toHaveLength(0);
      });
      it("does not create a signup profile from a returning-user login without a prior identity link", async () => {
        h.mock.identity("google", {
          subject: randomUUID(),
          email: "not-registered@example.test",
          verified: true,
        });
        const before = await identities()
          .selectFrom("social_oauth_flows")
          .select("flow_id")
          .where("stage", "=", "signup")
          .execute();
        const start = await h.social.start("google", ip);
        const params = await h.mock.authorize(start.url);
        await expect(
          h.social.callback("google", params, start.browserSecret, undefined, ip),
        ).rejects.toMatchObject({ response: { code: "SOCIAL_SIGNUP_REQUIRED" } });
        expect(
          await identities()
            .selectFrom("social_oauth_flows")
            .select("flow_id")
            .where("stage", "=", "signup")
            .execute(),
        ).toHaveLength(before.length);
      });
      it.each([true, false])(
        "never auto-links an existing email (provider verified=%s)",
        async (verified) => {
          const original = await signup();
          await h.resetLimits();
          const attacker = await authorize("naver", { email: original.identity.email, verified }),
            pending = await attacker.complete();
          expect(pending.kind).toBe("signup");
          if (pending.kind !== "signup") throw new Error("Expected signup");
          await expect(
            h.social.signUp(pending.browserSecret, command(original.identity.email), ip, context),
          ).rejects.toBeDefined();
          expect(
            await identities()
              .selectFrom("social_identities")
              .selectAll()
              .where("user_id", "=", original.user.id)
              .execute(),
          ).toHaveLength(1);
          expect(
            await h.admin
              .selectFrom("users")
              .select("id")
              .where("email_normalized", "=", original.identity.email)
              .execute(),
          ).toHaveLength(1);
        },
      );
      it("requires the initiating session to link; refuses the last usable login and serializes unlink", async () => {
        const account = await linkedAccount();
        await h.resetLimits();
        h.mock.identity("naver", {
          subject: randomUUID(),
          email: "different@example.test",
          verified: false,
        });
        let start = await h.social.start("naver", ip, {
          session: account.authenticated,
          rawSession: account.session.sessionToken,
        });
        let parameters = await h.mock.authorize(start.url);
        await expect(
          h.social.callback(
            "naver",
            parameters,
            start.browserSecret,
            randomBytes(32).toString("base64url"),
            ip,
          ),
        ).rejects.toMatchObject({ response: { code: "SOCIAL_AUTH_INVALID" } });
        start = await h.social.start("naver", ip, {
          session: account.authenticated,
          rawSession: account.session.sessionToken,
        });
        parameters = await h.mock.authorize(start.url);
        expect(
          await h.social.callback(
            "naver",
            parameters,
            start.browserSecret,
            account.session.sessionToken,
            ip,
          ),
        ).toEqual({ kind: "linked" });
        const outcomes = await Promise.allSettled([
          h.social.unlink(account.authenticated, "google"),
          h.social.unlink(account.authenticated, "naver"),
        ]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
        const connection = await h.social.connections(account.authenticated);
        expect(connection.connections).toHaveLength(1);
        const remaining = connection.connections[0] as SocialProvider;
        await expect(h.social.unlink(account.authenticated, remaining)).rejects.toMatchObject({
          response: { code: "SOCIAL_LAST_LOGIN_METHOD" },
        });
        await h.admin
          .updateTable("users")
          .set({ password_hash: await hashPassword("OwnPassword789") })
          .where("id", "=", account.user.id)
          .execute();
        expect(await h.social.unlink(account.authenticated, remaining)).toEqual({ unlinked: true });
      });
      it("confirms the current password or a fresh login before linking (total audit I1-03)", async () => {
        const account = await linkedAccount();
        // 소셜로만 가입한 계정: 방금 로그인했으면 통과, 10분이 지났으면 다시 로그인하게 한다.
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, undefined),
        ).resolves.toBeUndefined();
        expect((await h.social.connections(account.authenticated)).password_required).toBe(false);
        await h.admin
          .updateTable("sessions")
          .set({ issued_at: new Date(Date.now() - 11 * 60_000) })
          .where("session_hash", "=", hashSessionSecret(account.session.sessionToken))
          .execute();
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, undefined),
        ).rejects.toMatchObject({ response: { code: "SOCIAL_RECENT_LOGIN_REQUIRED" } });
        // 비밀번호가 있는 계정: 현재 비밀번호가 맞아야 한다.
        await h.admin
          .updateTable("users")
          .set({ password_hash: await hashPassword("OwnPassword789") })
          .where("id", "=", account.user.id)
          .execute();
        expect((await h.social.connections(account.authenticated)).password_required).toBe(true);
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, "wrong-password-1"),
        ).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, undefined),
        ).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, "OwnPassword789"),
        ).resolves.toBeUndefined();
        // 2026-10-03 사용자 지적: 맞히면 앞서 틀린 횟수는 비운다. 4번 틀리고 맞힌 뒤 다시 틀려도 막히지 않는다.
        await h.resetLimits();
        for (let attempt = 0; attempt < 4; attempt += 1)
          await expect(
            h.social.confirmLinkIdentity(account.authenticated, "wrong-password-1"),
          ).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
        await h.social.confirmLinkIdentity(account.authenticated, "OwnPassword789");
        await expect(
          h.social.confirmLinkIdentity(account.authenticated, "wrong-password-1"),
        ).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
      });
      if (!maria)
        it("does not charge successful social logins against the per-address attempt budget", async () => {
          // 2026-10-03 사용자 지적: 성공한 연결·로그인은 시도 횟수에서 빼지 않는다(기본 1분 3회).
          await h.resetLimits();
          const subject = randomUUID();
          const first = await signup("kakao", { subject });
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const flow = await authorize("kakao", { subject, email: first.identity.email });
            expect((await flow.complete()).kind).toBe("session");
          }
        });
      it("rejects forged state and another browser; only one concurrent callback succeeds", async () => {
        const flow = await authorize();
        const forged = new URLSearchParams(flow.parameters);
        forged.set("state", randomBytes(32).toString("base64url"));
        const before = h.mock.tokenExchanges;
        await expect(
          h.social.callback("google", forged, flow.start.browserSecret, undefined, ip),
        ).rejects.toBeDefined();
        await expect(
          h.social.callback(
            "google",
            flow.parameters,
            randomBytes(32).toString("base64url"),
            undefined,
            ip,
          ),
        ).rejects.toBeDefined();
        expect(h.mock.tokenExchanges).toBe(before);
        const outcomes = await Promise.allSettled([flow.complete(), flow.complete()]);
        expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        expect(h.mock.tokenExchanges).toBe(before + 1);
      });
      for (const fault of [
        "nonce",
        "issuer",
        "audience",
        "signature",
        "expired",
        "pkce",
      ] as MockFault[])
        it(`rejects ${fault} verification failure and consumes the attempt`, async () => {
          h.mock.fault(fault);
          const flow = await authorize();
          await expect(flow.complete()).rejects.toMatchObject({
            response: { code: "SOCIAL_AUTH_INVALID" },
          });
          await expect(flow.complete()).rejects.toMatchObject({
            response: { code: "SOCIAL_AUTH_INVALID" },
          });
        });
      it("expires flow state and stores neither email nor proof as plaintext", async () => {
        const flow = await authorize();
        const rows = await identities()
          .selectFrom("social_oauth_flows")
          .selectAll()
          .where("consumed_at", "is", null)
          .execute();
        expect(JSON.stringify(rows)).not.toContain(flow.parameters.get("state"));
        expect(JSON.stringify(rows)).not.toContain(flow.identity.email);
        await identities()
          .updateTable("social_oauth_flows")
          .set({
            created_at: h.date(new Date(Date.now() - 600000)),
            expires_at: h.date(new Date(Date.now() - 1000)),
          })
          .where("consumed_at", "is", null)
          .execute();
        await expect(flow.complete()).rejects.toBeDefined();
      });
      it("caps concurrent sessions at five and rejects inactive accounts", async () => {
        const account = await signup();
        for (let i = 0; i < 5; i++) {
          await h.resetLimits();
          expect((await (await authorize("google", account.identity)).complete()).kind).toBe(
            "session",
          );
        }
        const active = await h.admin
          .selectFrom("sessions")
          .select("id")
          .where("user_id", "=", account.user.id)
          .where("revoked_at", "is", null)
          .execute();
        expect(active).toHaveLength(5);
        await expect(h.sessions.authenticate(account.session.sessionToken)).rejects.toBeDefined();
        await h.admin
          .updateTable("users")
          .set({ is_active: false })
          .where("id", "=", account.user.id)
          .execute();
        await h.resetLimits();
        await expect(
          (await authorize("google", account.identity)).complete(),
        ).rejects.toBeDefined();
      });
      it("has disabled defaults and requires real credentials/stable domains outside the mock", () => {
        const defaultConfig = new ConfigService(socialSettingsSchema.parse({}));
        const off = new SocialAuthProvider(defaultConfig);
        expect(off.enabled()).toEqual([]);
        expect(() => off.require("google")).toThrow();
        expect(
          () =>
            new SocialAuthProvider(
              new ConfigService({
                SOCIAL_AUTH_ENABLED: true,
                SOCIAL_GOOGLE_ENABLED: true,
                PUBLIC_APP_ORIGIN: "https://temporary.trycloudflare.com",
                PUBLIC_API_ORIGIN: "https://temporary.trycloudflare.com",
              }),
            ),
        ).toThrow();
      });
      it("removes social identifiers atomically when the account is deleted", async () => {
        const account = await linkedAccount();
        const password = "DeletionConfirm789";
        await h.admin
          .updateTable("users")
          .set({ password_hash: await hashPassword(password) })
          .where("id", "=", account.user.id)
          .execute();
        expect(
          await h.accounts.deleteAccount({
            userId: account.user.id,
            sessionId: account.authenticated.sessionId,
            currentPassword: password,
            confirmation: "탈퇴",
            clientIp: ip,
            ...context,
          }),
        ).toMatchObject({ account_deleted: true });
        expect(
          await identities()
            .selectFrom("social_identities")
            .selectAll()
            .where("user_id", "=", account.user.id)
            .execute(),
        ).toHaveLength(0);
        await expect(h.sessions.authenticate(account.session.sessionToken)).rejects.toBeDefined();
      });
      it("enforces identity FKs and denies the runtime account permission to rewrite ownership", async () => {
        const account = await signup(),
          db = socialDatabase(h.database, maria);
        await expect(
          db
            .updateTable("social_identities")
            .set({ subject: "changed-subject" })
            .where("user_id", "=", account.user.id)
            .execute(),
        ).rejects.toBeDefined();
        await expect(
          identities()
            .insertInto("social_identities")
            .values({
              identity_id: randomUUID(),
              provider: "google",
              issuer: h.social.provider.currentIssuer("google"),
              subject: randomUUID(),
              user_id: "9223372036854775806",
              created_at: h.date(new Date()),
              used_at: null,
            })
            .execute(),
        ).rejects.toBeDefined();
        const row = await h.admin
          .selectFrom("sessions")
          .select("session_hash")
          .where("session_hash", "=", hashSessionSecret(account.session.sessionToken))
          .executeTakeFirstOrThrow();
        expect(row.session_hash).toBeInstanceOf(Buffer);
      });
      if (!maria)
        it("exercises HTTP origin/CSRF guards, cookie attributes and consent validation", async () => {
          const app = h.http!;
          expect(
            (await app.inject({ method: "GET", url: "/api/v1/auth/social/providers" })).json(),
          ).toEqual({ providers: ["google", "naver", "kakao"] });
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/auth/social/google/start",
                headers: { origin: "https://wrong.invalid" },
              })
            ).statusCode,
          ).toBe(403);
          h.mock.identity("google", {
            subject: randomUUID(),
            email: `${randomUUID()}@example.test`,
            verified: true,
          });
          const start = await app.inject({
            method: "POST",
            url: "/api/v1/auth/social/google/start",
            headers: { origin: h.origin },
            payload: { intent: "signup_over_14" },
          });
          expect(start.statusCode).toBe(200);
          const startCookies = start.headers["set-cookie"] as string[];
          expect(startCookies[0]).toContain("Secure; HttpOnly; SameSite=Lax");
          const parameters = await h.mock.authorize(start.json().authorization_url);
          const callback = await app.inject({
            method: "GET",
            url: `/api/v1/auth/social/google/callback?${parameters}`,
            headers: { cookie: startCookies[0]!.split(";")[0]! },
          });
          expect(callback.statusCode).toBe(303);
          expect(callback.headers.location).toBe(`${h.origin}/sign-up?social=1`);
          const pending = (callback.headers["set-cookie"] as string[]).find((value) =>
            value.startsWith("__Host-classhub_social_signup="),
          )!;
          expect(pending).toContain("HttpOnly; SameSite=Strict");
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/auth/social/signup",
                headers: { cookie: pending.split(";")[0]!, origin: h.origin },
                payload: { email: "invalid" },
              })
            ).statusCode,
          ).toBe(400);
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/account/social/google/unlink",
                headers: { origin: h.origin },
              })
            ).statusCode,
          ).toBe(401);
          const linked = await linkedAccount();
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/account/social/google/unlink",
                headers: {
                  origin: h.origin,
                  cookie: `__Host-classhub_session=${linked.session.sessionToken}`,
                },
              })
            ).statusCode,
          ).toBe(403);
          // 총검수 I1-05: 이미 가입된 이메일이어도 일반 가입처럼 중립 응답을 주고, 그 가입 흐름은 끝낸다.
          const duplicate = await app.inject({
            method: "POST",
            url: "/api/v1/auth/social/signup",
            headers: { cookie: pending.split(";")[0]!, origin: h.origin },
            payload: { ...command(linked.identity.email), age_route: "over_14" },
          });
          expect(duplicate.statusCode, duplicate.body).toBe(201);
          expect(duplicate.json()).toEqual({ next_action: "LOGIN", request_accepted: true });
          expect(duplicate.body).not.toMatch(/EMAIL_ALREADY|이미 가입/u);
          const reused = await app.inject({
            method: "POST",
            url: "/api/v1/auth/social/signup",
            headers: { cookie: pending.split(";")[0]!, origin: h.origin },
            payload: { ...command(`${randomUUID()}@example.test`), age_route: "over_14" },
          });
          expect(reused.statusCode).toBeGreaterThanOrEqual(400);
          const bootstrap = await app.inject({
            method: "GET",
            url: "/api/v1/bootstrap",
            headers: { cookie: `__Host-classhub_session=${linked.session.sessionToken}` },
          });
          expect(bootstrap.statusCode).toBe(200);
          expect(JSON.stringify(bootstrap.json())).toContain("ENTER_INVITE_CODE");
        });
    },
  );
}
