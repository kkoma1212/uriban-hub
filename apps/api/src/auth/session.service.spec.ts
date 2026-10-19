import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const passwordHasherMocks = vi.hoisted(() => ({
  hashPassword: vi.fn<(password: string) => Promise<string>>(),
  verifyPassword: vi.fn<(password: string, encodedHash: string) => Promise<boolean>>(),
  passwordNeedsRehash: vi.fn(() => false),
}));

vi.mock("./password-hasher.js", () => passwordHasherMocks);

import {
  RateLimitedException,
  RateLimitServiceUnavailableException,
} from "../common/rate-limit/rate-limit.errors.js";
import { DATABASE } from "../database/database.module.js";
import { SessionServiceUnavailableException } from "./auth.errors.js";
import { issueSessionSecrets } from "./session-crypto.js";
import {
  notifySecurityAuditIdentity,
  resolveCurrentClassId,
  SessionService,
} from "./session.service.js";
import { AUTH_CONFIG, AUTH_RATE_LIMITER } from "./auth.tokens.js";

@Module({
  providers: [
    SessionService,
    { provide: DATABASE, useValue: {} },
    { provide: AUTH_RATE_LIMITER, useValue: {} },
    { provide: AUTH_CONFIG, useValue: {} },
  ],
})
class SessionServiceTestModule {}

function createService(): SessionService {
  return new SessionService({} as never, {} as never, {} as never);
}

function createLogoutService(wasActive: boolean): {
  service: SessionService;
  updateTable: ReturnType<typeof vi.fn>;
} {
  const updateQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  updateQuery.set = vi.fn(() => updateQuery);
  updateQuery.where = vi.fn(() => updateQuery);
  updateQuery.returning = vi.fn(() => updateQuery);
  updateQuery.executeTakeFirst = vi.fn().mockResolvedValue({
    current_class_id: "81",
    user_id: "91",
    was_active: wasActive,
  });

  const updateTable = vi.fn(() => updateQuery);
  const database = {
    selectFrom: vi.fn(() => {
      throw new Error("logout must not read current membership after revocation");
    }),
    updateTable,
  };
  return {
    service: new SessionService(database as never, {} as never, {} as never),
    updateTable,
  };
}

function createIdentityLookupService(
  result: { current_class_id: string | null; user_id: string } | undefined,
): { service: SessionService; where: ReturnType<typeof vi.fn> } {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.innerJoin = vi.fn(() => query);
  query.leftJoin = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.executeTakeFirst = vi.fn().mockResolvedValue(result);

  return {
    service: new SessionService(
      {
        selectFrom: vi.fn(() => query),
      } as never,
      {} as never,
      {} as never,
    ),
    where: query.where,
  };
}

describe("SessionService login failure budget preflight", () => {
  beforeEach(() => {
    passwordHasherMocks.hashPassword.mockReset();
    passwordHasherMocks.verifyPassword.mockReset();
  });

  it("returns the same 429 for known and unknown emails before KDF or database work", async () => {
    const database = {
      insertInto: vi.fn(),
      selectFrom: vi.fn(),
      transaction: vi.fn(),
      updateTable: vi.fn(),
    };
    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
      getPolicy: vi.fn().mockResolvedValue({ max_attempts: 3, cooldown_seconds: 60 }),
      ensureAvailable: vi.fn().mockResolvedValue(undefined),
      peek: vi
        .fn()
        .mockImplementation(async (request: { key: string }) =>
          request.key === "login-admission:service:v1"
            ? { allowed: true }
            : { allowed: false, count: 20, limit: 20, remaining: 0, retryAfterSeconds: 321 },
        ),
    };
    const service = new SessionService(
      database as never,
      rateLimiter as never,
      {
        emailHmacKey: "unit-test-email-hmac-key-32-bytes",
        emailHmacKeyVersion: "test-v1",
      } as never,
    );
    const clientIp = "203.0.113.42";
    const [knownOutcome, unknownOutcome] = await Promise.allSettled([
      service.login({ email: "known@example.com", password: "known-password" }, clientIp),
      service.login({ email: "unknown@example.com", password: "unknown-password" }, clientIp),
    ]);

    expect(knownOutcome.status).toBe("rejected");
    expect(unknownOutcome.status).toBe("rejected");
    if (knownOutcome.status !== "rejected" || unknownOutcome.status !== "rejected") {
      throw new Error("Expected both exhausted-budget logins to be rejected.");
    }
    expect(knownOutcome.reason).toBeInstanceOf(RateLimitedException);
    expect(unknownOutcome.reason).toBeInstanceOf(RateLimitedException);
    expect((knownOutcome.reason as RateLimitedException).getResponse()).toEqual(
      (unknownOutcome.reason as RateLimitedException).getResponse(),
    );
    expect((knownOutcome.reason as RateLimitedException).getStatus()).toBe(429);
    expect(rateLimiter.ensureAvailable).not.toHaveBeenCalled();
    expect(rateLimiter.peek).toHaveBeenCalledTimes(4);
    const failureQueries = rateLimiter.peek.mock.calls
      .map(([request]) => request)
      .filter((request) => request.key.startsWith("login-failure:"));
    expect(failureQueries[0]?.key).not.toBe(failureQueries[1]?.key);
    expect(failureQueries[0]).toMatchObject({
      key: expect.stringMatching(/^login-failure:pair:test-v1:[A-Za-z0-9_-]{43}$/u),
    });
    expect(JSON.stringify(rateLimiter.peek.mock.calls)).not.toContain(clientIp);
    expect(rateLimiter.consume).toHaveBeenCalledTimes(4);
    expect(passwordHasherMocks.hashPassword).not.toHaveBeenCalled();
    expect(passwordHasherMocks.verifyPassword).not.toHaveBeenCalled();
    expect(database.selectFrom).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.updateTable).not.toHaveBeenCalled();
    expect(database.insertInto).not.toHaveBeenCalled();
  });

  it("fails closed when the non-consuming limiter preflight is unavailable", async () => {
    const limiterFailure = new RateLimitServiceUnavailableException(
      new Error("simulated Redis read failure"),
    );
    const database = {
      selectFrom: vi.fn(),
      transaction: vi.fn(),
    };
    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
      getPolicy: vi.fn().mockResolvedValue({ max_attempts: 3, cooldown_seconds: 60 }),
      ensureAvailable: vi.fn().mockResolvedValue(undefined),
      peek: vi.fn().mockRejectedValue(limiterFailure),
    };
    const service = new SessionService(
      database as never,
      rateLimiter as never,
      {
        emailHmacKey: "unit-test-email-hmac-key-32-bytes",
        emailHmacKeyVersion: "test-v1",
      } as never,
    );

    await expect(
      service.login({ email: "known@example.com", password: "known-password" }, "203.0.113.43"),
    ).rejects.toBe(limiterFailure);
    expect(rateLimiter.ensureAvailable).not.toHaveBeenCalled();
    expect(rateLimiter.peek).toHaveBeenCalledOnce();
    expect(rateLimiter.consume).toHaveBeenCalledTimes(2);
    expect(passwordHasherMocks.hashPassword).not.toHaveBeenCalled();
    expect(passwordHasherMocks.verifyPassword).not.toHaveBeenCalled();
    expect(database.selectFrom).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe("SessionService lifecycle", () => {
  beforeEach(() => {
    passwordHasherMocks.hashPassword.mockReset();
    passwordHasherMocks.verifyPassword.mockReset();
  });

  it("initializes and memoizes the dummy password hash during module startup", async () => {
    passwordHasherMocks.hashPassword.mockResolvedValue("dummy-hash");
    const service = createService();

    expect(passwordHasherMocks.hashPassword).not.toHaveBeenCalled();

    await Promise.all([service.onModuleInit(), service.onModuleInit()]);
    await service.onModuleInit();

    expect(passwordHasherMocks.hashPassword).toHaveBeenCalledExactlyOnceWith(
      "classhub-server-dummy-password-1",
    );
  });

  it("surfaces initialization failure and does not cache the rejected promise", async () => {
    const failure = new Error("simulated dummy hash failure");
    passwordHasherMocks.hashPassword
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("recovered-dummy-hash");
    const service = createService();

    await expect(service.onModuleInit()).rejects.toBe(failure);
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(passwordHasherMocks.hashPassword).toHaveBeenCalledTimes(2);
  });

  it("rejects Nest application startup when dummy hash initialization fails", async () => {
    const failure = new Error("simulated Nest startup hash failure");
    passwordHasherMocks.hashPassword.mockRejectedValue(failure);

    await expect(
      NestFactory.createApplicationContext(SessionServiceTestModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toBe(failure);
    expect(passwordHasherMocks.hashPassword).toHaveBeenCalledExactlyOnceWith(
      "classhub-server-dummy-password-1",
    );
  });

  it("maps authenticated-session database failures to a safe 503 error", async () => {
    const sensitiveFailure = new Error("postgresql://runtime-user:secret@db.internal/classhub");
    const execute = vi.fn().mockRejectedValue(sensitiveFailure);
    const service = new SessionService(
      { transaction: () => ({ execute }) } as never,
      {} as never,
      {} as never,
    );
    const { sessionToken } = issueSessionSecrets();

    let caught: unknown;
    try {
      await service.authenticate(sessionToken);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SessionServiceUnavailableException);
    expect((caught as SessionServiceUnavailableException).getStatus()).toBe(503);
    expect((caught as SessionServiceUnavailableException).getResponse()).toEqual({
      code: "SESSION_SERVICE_UNAVAILABLE",
      message: "로그인 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    });
    expect(JSON.stringify(caught)).not.toContain("runtime-user");
    expect(JSON.stringify(caught)).not.toContain("secret");
  });
});

describe("SessionService security-audit identity", () => {
  it("uses the sole Bootstrap-current membership and rejects missing, ambiguous, or invalid IDs", () => {
    expect(resolveCurrentClassId([])).toBeNull();
    expect(resolveCurrentClassId([{ class_id: "71" }])).toBe("71");
    expect(resolveCurrentClassId([{ class_id: "71" }, { class_id: "72" }])).toBeNull();
    expect(resolveCurrentClassId([{ class_id: "0" }])).toBeNull();
    expect(resolveCurrentClassId([{ class_id: "9223372036854775808" }])).toBeNull();
    expect(resolveCurrentClassId([{ class_id: "body-param-is-not-an-id" }])).toBeNull();
  });

  it("isolates observer exceptions from the original authentication decision", () => {
    const identity = { currentClassId: "81", userId: "91" };
    const observer = vi.fn(() => {
      throw new Error("observer unavailable");
    });

    expect(() => notifySecurityAuditIdentity(observer, identity)).not.toThrow();
    expect(observer).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("returns no identity when the bad-Origin enrichment lookup throws", async () => {
    const secret = "postgresql://runtime-user:password@db.internal/private";
    const selectFrom = vi.fn(() => {
      throw new Error(secret);
    });
    const service = new SessionService({ selectFrom } as never, {} as never, {} as never);
    const { sessionToken } = issueSessionSecrets();

    const identity = await service.resolveSecurityAuditIdentity(sessionToken);

    expect(identity).toBeNull();
    expect(selectFrom).toHaveBeenCalledExactlyOnceWith("sessions");
    expect(JSON.stringify(identity)).not.toContain(secret);
  });

  it("does not touch the database for a missing or random session cookie", async () => {
    const selectFrom = vi.fn();
    const service = new SessionService({ selectFrom } as never, {} as never, {} as never);

    await expect(service.resolveSecurityAuditIdentity(undefined)).resolves.toBeNull();
    await expect(service.resolveSecurityAuditIdentity("random-cookie-value")).resolves.toBeNull();

    expect(selectFrom).not.toHaveBeenCalled();
  });

  it("uses the DB active flag for logout audit despite extreme Node clock skew", async () => {
    vi.useFakeTimers();
    try {
      const { sessionToken } = issueSessionSecrets();
      const active = createLogoutService(true);
      vi.setSystemTime(new Date("2200-01-01T00:00:00.000Z"));

      await expect(active.service.logout(sessionToken)).resolves.toEqual({
        currentClassId: "81",
        userId: "91",
      });
      expect(active.updateTable).toHaveBeenCalledOnce();

      const expired = createLogoutService(false);
      vi.setSystemTime(new Date("1900-01-01T00:00:00.000Z"));

      await expect(expired.service.logout(sessionToken)).resolves.toBeNull();
      expect(expired.updateTable).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses DB clock predicates for bad-Origin identity despite extreme Node clock skew", async () => {
    vi.useFakeTimers();
    try {
      const { sessionToken } = issueSessionSecrets();
      const dbActive = createIdentityLookupService({
        current_class_id: "81",
        user_id: "91",
      });
      vi.setSystemTime(new Date("2200-01-01T00:00:00.000Z"));

      await expect(dbActive.service.resolveSecurityAuditIdentity(sessionToken)).resolves.toEqual({
        currentClassId: "81",
        userId: "91",
      });

      const dbExpired = createIdentityLookupService(undefined);
      vi.setSystemTime(new Date("1900-01-01T00:00:00.000Z"));

      await expect(
        dbExpired.service.resolveSecurityAuditIdentity(sessionToken),
      ).resolves.toBeNull();
      for (const where of [dbActive.where, dbExpired.where]) {
        expect(
          where.mock.calls.flatMap((call) => call).filter((value) => value instanceof Date),
        ).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to plain revocation when current-class enrichment fails", async () => {
    const enhancedQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    enhancedQuery.set = vi.fn(() => enhancedQuery);
    enhancedQuery.where = vi.fn(() => enhancedQuery);
    enhancedQuery.returning = vi.fn(() => enhancedQuery);
    enhancedQuery.executeTakeFirst = vi.fn().mockRejectedValue(new Error("class ACL denied"));

    const fallbackQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    fallbackQuery.set = vi.fn(() => fallbackQuery);
    fallbackQuery.where = vi.fn(() => fallbackQuery);
    fallbackQuery.returning = vi.fn(() => fallbackQuery);
    fallbackQuery.executeTakeFirst = vi.fn().mockResolvedValue({
      user_id: "91",
      was_active: true,
    });

    const updateTable = vi
      .fn()
      .mockReturnValueOnce(enhancedQuery)
      .mockReturnValueOnce(fallbackQuery);
    const service = new SessionService(
      {
        selectFrom: vi.fn(() => {
          throw new Error("fallback must not query membership");
        }),
        updateTable,
      } as never,
      {} as never,
      {} as never,
    );
    const { sessionToken } = issueSessionSecrets();

    await expect(service.logout(sessionToken)).resolves.toEqual({
      currentClassId: null,
      userId: "91",
    });
    expect(updateTable).toHaveBeenCalledTimes(2);
  });

  it("keeps the class captured by the revoke statement across a membership transition race", async () => {
    let currentClassId = "81";
    let markStatementStarted!: () => void;
    const statementStarted = new Promise<void>((resolve) => {
      markStatementStarted = resolve;
    });
    let releaseStatement!: () => void;
    const statementRelease = new Promise<void>((resolve) => {
      releaseStatement = resolve;
    });
    const updateQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    updateQuery.set = vi.fn(() => updateQuery);
    updateQuery.where = vi.fn(() => updateQuery);
    updateQuery.returning = vi.fn(() => updateQuery);
    updateQuery.executeTakeFirst = vi.fn(async () => {
      const classIdAtStatementStart = currentClassId;
      markStatementStarted();
      await statementRelease;
      return {
        current_class_id: classIdAtStatementStart,
        user_id: "91",
        was_active: true,
      };
    });
    const selectFrom = vi.fn(() => {
      throw new Error("logout must not re-read membership after the revoke statement");
    });
    const service = new SessionService(
      {
        selectFrom,
        updateTable: vi.fn(() => updateQuery),
      } as never,
      {} as never,
      {} as never,
    );
    const { sessionToken } = issueSessionSecrets();
    const outcome = service.logout(sessionToken);

    await statementStarted;
    currentClassId = "99";
    releaseStatement();

    await expect(outcome).resolves.toEqual({ currentClassId: "81", userId: "91" });
    expect(selectFrom).not.toHaveBeenCalled();
  });
});
