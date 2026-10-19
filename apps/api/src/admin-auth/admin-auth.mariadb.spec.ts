import type { DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { encryptTotpSecret, totpCodeAt } from "./admin-auth.crypto.js";
import { adminAuthDatabase } from "./admin-auth.database.js";
import { AdminAuthService } from "./admin-auth.service.js";
import type { AuthenticatedAdminSession } from "./admin-auth.types.js";

const passwords = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  hash: vi.fn(async () => "synthetic-hash-only"),
}));
vi.mock("../auth/password-hasher.js", () => ({
  verifyPassword: passwords.verify,
  hashPassword: passwords.hash,
}));

const accountId = "9007199254970001",
  sessionId = "9007199254970002",
  factorId = "9007199254970003";
const now = new Date("2026-09-07T15:10:22.123Z"),
  nativeNow = "2026-09-07 15:10:22.123000";
const key = Buffer.alloc(32, 9).toString("base64url"),
  secret = Buffer.alloc(20, 7);
const encrypted = encryptTotpSecret(secret, key, "synthetic_v1", accountId);
const rawToken = Buffer.alloc(32, 11).toString("base64url"),
  csrfHash = Buffer.alloc(32, 12);
const currentStep = BigInt(Math.floor(now.getTime() / 30000));
const config = new ConfigService<AppEnvironment, true>({
  DATABASE_ENGINE: "mariadb",
  ADMIN_MFA_ENCRYPTION_KEY: key,
  ADMIN_MFA_KEY_VERSION: "synthetic_v1",
  EMAIL_HMAC_KEY: "synthetic-admin-hmac-key-only",
  EMAIL_HMAC_KEY_VERSION: "synthetic_v1",
});
const metadata = {
  clientIp: "192.0.2.41",
  requestId: "11111111-1111-4111-8111-111111111111",
  userAgent: "synthetic QA",
};
const dbTime = (offset: number) =>
  new Date(now.getTime() + offset).toISOString().replace("T", " ").replace("Z", "000");
type Row = Record<string, unknown>;
const account = (extra: Row = {}) => ({
  id: accountId,
  email_normalized: "admin@example.invalid",
  display_name: "Admin",
  password_hash: "synthetic-stored-hash",
  password_input_version: "nfc_v1",
  status: "active",
  locked_until: null,
  failed_login_attempts: 0,
  ...extra,
});
const factor = (extra: Row = {}) => ({
  id: factorId,
  admin_account_id: accountId,
  key_version: "synthetic_v1",
  status: "active",
  secret_auth_tag: encrypted.authTag,
  secret_ciphertext: encrypted.ciphertext,
  secret_iv: encrypted.iv,
  created_at: dbTime(-600000),
  activated_at: dbTime(-500000),
  revoked_at: null,
  last_accepted_timestep: String(currentStep - 1n),
  ...extra,
});
const challenge = (extra: Row = {}) => ({
  id: "9007199254970004",
  admin_account_id: accountId,
  expires_at: dbTime(300000),
  created_at: dbTime(-60000),
  consumed_at: null,
  failed_attempts: 0,
  purpose: "verify_totp",
  challenge_hash: Buffer.alloc(32, 10),
  ...extra,
});
const storedSession = (extra: Row = {}) => ({
  id: sessionId,
  admin_account_id: accountId,
  absolute_expires_at: dbTime(1200000),
  issued_at: dbTime(-600000),
  last_seen_at: dbTime(-60000),
  mfa_verified_at: dbTime(-600000),
  reauthenticated_at: null,
  revoked_at: null,
  session_hash: Buffer.alloc(32, 13),
  csrf_token_hash: csrfHash,
  ...extra,
});
const session: AuthenticatedAdminSession = {
  absoluteExpiresAt: new Date(now.getTime() + 1800000),
  adminAccountId: accountId,
  csrfTokenHash: csrfHash,
  displayName: "Admin",
  email: "admin@example.invalid",
  issuedAt: now,
  lastSeenAt: now,
  mfaVerifiedAt: now,
  reauthenticatedAt: now,
  roles: ["super_admin"],
  sessionId,
};
type Step = { sql: RegExp; rows?: Row[]; insertId?: bigint; error?: Error };
const select = (table: string, rows: Row[] = []): Step => ({
  sql: new RegExp("^select .* from `" + table + "`", "u"),
  rows,
});
const update = (table: string): Step => ({ sql: new RegExp("^update `" + table + "`", "u") });
const insert = (table: string, insertId?: bigint): Step => ({
  sql: new RegExp("^insert into `" + table + "`", "u"),
  ...(insertId === undefined ? {} : { insertId }),
});
const audit = (): Step => insert("admin_auth_audit_logs");
const roles = (): Step => select("admin_account_roles", [{ role: "super_admin" }]);
const resources: { database: Kysely<DB>; steps: Step[] }[] = [];

// Actual MySQL compilation/codecs and synthetic native-shaped results. Password hashing
// is mocked; TOTP/AES-GCM use fixed synthetic inputs. No server or real account is contacted.
function harness(steps: Step[]) {
  const queries: CompiledQuery[] = [],
    events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          queries.push(query);
          const step = steps.shift();
          expect(step, "unexpected SQL").toBeDefined();
          expect(query.sql).toMatch(step!.sql);
          expect(query.sql).not.toMatch(/\breturning\b|::|\bnow\(/iu);
          expect(query.parameters.some((value) => value instanceof Date)).toBe(false);
          if (step!.error) throw step!.error;
          return {
            rows: step!.rows ?? [],
            numAffectedRows: 1n,
            ...(step!.insertId === undefined ? {} : { insertId: step!.insertId }),
          } as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
    override async beginTransaction() {
      events.push("begin");
    }
    override async commitTransaction() {
      events.push("commit");
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const limiter = {
    consume: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 })),
    peek: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 })),
    clear: vi.fn(async () => undefined),
    getPolicy: vi.fn(async () => ({ max_attempts: 3, cooldown_seconds: 60 })),
  };
  resources.push({ database, steps });
  return {
    database,
    queries,
    events,
    limiter,
    service: new AdminAuthService(database, limiter as never, config),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  passwords.verify.mockResolvedValue(true);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const item of resources.splice(0)) {
    expect(item.steps).toEqual([]);
    await item.database.destroy();
  }
  vi.clearAllMocks();
});

function auditIsPrivate(h: ReturnType<typeof harness>, action: string) {
  const query = h.queries.find(
    (q) => q.sql.startsWith("insert into `admin_auth_audit_logs`") && q.parameters[0] === action,
  )!;
  expect(query).toBeDefined();
  expect(query.sql).not.toContain("created_at");
  expect(query.parameters).not.toContain(metadata.clientIp);
  expect(query.parameters).not.toContain("admin@example.invalid");
  expect(query.parameters).not.toContain(rawToken);
  expect(query.parameters).not.toContain(totpCodeAt(secret, now.getTime()));
}

describe("MariaDB administrator authentication persistence", () => {
  it("preserves the PG default and rejects an unknown engine", () => {
    const h = harness([]);
    expect(adminAuthDatabase(h.database, new ConfigService<AppEnvironment, true>({}))).toEqual({
      database: h.database,
      engine: "postgres",
    });
    expect(() =>
      adminAuthDatabase(
        h.database,
        new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "unknown" }),
      ),
    ).toThrow("Unsupported database engine");
  });
  it.each(["active", "pending_mfa"])(
    "begins %s login with private audit and unchanged challenge/app-clock semantics",
    async (status) => {
      const h = harness([
        select("admin_accounts", [account({ status })]),
        select("admin_accounts", [account({ status })]),
        update("admin_accounts"),
        update("admin_login_challenges"),
        select("admin_mfa_factors", status === "active" ? [factor()] : []),
        ...(status === "active" ? [] : [insert("admin_mfa_factors")]),
        insert("admin_login_challenges"),
        audit(),
      ]);
      const result = await h.service.beginLogin(
        "admin@example.invalid",
        "synthetic supplied password",
        metadata,
      );
      expect(result.nextStep).toBe(status === "active" ? "verify_totp" : "enroll_totp");
      expect(result.challengeExpiresAt).toEqual(new Date(now.getTime() + 300000));
      expect(result.setup === undefined).toBe(status === "active");
      expect(h.queries[1]!.sql.endsWith("for update")).toBe(true);
      expect(h.queries[4]!.sql.endsWith("for update")).toBe(true);
      const challengeInsert = h.queries.find((q) =>
        q.sql.startsWith("insert into `admin_login_challenges`"),
      )!;
      expect(Buffer.isBuffer(challengeInsert.parameters[1])).toBe(true);
      expect(challengeInsert.parameters).toContain(dbTime(300000));
      auditIsPrivate(h, "admin.auth.password_verified");
      expect(h.events).toEqual(["begin", "commit"]);
    },
  );
  it("records the third password failure without a new account lock (total audit C1-03)", async () => {
    passwords.verify.mockResolvedValue(false);
    const h = harness([
      select("admin_accounts", [account()]),
      select("admin_accounts", [account({ failed_login_attempts: 2 })]),
      update("admin_accounts"),
      audit(),
    ]);
    await expect(
      h.service.beginLogin("admin@example.invalid", "wrong synthetic password", metadata),
    ).rejects.toMatchObject({ status: 401 });
    // 누구나 관리자를 잠그지 못하게 DB 잠금(locked_until)은 새로 걸지 않는다. 대기는 Redis 출처·계정 한도가 맡는다.
    expect(h.queries[2]!.parameters).toEqual([3, null, nativeNow, accountId]);
    expect(h.events).toEqual(["begin", "commit"]);
    auditIsPrivate(h, "admin.auth.login_failed");
  });
  it.each([-1, 0])(
    "starts a fresh failure window after a lock expires (offset %s)",
    async (offset) => {
      passwords.verify.mockResolvedValue(false);
      const expired = account({ failed_login_attempts: 5, locked_until: dbTime(offset) });
      const h = harness([
        select("admin_accounts", [expired]),
        select("admin_accounts", [expired]),
        update("admin_accounts"),
        audit(),
      ]);
      await expect(
        h.service.beginLogin("admin@example.invalid", "wrong synthetic password", metadata),
      ).rejects.toMatchObject({ status: 401 });
      expect(h.queries[2]!.parameters).toEqual([1, null, nativeNow, accountId]);
      expect(h.events).toEqual(["begin", "commit"]);
    },
  );
  it("keeps a future account lock even when the supplied password is correct", async () => {
    const locked = account({ failed_login_attempts: 5, locked_until: dbTime(300000) });
    const h = harness([
      select("admin_accounts", [locked]),
      select("admin_accounts", [locked]),
      audit(),
    ]);
    await expect(
      h.service.beginLogin("admin@example.invalid", "synthetic supplied password", metadata),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.queries.some((query) => query.sql.startsWith("update"))).toBe(false);
    expect(h.events).toEqual(["begin", "commit"]);
  });
  it.each([false, true])(
    "completes TOTP with Buffer ciphertext, native session ID and enrollment=%s",
    async (enrolled) => {
      const h = harness([
        // 총검수 C1-04: 계정 기준 2단계 오답 한도를 보려고 트랜잭션 전에 계정을 먼저 찾는다.
        select("admin_login_challenges", [challenge()]),
        select("admin_login_challenges", [
          challenge({ purpose: enrolled ? "enroll_totp" : "verify_totp" }),
        ]),
        select("admin_accounts", [account({ status: enrolled ? "pending_mfa" : "active" })]),
        select("admin_mfa_factors", [
          factor({
            status: enrolled ? "pending" : "active",
            activated_at: enrolled ? null : dbTime(-500000),
          }),
        ]),
        update("admin_mfa_factors"),
        update("admin_login_challenges"),
        update("admin_accounts"),
        insert("admin_sessions", BigInt(sessionId)),
        roles(),
        ...(enrolled ? [audit()] : []),
        audit(),
      ]);
      const result = await h.service.completeTotp(
        rawToken,
        totpCodeAt(secret, now.getTime()),
        metadata,
      );
      expect(result.session.sessionId).toBe(sessionId);
      expect(result.session.adminAccountId).toBe(accountId);
      expect(result.session.issuedAt).toEqual(now);
      expect(result.session.roles).toEqual(["super_admin"]);
      expect(Buffer.isBuffer(result.session.csrfTokenHash)).toBe(true);
      // 첫 조회(계정 찾기)는 잠그지 않는 읽기, 트랜잭션 안의 세 조회는 잠금.
      expect(h.queries[0]!.sql.endsWith("for update")).toBe(false);
      expect(h.queries.slice(1, 4).every((q) => q.sql.endsWith("for update"))).toBe(true);
      expect(h.queries[4]!.parameters).toContain(String(currentStep));
      const sessionInsert = h.queries[7]!;
      expect(sessionInsert.parameters.filter((value) => value === nativeNow)).toHaveLength(3);
      expect(result.session.reauthenticatedAt).toBeNull();
      expect(sessionInsert.parameters.filter((value) => Buffer.isBuffer(value))).toHaveLength(2);
      auditIsPrivate(h, "admin.auth.login_succeeded");
      expect(h.events).toEqual(["begin", "commit"]);
    },
  );
  it("rejects reused TOTP while committing challenge attempt consumption and no new session", async () => {
    const h = harness([
      select("admin_login_challenges", [challenge()]),
      select("admin_login_challenges", [challenge({ failed_attempts: 4 })]),
      select("admin_accounts", [account()]),
      select("admin_mfa_factors", [factor({ last_accepted_timestep: String(currentStep) })]),
      update("admin_login_challenges"),
      audit(),
    ]);
    await expect(
      h.service.completeTotp(rawToken, totpCodeAt(secret, now.getTime()), metadata),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.queries[4]!.parameters).toEqual([5, nativeNow, "9007199254970004"]);
    expect(h.limiter.consume).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/^admin-mfa-failure:account:/u) }),
    );
    expect(h.events).toEqual(["begin", "commit"]);
    auditIsPrivate(h, "admin.auth.login_failed");
  });
  it.each([false, true])(
    "authenticates native session dates and commits idle expiry=%s",
    async (expired) => {
      const h = harness([
        select("admin_sessions", [
          storedSession({ last_seen_at: dbTime(expired ? -1800000 : -60000) }),
        ]),
        select("admin_accounts", [account()]),
        update("admin_sessions"),
        ...(expired ? [audit()] : [roles()]),
      ]);
      if (expired) {
        await expect(h.service.authenticate(rawToken, metadata)).rejects.toMatchObject({
          status: 401,
        });
        auditIsPrivate(h, "admin.auth.session_expired");
      } else {
        const result = await h.service.authenticate(rawToken, metadata);
        expect(result).toMatchObject({
          sessionId,
          adminAccountId: accountId,
          lastSeenAt: now,
          reauthenticatedAt: null,
        });
        expect(result.csrfTokenHash).toBe(csrfHash);
        expect(result.absoluteExpiresAt).toBeInstanceOf(Date);
      }
      expect(h.queries[2]!.parameters).toEqual([nativeNow, sessionId]);
      expect(h.events).toEqual(["begin", "commit"]);
    },
  );
  it("keeps account-factor-session lock order and app time for step-up", async () => {
    const h = harness([
      select("admin_accounts", [account()]),
      select("admin_mfa_factors", [factor()]),
      select("admin_sessions", [storedSession()]),
      update("admin_mfa_factors"),
      update("admin_sessions"),
      audit(),
    ]);
    const result = await h.service.stepUp(
      session,
      "synthetic supplied password",
      totpCodeAt(secret, now.getTime()),
      metadata,
    );
    expect(result).toEqual({
      reauthenticatedAt: now,
      validUntil: new Date(now.getTime() + 300000),
    });
    expect(h.queries.slice(0, 3).every((q) => q.sql.endsWith("for update"))).toBe(true);
    expect(h.queries[4]!.parameters).toEqual([nativeNow, sessionId]);
    auditIsPrivate(h, "admin.auth.step_up_succeeded");
  });
  it.each([
    { revoked_at: dbTime(-1) },
    { admin_account_id: "9007199254970999" },
    { absolute_expires_at: dbTime(0) },
  ])("rejects a revoked, foreign or expired locked session before hashing: %j", async (changed) => {
    const h = harness([
      select("admin_accounts", [account()]),
      select("admin_mfa_factors", [factor()]),
      select("admin_sessions", [storedSession(changed)]),
    ]);
    await expect(
      h.service.stepUp(session, "synthetic", totpCodeAt(secret, now.getTime()), metadata),
    ).rejects.toMatchObject({ status: 401 });
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(h.events).toEqual(["begin", "rollback"]);
  });
  it("checks session expiry again after password work while keeping MFA unconsumed", async () => {
    const h = harness([
      select("admin_accounts", [account()]),
      select("admin_mfa_factors", [factor()]),
      select("admin_sessions", [storedSession({ absolute_expires_at: dbTime(1000) })]),
    ]);
    passwords.verify.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 1000));
      return true;
    });
    await expect(
      h.service.stepUp(session, "synthetic", totpCodeAt(secret, now.getTime()), metadata),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.queries).toHaveLength(3);
    expect(h.events).toEqual(["begin", "rollback"]);
  });
  it.each([false, true])(
    "accepts a 12-character administrator password with session exclusion and audit rollback=%s",
    async (failed) => {
      const failure = Object.assign(new Error("synthetic audit failure"), {
        errno: 4025,
        sqlState: "23000",
      });
      const h = harness([
        select("admin_accounts", [account()]),
        select("admin_accounts", [account()]),
        update("admin_accounts"),
        update("admin_sessions"),
        { ...insert("admin_operation_audit_logs"), ...(failed ? { error: failure } : {}) },
      ]);
      const operation = h.service.changePassword(session, "Cedar!7@Maple", metadata);
      if (failed) await expect(operation).rejects.toBe(failure);
      else await expect(operation).resolves.toEqual({ password_changed: true });
      expect(h.queries[2]!.parameters).toEqual([
        "synthetic-hash-only",
        "nfc_v1",
        nativeNow,
        nativeNow,
        accountId,
      ]);
      expect(h.queries[3]!.parameters).toEqual([nativeNow, accountId, sessionId]);
      expect(h.queries[3]!.sql).toContain("`id` != ?");
      expect(h.queries[4]!.parameters).toEqual([
        "admin.account.password_changed",
        accountId,
        '{"other_sessions_revoked":true}',
        null,
        null,
        metadata.requestId,
        accountId,
        "admin_account",
      ]);
      expect(h.events).toEqual(["begin", failed ? "rollback" : "commit"]);
    },
  );
  it("manually renews only expiry and last-seen, keeping MFA proof and emitting no false authentication audit", async () => {
    const h = harness([
      select("admin_sessions", [storedSession()]),
      select("admin_accounts", [account()]),
      update("admin_sessions"),
    ]);
    const result = await h.service.renew(session, metadata);
    expect(result.absoluteExpiresAt).toEqual(new Date(now.getTime() + 1800000));
    expect(result.mfaVerifiedAt).toBe(session.mfaVerifiedAt);
    expect(result.reauthenticatedAt).toBe(session.reauthenticatedAt);
    expect(h.queries[0]!.sql).toContain("for update");
    expect(h.queries[2]!.parameters).toEqual([dbTime(1800000), nativeNow, sessionId]);
    expect(h.queries[2]!.sql).not.toContain("reauthenticated_at");
    expect(h.queries.some((q) => q.sql.includes("audit"))).toBe(false);
    expect(h.events).toEqual(["begin", "commit"]);
  });
  it("never renews past twelve hours after MFA (I1-12)", async () => {
    const nearCap = harness([
      select("admin_sessions", [
        storedSession({ mfa_verified_at: dbTime(-12 * 3600000 + 600000) }),
      ]),
      select("admin_accounts", [account()]),
      update("admin_sessions"),
    ]);
    const capped = await nearCap.service.renew(session, metadata);
    // 남은 10분까지만 연장하고 30분을 새로 주지 않는다.
    expect(capped.absoluteExpiresAt).toEqual(new Date(now.getTime() + 600000));
    const pastCap = harness([
      select("admin_sessions", [storedSession({ mfa_verified_at: dbTime(-12 * 3600000) })]),
      select("admin_accounts", [account()]),
      update("admin_sessions"),
      audit(),
    ]);
    await expect(pastCap.service.renew(session, metadata)).rejects.toMatchObject({ status: 401 });
    expect(pastCap.queries[2]!.sql).toContain("revoked_at");
    auditIsPrivate(pastCap, "admin.auth.session_expired");
  });
  it("refuses revival at the exact thirty-minute boundary and commits expiry audit", async () => {
    const h = harness([
      select("admin_sessions", [storedSession({ absolute_expires_at: nativeNow })]),
      select("admin_accounts", [account()]),
      update("admin_sessions"),
      audit(),
    ]);
    await expect(h.service.renew(session, metadata)).rejects.toMatchObject({ status: 401 });
    expect(h.queries[2]!.sql).toContain("revoked_at");
    expect(h.queries[2]!.sql).not.toContain("absolute_expires_at");
    auditIsPrivate(h, "admin.auth.session_expired");
    expect(h.events).toEqual(["begin", "commit"]);
  });
  it("caps a legacy eight-hour session once without extending it on ordinary authenticated reads", async () => {
    const h = harness([
      select("admin_sessions", [storedSession({ absolute_expires_at: dbTime(8 * 3600000) })]),
      select("admin_accounts", [account()]),
      update("admin_sessions"),
      roles(),
    ]);
    const result = await h.service.authenticate(rawToken, metadata);
    expect(result.absoluteExpiresAt).toEqual(new Date(now.getTime() + 1740000));
    expect(h.queries[2]!.parameters).toEqual([nativeNow, dbTime(1740000), sessionId]);
  });
});
