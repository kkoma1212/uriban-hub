import { createMariaDbDatabase, NFC_PASSWORD_INPUT_VERSION, type DB } from "@classhub/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const passwordHasherMocks = vi.hoisted(() => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  passwordNeedsRehash: vi.fn(() => false),
}));
vi.mock("../password-hasher.js", () => passwordHasherMocks);

import { RateLimitServiceUnavailableException } from "../../common/rate-limit/rate-limit.errors.js";
import { DEFAULT_REQUEST_LIMIT_POLICY } from "../../common/rate-limit/request-limit-policy.js";
import {
  CsrfInvalidException,
  InvalidCredentialsException,
  SessionServiceUnavailableException,
  UnauthenticatedException,
} from "../auth.errors.js";
import { issueSessionSecrets } from "../session-crypto.js";
import { SessionService } from "../session.service.js";

type Step = { rows?: Record<string, unknown>[]; error?: unknown; affectedRows?: number };
const userId = "9007199254740993";
const sessionId = "9007199254740995";
const classId = "9007199254740997";
const now = new Date("2026-09-07T00:00:00.123Z");
const future = "2026-09-08 00:00:00.123999";
const past = "2026-09-06 00:00:00.123999";
const allowed = { allowed: true, count: 1, limit: 3, remaining: 2, retryAfterSeconds: 0 };
const databases: Array<ReturnType<typeof createMariaDbDatabase<DB>>> = [];

// Real MySQL compiler, session codec and guarded driver; only physical wire responses are fake.
function boundary(steps: Step[]) {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const release = vi.fn();
  const destroy = vi.fn();
  const state: { commitError?: unknown } = {};
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection(callback) {
        callback(null, {
          query(statement, parameters, reply) {
            statements.push({ sql: statement, parameters });
            if (!/^(?:select|insert|update|delete)\b/iu.test(statement)) {
              reply(statement === "COMMIT" ? state.commitError : null, {
                affectedRows: 0,
                insertId: 0,
              });
              return;
            }
            const step = steps.shift();
            if (step === undefined) return reply(new Error("Unexpected boundary query"), []);
            reply(step.error, step.rows ?? { affectedRows: step.affectedRows ?? 1, insertId: 0 });
          },
          release,
          destroy,
        });
      },
      end: (callback) => callback(null),
    }),
    {
      host: "mariadb.test.invalid",
      database: "synthetic_session",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic fixture",
    },
  );
  databases.push(database);
  const rateLimiter = {
    ensureAvailable: vi.fn().mockResolvedValue(undefined),
    getPolicy: vi.fn().mockResolvedValue({ ...DEFAULT_REQUEST_LIMIT_POLICY }),
    peek: vi.fn().mockResolvedValue(allowed),
    consume: vi.fn().mockResolvedValue(allowed),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const service = new SessionService(
    database,
    rateLimiter as never,
    { emailHmacKey: "synthetic-test-key-only", emailHmacKeyVersion: "test" } as never,
    { dialect: "mariadb" },
  );
  const queries = () =>
    statements.filter(({ sql }) => /^(select|insert|update|delete)\b/iu.test(sql));
  const commits = () => statements.filter(({ sql }) => sql === "COMMIT").length;
  return {
    service,
    database,
    steps,
    statements,
    queries,
    commits,
    rateLimiter,
    release,
    destroy,
    state,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    deleted_at: null,
    is_active: 1,
    locked_until: null,
    failed_login_attempts: 0,
    password_hash: "synthetic hash",
    password_input_version: NFC_PASSWORD_INPUT_VERSION,
    ...overrides,
  };
}
function account(overrides: Record<string, unknown> = {}) {
  return {
    is_active: 1,
    deleted_at: null,
    email_verified_at: past,
    signup_approved_at: null,
    current_class_id: classId,
    temporary_password_must_change: 0,
    temporary_password_expires_at: null,
    ...overrides,
  };
}
function session(csrfHash: Buffer = Buffer.alloc(32), overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    user_id: userId,
    expires_at: future,
    revoked_at: null,
    csrf_token_hash: csrfHash,
    ...overrides,
  };
}
const login = (service: SessionService) =>
  service.login(
    { email: " TEACHER@example.invalid ", password: "synthetic password" },
    "203.0.113.7",
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  passwordHasherMocks.hashPassword.mockReset().mockResolvedValue("synthetic dummy hash");
  passwordHasherMocks.verifyPassword.mockReset().mockResolvedValue(true);
  passwordHasherMocks.passwordNeedsRehash.mockReset().mockReturnValue(false);
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  vi.useRealTimers();
});

describe("MariaDB SessionService with shared PG policies", () => {
  it("upgrades a verified older hash in the same transaction as the session without changing input version", async () => {
    passwordHasherMocks.passwordNeedsRehash.mockReturnValue(true);
    passwordHasherMocks.hashPassword
      .mockResolvedValueOnce("dummy")
      .mockResolvedValueOnce("upgraded hash");
    const probe = boundary([
      { rows: [user()] },
      { rows: [user()] },
      { rows: [] },
      { rows: [] },
      {},
      {},
    ]);
    await expect(login(probe.service)).resolves.toMatchObject({ next_action: "BOOTSTRAP" });
    const updated = probe.queries().find(({ sql }) => sql.startsWith("update `users`"));
    expect(updated?.parameters).toContain("upgraded hash");
    expect(updated?.sql).not.toContain("password_input_version");
    expect(probe.commits()).toBe(1);
  });

  it("logs in with normalized rows, caps sessions at five and binds Date/Buffer/BIGINT unchanged", async () => {
    const currentIds = ["11", "12", "13", "14", "15", "16"];
    const probe = boundary([
      { rows: [user()] },
      { rows: [user()] },
      { rows: [{ temporary_password_must_change: 0, temporary_password_expires_at: null }] },
      { rows: currentIds.map((id) => ({ id })) },
      {},
      {},
      {},
    ]);
    const result = await login(probe.service);
    expect(result.next_action).toBe("BOOTSTRAP");
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 7 * 86400000));
    const queries = probe.queries();
    expect(queries[0]?.parameters).toEqual(["teacher@example.invalid"]);
    expect(queries[1]?.sql).toMatch(/for update$/u);
    expect(queries[3]?.sql).toContain("order by `issued_at` asc, `id` asc for update");
    expect(queries[4]?.parameters.slice(1)).toEqual(["11", "12"]);
    const inserted = queries.find(({ sql }) => sql.startsWith("insert into `sessions`"));
    expect(inserted?.parameters.filter(Buffer.isBuffer)).toHaveLength(2);
    expect(inserted?.parameters.filter((value) => value instanceof Date)).toHaveLength(2);
    expect(inserted?.parameters).toContain(userId);
    expect(JSON.stringify(inserted?.parameters)).not.toContain(result.sessionToken);
    expect(probe.commits()).toBe(1);
    expect(probe.steps).toHaveLength(0);
    expect(queries.every(({ sql }) => !/returning|on conflict|advisory/iu.test(sql))).toBe(true);
  });

  it("keeps the bounded two password-state verifications and never loops indefinitely", async () => {
    const probe = boundary([
      { rows: [user()] },
      { rows: [user({ password_hash: "changed once" })] },
      { rows: [user()] },
      { rows: [user({ password_hash: "changed twice" })] },
    ]);
    await expect(login(probe.service)).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(passwordHasherMocks.verifyPassword).toHaveBeenCalledTimes(2);
    expect(probe.queries()).toHaveLength(4);
    // 입장(주소·주소+이메일·공용) 3번 + 실패 기록(주소+이메일·주소 실패·계정 1시간·계정 잠금 기준) 4번.
    expect(probe.rateLimiter.consume).toHaveBeenCalledTimes(7);
  });

  it("allows correct credentials through a legacy failure lock and preserves millisecond session expiry", async () => {
    const locked = boundary([
      { rows: [user({ locked_until: future })] },
      { rows: [user({ locked_until: future })] },
      { rows: [] },
      { rows: [] },
      {},
      {},
    ]);
    await expect(login(locked.service)).resolves.toMatchObject({ next_action: "BOOTSTRAP" });
    expect(passwordHasherMocks.verifyPassword).toHaveBeenCalledOnce();
    const expired = boundary([
      { rows: [session(Buffer.alloc(32), { expires_at: "2026-09-07 00:00:00.123999" })] },
    ]);
    await expect(
      expired.service.authenticate(issueSessionSecrets().sessionToken),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(expired.queries()).toHaveLength(1);
  });

  it("fails closed before account queries or mutation when admission Redis is unavailable", async () => {
    passwordHasherMocks.verifyPassword.mockResolvedValue(false);
    const probe = boundary([]);
    const failure = new RateLimitServiceUnavailableException(new Error("synthetic Redis failure"));
    probe.rateLimiter.consume.mockRejectedValue(failure);
    await expect(login(probe.service)).rejects.toBe(failure);
    expect(probe.queries()).toHaveLength(0);
    expect(probe.commits()).toBe(0);
    expect(passwordHasherMocks.verifyPassword).not.toHaveBeenCalled();
    expect(probe.steps).toHaveLength(0);
  });

  it("rejects expired numeric-true temporary passwords without incrementing password failures", async () => {
    const probe = boundary([
      { rows: [user()] },
      { rows: [user()] },
      { rows: [{ temporary_password_must_change: 1, temporary_password_expires_at: past }] },
    ]);
    await expect(login(probe.service)).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(probe.queries().some(({ sql }) => /^(update|insert)/u.test(sql))).toBe(false);
    // 입장(주소·주소+이메일·공용) 3번 + 실패 기록(주소+이메일·주소 실패·계정 1시간·계정 잠금 기준) 4번.
    expect(probe.rateLimiter.consume).toHaveBeenCalledTimes(7);
  });

  it("authenticates large IDs with CSRF and safe Date output; a mismatched token remains denied", async () => {
    const secrets = issueSessionSecrets();
    // 세션·계정을 잠금 없는 조회 한 번으로 읽는다(요청마다 도는 경로 — 2026-09-28 동시 접속 개선).
    const probe = boundary([
      { rows: [{ ...session(secrets.csrfTokenHash), ...account() }] },
      { rows: [{ ...session(secrets.csrfTokenHash), ...account() }] },
    ]);
    await expect(
      probe.service.authenticateWithCsrf(
        secrets.sessionToken,
        secrets.csrfToken,
        secrets.csrfToken,
      ),
    ).resolves.toEqual({
      userId,
      sessionId,
      currentClassId: classId,
      expiresAt: new Date("2026-09-08T00:00:00.123Z"),
    });
    await expect(
      probe.service.authenticateWithCsrf(
        secrets.sessionToken,
        secrets.csrfToken,
        issueSessionSecrets().csrfToken,
      ),
    ).rejects.toBeInstanceOf(CsrfInvalidException);
    expect(probe.queries()).toHaveLength(2);
    expect(probe.queries()[0]?.sql).not.toMatch(/for update/u);
    expect(probe.commits()).toBe(0);
  });

  it("revokes an expired temporary-password session with one idempotent update before rejecting", async () => {
    const probe = boundary([
      {
        rows: [
          {
            ...session(),
            ...account({ temporary_password_must_change: 1, temporary_password_expires_at: past }),
          },
        ],
      },
      {},
    ]);
    await expect(
      probe.service.authenticate(issueSessionSecrets().sessionToken),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
    const revoke = probe.queries().at(-1);
    expect(revoke?.sql).toMatch(/^update/u);
    expect(revoke?.sql).toMatch(/revoked_at` is null/u);
    expect(revoke?.parameters).toEqual([now, sessionId]);
  });

  it("fails closed on malformed persisted security data and rolls back", async () => {
    const probe = boundary([{ rows: [session(Buffer.alloc(31))] }]);
    await expect(
      probe.service.authenticate(issueSessionSecrets().sessionToken),
    ).rejects.toBeInstanceOf(SessionServiceUnavailableException);
    expect(probe.commits()).toBe(0);
    expect(probe.queries()).toHaveLength(1);
  });

  it("releases CSRF preflight locks before Redis and revalidates revocation afterward", async () => {
    const probe = boundary([
      { rows: [session()] },
      { rows: [account()] },
      { rows: [session(Buffer.alloc(32), { revoked_at: past })] },
    ]);
    probe.rateLimiter.consume.mockImplementation(async () => {
      expect(probe.commits()).toBe(1);
      expect(probe.release).toHaveBeenCalledOnce();
      return allowed;
    });
    await expect(
      probe.service.refreshCsrf(issueSessionSecrets().sessionToken),
    ).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(probe.queries()).toHaveLength(3);
    expect(probe.commits()).toBe(2);
  });

  it("rotates a CSRF hash only after the second locked account check", async () => {
    const probe = boundary([
      { rows: [session()] },
      { rows: [account()] },
      { rows: [session()] },
      { rows: [account()] },
      {},
    ]);
    const result = await probe.service.refreshCsrf(issueSessionSecrets().sessionToken);
    expect(result.expiresAt).toBeInstanceOf(Date);
    const parameters = probe.queries().at(-1)?.parameters;
    expect(parameters?.[0]).toBeInstanceOf(Buffer);
    expect(parameters?.[1]).toBe(sessionId);
    expect(parameters).not.toContain(result.csrfToken);
  });

  it("uses the database microsecond clock for audit lookup, never the Node clock", async () => {
    const probe = boundary([{ rows: [{ current_class_id: classId, user_id: userId }] }]);
    vi.setSystemTime(new Date("2200-01-01T00:00:00Z"));
    await expect(
      probe.service.resolveSecurityAuditIdentity(issueSessionSecrets().sessionToken),
    ).resolves.toEqual({ currentClassId: classId, userId });
    expect(probe.queries()[0]?.sql.match(/CURRENT_TIMESTAMP\(6\)/gu)).toHaveLength(2);
    expect(probe.queries()[0]?.parameters.some((value) => value instanceof Date)).toBe(false);
  });

  it("keeps logout's pre-revocation identity and has a single idempotent winner without RETURNING", async () => {
    const probe = boundary([
      { rows: [{ id: sessionId, user_id: userId, current_class_id: classId, was_active: 1 }] },
      {},
      { rows: [] },
    ]);
    vi.setSystemTime(new Date("2200-01-01T00:00:00Z"));
    const token = issueSessionSecrets().sessionToken;
    await expect(probe.service.logout(token)).resolves.toEqual({ currentClassId: classId, userId });
    await expect(probe.service.logout(token)).resolves.toBeNull();
    expect(probe.queries().map(({ sql }) => sql.split(" ")[0])).toEqual([
      "select",
      "update",
      "select",
    ]);
    expect(probe.queries()[0]?.sql).toMatch(/for update$/u);
    expect(probe.queries()[1]?.sql).toContain("`revoked_at` is null");
    expect(probe.queries().some(({ sql }) => /returning/iu.test(sql))).toBe(false);
  });

  it("starts a fresh transaction for the ACL-only enrichment fallback after full rollback", async () => {
    const probe = boundary([
      { error: { errno: 1142, sqlState: "42000", message: "private SQL" } },
      { rows: [{ id: sessionId, user_id: userId, current_class_id: null, was_active: 1 }] },
      {},
    ]);
    await expect(probe.service.logout(issueSessionSecrets().sessionToken)).resolves.toEqual({
      currentClassId: null,
      userId,
    });
    expect(probe.statements.filter(({ sql }) => sql.startsWith("START TRANSACTION"))).toHaveLength(
      2,
    );
    expect(probe.queries()[1]?.sql).not.toContain("class_members");
    expect(probe.commits()).toBe(1);
  });

  it("never falls back when revocation itself lacks permission", async () => {
    const probe = boundary([
      { rows: [{ id: sessionId, user_id: userId, current_class_id: classId, was_active: 1 }] },
      { error: { errno: 1142, sqlState: "42000", message: "private SQL" } },
    ]);
    await expect(probe.service.logout(issueSessionSecrets().sessionToken)).rejects.toBeInstanceOf(
      SessionServiceUnavailableException,
    );
    expect(probe.queries()).toHaveLength(2);
    expect(probe.commits()).toBe(0);
  });

  it("revokes an expired session without publishing a logout identity", async () => {
    const probe = boundary([
      { rows: [{ id: sessionId, user_id: userId, current_class_id: classId, was_active: 0 }] },
      {},
    ]);
    await expect(probe.service.logout(issueSessionSecrets().sessionToken)).resolves.toBeNull();
    expect(probe.queries().at(-1)?.sql).toContain("update `sessions`");
    expect(probe.commits()).toBe(1);
  });

  it.each([1213, 1205, 9999])(
    "never retries native error %i or leaks its private details",
    async (errno) => {
      const probe = boundary([{ error: { errno, sqlState: "40001", message: "private DSN" } }]);
      let error: unknown;
      try {
        await probe.service.logout(issueSessionSecrets().sessionToken);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SessionServiceUnavailableException);
      expect(JSON.stringify(error)).not.toContain("private");
      expect(probe.queries()).toHaveLength(1);
      expect(probe.commits()).toBe(0);
    },
  );

  it("discards an uncertain commit and never retries logout", async () => {
    const probe = boundary([
      { rows: [{ id: sessionId, user_id: userId, current_class_id: classId, was_active: 1 }] },
      {},
    ]);
    probe.state.commitError = new Error("private connection loss");
    await expect(probe.service.logout(issueSessionSecrets().sessionToken)).rejects.toBeInstanceOf(
      SessionServiceUnavailableException,
    );
    expect(probe.queries()).toHaveLength(2);
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(probe.release).not.toHaveBeenCalled();
  });

  it("does not install a session codec on the shared MariaDB handle", async () => {
    const probe = boundary([{ rows: [{ is_active: 1, locked_until: future }] }]);
    const row = await probe.database
      .selectFrom("users")
      .select(["is_active", "locked_until"])
      .executeTakeFirst();
    expect(row).toEqual({ is_active: 1, locked_until: future });
  });
});
