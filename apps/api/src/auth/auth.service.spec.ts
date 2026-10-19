import { describe, expect, it, vi } from "vitest";

import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import {
  InvalidConsentsException,
  InvalidGuardianConsentException,
  SignupApprovalInvalidException,
  TokenInvalidOrExpiredException,
} from "./auth.errors.js";
import { AuthService } from "./auth.service.js";
import type { AuthConfig, SignUpCommand } from "./auth.types.js";

vi.mock("./password-hasher.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("synthetic-password-hash"),
}));

const authConfig: AuthConfig = {
  agePolicyVersion: "age-test",
  emailHmacKey: "unit-test-email-hmac-key-at-least-32-bytes",
  emailHmacKeyVersion: "test-v1",
  privacyPolicyVersion: "privacy-test",
  termsPolicyVersion: "terms-test",
};

const allowedLimit = {
  allowed: true,
  count: 1,
  limit: 10,
  remaining: 9,
  retryAfterSeconds: 3_600,
};

const signupApproval = {
  role: "student" as const,
};

interface QueryHooks {
  onSet?: (value: unknown) => void;
  onValues?: (value: unknown) => void;
}

function createQuery<T>(result: T, hooks: QueryHooks = {}) {
  const query = {
    execute: vi.fn().mockResolvedValue([]),
    executeTakeFirst: vi.fn().mockResolvedValue(result),
    executeTakeFirstOrThrow: vi.fn().mockImplementation(async () => {
      if (result === undefined) throw new Error("missing synthetic row");
      return result;
    }),
    forUpdate: vi.fn(),
    returning: vi.fn(),
    select: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    where: vi.fn(),
  };

  query.forUpdate.mockReturnValue(query);
  query.returning.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.set.mockImplementation((value: unknown) => {
    hooks.onSet?.(value);
    return query;
  });
  query.values.mockImplementation((value: unknown) => {
    hooks.onValues?.(value);
    return query;
  });
  query.where.mockReturnValue(query);
  return query;
}

function createService(
  database: object,
  input: {
    mailer?: object;
    rateLimiter?: object;
    securityAuditPublisher?: object;
    notifications?: object;
    signupMail?: object;
  } = {},
): AuthService {
  return new AuthService(
    database as never,
    {
      consumeAll: vi.fn().mockResolvedValue(allowedLimit),
      ...(input.rateLimiter ?? { consume: vi.fn().mockResolvedValue(allowedLimit) }),
    } as never,
    (input.mailer ?? {
      sendGuardianConsentEmail: vi.fn().mockResolvedValue(undefined),
      sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    }) as never,
    authConfig,
    (input.securityAuditPublisher ?? { close: vi.fn(), publish: vi.fn() }) as never,
    undefined,
    (input.notifications ?? { sendSignupEmail: vi.fn().mockResolvedValue("sent") }) as never,
    input.signupMail as never,
  );
}

describe("AuthService", () => {
  it("rejects a guardian mail budget before creating a consent request", async () => {
    const database = { transaction: vi.fn(), insertInto: vi.fn() };
    const service = createService(database, {
      rateLimiter: {
        consume: vi.fn().mockResolvedValue(allowedLimit),
        consumeAll: vi.fn().mockResolvedValue({ ...allowedLimit, allowed: false }),
      },
    });
    await expect(
      service.requestGuardianConsent("guardian@example.invalid", "192.0.2.1"),
    ).rejects.toMatchObject({ status: 429 });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.insertInto).not.toHaveBeenCalled();
  });

  it("preserves an existing verification token when its mail budget is denied", async () => {
    const query = createQuery({
      deleted_at: null,
      email_normalized: "student@example.invalid",
      email_verified_at: null,
      signup_approved_at: new Date(),
      is_active: true,
    });
    const transaction = {
      selectFrom: vi.fn(() => query),
      updateTable: vi.fn(),
      insertInto: vi.fn(),
    };
    const service = createService(
      {
        transaction: () => ({
          execute: (work: (tx: typeof transaction) => unknown) => work(transaction),
        }),
      },
      {
        rateLimiter: {
          consume: vi.fn().mockResolvedValue(allowedLimit),
          consumeAll: vi.fn().mockResolvedValue({ ...allowedLimit, allowed: false }),
        },
      },
    );
    await expect(service.resendVerification("1", "192.0.2.1")).rejects.toMatchObject({
      status: 429,
    });
    expect(transaction.updateTable).not.toHaveBeenCalled();
    expect(transaction.insertInto).not.toHaveBeenCalled();
  });
  it.each(["student", "teacher"] as const)(
    "rejects pre-registration codes for %s before DB or expensive work",
    async (role) => {
      const database = { transaction: vi.fn() };
      const rateLimiter = { consume: vi.fn() };
      const service = createService(database, { rateLimiter });
      await expect(
        service.signUp(
          {
            age_route: "over_14",
            role,
            approval_code: "123456",
            consents: { privacy: true, terms: true },
            display_name: "Synthetic signup",
            email: "signup@example.invalid",
            password: "Unit1234",
          },
          "192.0.2.1",
        ),
      ).rejects.toBeInstanceOf(SignupApprovalInvalidException);
      expect(database.transaction).not.toHaveBeenCalled();
      expect(rateLimiter.consume).not.toHaveBeenCalled();
    },
  );
  it.each(["sent", "failed", "throws", "commit failure"] as const)(
    "issues the signup verification mail only after commit and keeps the account when delivery %s",
    async (outcome) => {
      let committed = false;
      const userInsert = createQuery({ id: "41" });
      const consentInsert = createQuery(undefined);
      const transaction = {
        selectFrom: vi.fn(() => createQuery(undefined)),
        insertInto: vi.fn((table: string) => (table === "users" ? userInsert : consentInsert)),
      };
      const database = {
        transaction: vi.fn(() => ({
          execute: async (work: (value: typeof transaction) => Promise<unknown>) => {
            const result = await work(transaction);
            if (outcome === "commit failure") throw new Error("synthetic commit failure");
            committed = true;
            return result;
          },
        })),
      };
      const notifications = {
        sendSignupEmail: vi.fn(),
      };
      const signupMail = {
        issue: vi.fn(async () => {
          expect(committed).toBe(true);
          if (outcome === "throws") throw new Error("private SMTP reply");
          return { email_delivery_status: outcome };
        }),
      };
      const service = createService(database, { notifications, signupMail });
      const operation = service.signUp(
        {
          age_route: "over_14",
          role: "student",
          consents: { privacy: true, terms: true },
          display_name: "학생",
          email: "student@example.invalid",
          password: "Unit1234",
        },
        "192.0.2.1",
      );
      if (outcome === "commit failure") {
        await expect(operation).rejects.toThrow("synthetic commit failure");
        expect(signupMail.issue).not.toHaveBeenCalled();
      } else {
        await expect(operation).resolves.toEqual({
          next_action: "LOGIN",
          signup_delivery_status: outcome === "sent" ? "sent" : "failed",
        });
        expect(signupMail.issue).toHaveBeenCalledOnce();
        expect(signupMail.issue).toHaveBeenCalledWith(
          "student@example.invalid",
          "student",
          null,
          expect.any(String),
          true,
          "192.0.2.1",
          true,
        );
      }
      expect(notifications.sendSignupEmail).not.toHaveBeenCalled();
      expect(database.transaction).toHaveBeenCalledOnce();
      expect(userInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({ signup_approved_at: null }),
      );
      expect(transaction.insertInto).not.toHaveBeenCalledWith("email_verification_tokens");
    },
  );

  it("rejects invalid required consents before rate limiting or database work", async () => {
    const database = { transaction: vi.fn() };
    const rateLimiter = { consume: vi.fn() };
    const mailer = { sendGuardianConsentEmail: vi.fn(), sendVerificationEmail: vi.fn() };
    const securityAuditPublisher = { close: vi.fn(), publish: vi.fn() };
    const service = new AuthService(
      database as never,
      rateLimiter as never,
      mailer as never,
      authConfig,
      securityAuditPublisher,
    );
    const invalidConsents: unknown[] = [
      [],
      null,
      {},
      { privacy: true },
      { privacy: true, terms: false },
      { marketing: true, privacy: true, terms: true },
    ];

    for (const consents of invalidConsents) {
      const command: SignUpCommand = {
        age_route: "over_14",
        ...signupApproval,
        consents: consents as SignUpCommand["consents"],
        display_name: "테스트 학생",
        email: "invalid-service-consents@example.com",
        password: "Unit1234",
      };

      await expect(service.signUp(command, "127.0.0.1")).rejects.toBeInstanceOf(
        InvalidConsentsException,
      );
    }

    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
    expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects a missing or misplaced guardian reference before rate limiting", async () => {
    const database = { transaction: vi.fn() };
    const rateLimiter = { consume: vi.fn() };
    const mailer = { sendGuardianConsentEmail: vi.fn(), sendVerificationEmail: vi.fn() };
    const service = createService(database, { mailer, rateLimiter });
    const reference = {
      completion_token: "a".repeat(43),
      request_id: "11111111-1111-4111-8111-111111111111",
    };
    const base = {
      ...signupApproval,
      consents: { privacy: true as const, terms: true as const },
      display_name: "학생 하나",
      email: "student@example.com",
      password: "Unit1234",
    };

    await expect(
      service.signUp({ age_route: "guardian_consent", ...base }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(InvalidConsentsException);
    await expect(
      service.signUp({ age_route: "over_14", guardian_consent: reference, ...base }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(InvalidConsentsException);
    expect(rateLimiter.consume).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: (service: AuthService) =>
        service.signUp(
          {
            age_route: "over_14",
            ...signupApproval,
            consents: { privacy: true, terms: true },
            display_name: "테스트 학생",
            email: "rate-limited-signup@example.com",
            password: "Unit1234",
          },
          "127.0.0.1",
        ),
      label: "회원가입",
      results: [
        { allowed: false, count: 11, limit: 10, remaining: 0, retryAfterSeconds: 7 },
        { allowed: true, count: 1, limit: 3, remaining: 2, retryAfterSeconds: 3_600 },
      ],
    },
    {
      action: (service: AuthService) => service.resendVerification("42", "127.0.0.1"),
      label: "인증 메일 재발송",
      results: [
        { allowed: true, count: 1, limit: 3, remaining: 2, retryAfterSeconds: 600 },
        { allowed: false, count: 11, limit: 10, remaining: 0, retryAfterSeconds: 9 },
      ],
    },
  ])("uses only blocked limiter TTLs for $label Retry-After", async ({ action, results }) => {
    const database = { transaction: vi.fn() };
    const rateLimiter = { consume: vi.fn() };
    for (const result of results) rateLimiter.consume.mockResolvedValueOnce(result);
    const mailer = { sendGuardianConsentEmail: vi.fn(), sendVerificationEmail: vi.fn() };
    const securityAuditPublisher = { close: vi.fn(), publish: vi.fn() };
    const service = new AuthService(
      database as never,
      rateLimiter as never,
      mailer as never,
      authConfig,
      securityAuditPublisher,
    );

    const error = await action(service).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RateLimitedException);
    expect((error as RateLimitedException).getResponse()).toMatchObject({
      retry_after_seconds: results.find((result) => !result.allowed)?.retryAfterSeconds,
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("stores only token hashes and returns the separate completion token", async () => {
    let inserted: unknown;
    const insertQuery = createQuery(
      { expires_at: new Date(Date.now() + 86_400_000) },
      {
        onValues: (value) => {
          inserted = value;
        },
      },
    );
    const database = { insertInto: vi.fn().mockReturnValue(insertQuery) };
    const rateLimiter = { consume: vi.fn().mockResolvedValue(allowedLimit) };
    const mailer = {
      sendGuardianConsentEmail: vi.fn().mockResolvedValue(undefined),
      sendVerificationEmail: vi.fn(),
    };
    const securityAuditPublisher = { close: vi.fn(), publish: vi.fn() };
    const service = createService(database, { mailer, rateLimiter, securityAuditPublisher });

    const result = await service.requestGuardianConsent(" Guardian@Example.com ", "203.0.113.10");

    expect(result).toMatchObject({
      consent_delivery_status: "sent",
      request_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    expect(result.completion_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.expires_at).toMatch(/Z$/u);
    expect(mailer.sendGuardianConsentEmail).toHaveBeenCalledOnce();
    const approvalToken = mailer.sendGuardianConsentEmail.mock.calls[0]?.[1] as string;
    expect(approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(approvalToken).not.toBe(result.completion_token);
    expect(inserted).toMatchObject({
      approval_token_hash: expect.any(Buffer),
      completion_token_hash: expect.any(Buffer),
      guardian_email_normalized: "guardian@example.com",
      id: result.request_id,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
    });
    expect(JSON.stringify(inserted)).not.toContain(approvalToken);
    expect(JSON.stringify(inserted)).not.toContain(result.completion_token);
    expect(JSON.stringify(rateLimiter.consume.mock.calls)).not.toContain("guardian@example.com");
    expect(JSON.stringify(rateLimiter.consume.mock.calls)).not.toContain("203.0.113.10");
    expect(securityAuditPublisher.publish).not.toHaveBeenCalled();
  });

  it("keeps the request and reports failed when guardian email delivery fails", async () => {
    const insertQuery = createQuery({ expires_at: new Date(Date.now() + 86_400_000) });
    const database = { insertInto: vi.fn().mockReturnValue(insertQuery) };
    const mailer = {
      sendGuardianConsentEmail: vi.fn().mockRejectedValue(new Error("synthetic SMTP failure")),
      sendVerificationEmail: vi.fn(),
    };
    const service = createService(database, { mailer });

    await expect(
      service.requestGuardianConsent("guardian@example.com", "203.0.113.11"),
    ).resolves.toMatchObject({ consent_delivery_status: "failed" });
    expect(insertQuery.executeTakeFirstOrThrow).toHaveBeenCalledOnce();
  });

  it("locks and approves a guardian token exactly once while clearing its hash", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const selectQuery = createQuery({
      approved_at: null,
      consumed_at: null,
      expires_at: expiresAt,
      id: "11111111-1111-4111-8111-111111111111",
      invalidated_at: null,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
    });
    let updateValues: unknown;
    const updateQuery = createQuery(
      { id: "11111111-1111-4111-8111-111111111111" },
      {
        onSet: (value) => {
          updateValues = value;
        },
      },
    );
    const transaction = {
      selectFrom: vi.fn().mockReturnValue(selectQuery),
      updateTable: vi.fn().mockReturnValue(updateQuery),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    };
    const service = createService(database);

    await expect(service.confirmGuardianConsent("a".repeat(43))).resolves.toEqual({
      guardian_consent: true,
    });
    expect(selectQuery.forUpdate).toHaveBeenCalledOnce();
    expect(updateValues).toMatchObject({
      approval_token_hash: null,
      approved_at: expect.anything(),
    });

    selectQuery.executeTakeFirst.mockResolvedValueOnce(undefined);
    await expect(service.confirmGuardianConsent("a".repeat(43))).rejects.toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );
  });

  it("does not approve an expired guardian token", async () => {
    const selectQuery = createQuery({
      approved_at: null,
      consumed_at: null,
      expires_at: new Date(Date.now() - 1),
      id: "55555555-5555-4555-8555-555555555555",
      invalidated_at: null,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
    });
    const transaction = {
      selectFrom: vi.fn().mockReturnValue(selectQuery),
      updateTable: vi.fn(),
    };
    const service = createService({
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    });

    await expect(service.confirmGuardianConsent("e".repeat(43))).rejects.toBeInstanceOf(
      TokenInvalidOrExpiredException,
    );
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", { approved_at: null, expires_at: new Date(Date.now() + 60_000) }],
    ["approved", { approved_at: new Date(), expires_at: new Date(Date.now() + 60_000) }],
    ["expired", { approved_at: null, expires_at: new Date(Date.now() - 1) }],
  ] as const)("reports guardian consent status %s", async (expectedStatus, state) => {
    const query = createQuery({
      consumed_at: null,
      invalidated_at: null,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
      ...state,
    });
    const service = createService({ selectFrom: vi.fn().mockReturnValue(query) });

    await expect(
      service.getGuardianConsentStatus({
        completion_token: "b".repeat(43),
        request_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toEqual({ status: expectedStatus });
  });

  it("preserves the over-14 age attestation consent", async () => {
    const approvalSelect = createQuery({
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      failed_attempts: 0,
      id: "approved-over-14",
      issued_by_admin_account_id: "admin-1",
      revoked_at: null,
    });
    let approvalUpdateValues: unknown;
    const approvalUpdate = createQuery(
      { id: "approved-over-14" },
      { onSet: (value) => (approvalUpdateValues = value) },
    );
    let userValues: unknown;
    const userInsert = createQuery({ id: "41" }, { onValues: (value) => (userValues = value) });
    let consentValues: unknown;
    const consentsInsert = createQuery(undefined, {
      onValues: (value) => {
        consentValues = value;
      },
    });
    const existingUserSelect = createQuery(undefined);
    let approvalEventValues: unknown;
    const approvalEventInsert = createQuery(undefined, {
      onValues: (value) => (approvalEventValues = value),
    });
    const transaction = {
      insertInto: vi.fn((table: string) => {
        if (table === "users") return userInsert;
        if (table === "user_consents") return consentsInsert;
        return approvalEventInsert;
      }),
      selectFrom: vi.fn((table: string) =>
        table === "admin_signup_approvals" ? approvalSelect : existingUserSelect,
      ),
      updateTable: vi.fn().mockReturnValue(approvalUpdate),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    };
    const service = createService(database);

    await expect(
      service.signUp(
        {
          age_route: "over_14",
          ...signupApproval,
          consents: { privacy: true, terms: true },
          display_name: "학생",
          email: "over14@example.com",
          password: "Unit1234",
        },
        "203.0.113.14",
      ),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });
    expect(userValues).toMatchObject({
      signup_approved_at: null,
    });
    expect(userValues).not.toHaveProperty("email_verified_at");
    expect(consentValues).toEqual([
      expect.objectContaining({ consent_type: "terms", user_id: "41" }),
      expect.objectContaining({ consent_type: "privacy", user_id: "41" }),
      expect.objectContaining({ consent_type: "age_over_14", user_id: "41" }),
    ]);
    expect(approvalUpdateValues).toBeUndefined();
    expect(approvalEventValues).toBeUndefined();
    expect(transaction.insertInto).not.toHaveBeenCalledWith("email_verification_tokens");
  });

  it("locks and consumes an approved guardian request without recording age_over_14", async () => {
    const guardianSelect = createQuery({
      approved_at: new Date(),
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      guardian_email_normalized: "guardian@example.com",
      id: "33333333-3333-4333-8333-333333333333",
      invalidated_at: null,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
      user_id: null,
    });
    const userInsert = createQuery({ id: "42" });
    const approvalSelect = createQuery({
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      failed_attempts: 0,
      id: "approved-guardian",
      issued_by_admin_account_id: "admin-1",
      revoked_at: null,
    });
    let consentValues: unknown;
    const consentsInsert = createQuery(undefined, {
      onValues: (value) => {
        consentValues = value;
      },
    });
    const existingUserSelect = createQuery(undefined);
    const approvalEventInsert = createQuery(undefined);
    let guardianUpdateValues: unknown;
    const guardianUpdate = createQuery(
      { id: "33333333-3333-4333-8333-333333333333" },
      {
        onSet: (value) => {
          guardianUpdateValues = value;
        },
      },
    );
    let approvalUpdateValues: unknown;
    const approvalUpdate = createQuery(
      { id: "approved-guardian" },
      { onSet: (value) => (approvalUpdateValues = value) },
    );
    const transaction = {
      insertInto: vi.fn((table: string) => {
        if (table === "users") return userInsert;
        if (table === "user_consents") return consentsInsert;
        return approvalEventInsert;
      }),
      selectFrom: vi.fn((table: string) => {
        if (table === "guardian_consent_requests") return guardianSelect;
        if (table === "admin_signup_approvals") return approvalSelect;
        return existingUserSelect;
      }),
      updateTable: vi.fn((table: string) =>
        table === "guardian_consent_requests" ? guardianUpdate : approvalUpdate,
      ),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    };
    const mailer = {
      sendGuardianConsentEmail: vi.fn(),
      sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService(database, { mailer });

    await expect(
      service.signUp(
        {
          age_route: "guardian_consent",
          ...signupApproval,
          consents: { privacy: true, terms: true },
          display_name: "학생 하나",
          email: "student@example.com",
          guardian_consent: {
            completion_token: "c".repeat(43),
            request_id: "33333333-3333-4333-8333-333333333333",
          },
          password: "Unit1234",
        },
        "203.0.113.12",
      ),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });

    expect(guardianSelect.forUpdate).toHaveBeenCalledOnce();
    expect(consentValues).toEqual([
      expect.objectContaining({ consent_type: "terms", user_id: "42" }),
      expect.objectContaining({ consent_type: "privacy", user_id: "42" }),
    ]);
    expect(JSON.stringify(consentValues)).not.toContain("age_over_14");
    expect(guardianUpdateValues).toMatchObject({
      completion_token_hash: null,
      consumed_at: expect.anything(),
      user_id: "42",
    });
    expect(guardianUpdate.where).toHaveBeenCalledWith(
      "completion_token_hash",
      "=",
      expect.any(Buffer),
    );
    expect(approvalUpdateValues).toBeUndefined();
  });

  it("rejects identical student and guardian emails before creating a user", async () => {
    const guardianSelect = createQuery({
      approved_at: new Date(),
      consumed_at: null,
      expires_at: new Date(Date.now() + 60_000),
      guardian_email_normalized: "same@example.com",
      id: "44444444-4444-4444-8444-444444444444",
      invalidated_at: null,
      privacy_policy_version: authConfig.privacyPolicyVersion,
      terms_policy_version: authConfig.termsPolicyVersion,
      user_id: null,
    });
    const transaction = {
      insertInto: vi.fn(),
      selectFrom: vi.fn().mockReturnValue(guardianSelect),
      updateTable: vi.fn(),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    };
    const service = createService(database);

    await expect(
      service.signUp(
        {
          age_route: "guardian_consent",
          ...signupApproval,
          consents: { privacy: true, terms: true },
          display_name: "학생 둘",
          email: " SAME@example.com ",
          guardian_consent: {
            completion_token: "d".repeat(43),
            request_id: "44444444-4444-4444-8444-444444444444",
          },
          password: "Unit1234",
        },
        "203.0.113.13",
      ),
    ).rejects.toBeInstanceOf(InvalidGuardianConsentException);
    expect(transaction.insertInto).not.toHaveBeenCalled();
  });

  it("rejects a consumed or unknown completion token before creating a user", async () => {
    const guardianSelect = createQuery(undefined);
    const transaction = {
      insertInto: vi.fn(),
      selectFrom: vi.fn().mockReturnValue(guardianSelect),
      updateTable: vi.fn(),
    };
    const database = {
      transaction: vi.fn().mockReturnValue({
        execute: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      }),
    };
    const mailer = {
      sendGuardianConsentEmail: vi.fn(),
      sendVerificationEmail: vi.fn(),
    };
    const service = createService(database, { mailer });

    await expect(
      service.signUp(
        {
          age_route: "guardian_consent",
          ...signupApproval,
          consents: { privacy: true, terms: true },
          display_name: "학생 셋",
          email: "student-three@example.com",
          guardian_consent: {
            completion_token: "f".repeat(43),
            request_id: "66666666-6666-4666-8666-666666666666",
          },
          password: "Unit1234",
        },
        "203.0.113.15",
      ),
    ).rejects.toBeInstanceOf(TokenInvalidOrExpiredException);
    expect(guardianSelect.forUpdate).toHaveBeenCalledOnce();
    expect(transaction.insertInto).not.toHaveBeenCalled();
    expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
