import { describe, expect, it, vi } from "vitest";
import { AdminSignupApprovalService } from "./admin-signup-approval.service.js";
import { approvalCodeDigest } from "./admin-signup-approval.policy.js";
import { encryptSignupCode } from "../mail/signup-code-vault.js";

vi.mock("kysely", () => ({
  sql: () => ({
    as: vi.fn(() => "computed_status"),
    execute: vi.fn(async () => undefined),
  }),
}));

function databaseDouble() {
  const revokedWhere: Record<string, unknown> = {};
  const insertValues: Record<string, unknown>[] = [];
  const update = {
    set: vi.fn(() => update),
    where: vi.fn((key: string, _op: string, value: unknown) => {
      revokedWhere[key] = value;
      return update;
    }),
    execute: vi.fn(async () => []),
    executeTakeFirst: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
    returning: vi.fn(() => update),
  };
  const insert = {
    values: vi.fn((value: Record<string, unknown>) => {
      insertValues.push(value);
      return insert;
    }),
    returning: vi.fn(() => insert),
    executeTakeFirstOrThrow: vi.fn(async () => ({
      id: "approval-1",
      expires_at: new Date("2030-01-01T00:10:00Z"),
    })),
    execute: vi.fn(async () => []),
  };
  const select = {
    select: vi.fn(() => select),
    where: vi.fn(() => select),
    forUpdate: vi.fn(() => select),
    executeTakeFirst: vi.fn(async (): Promise<Record<string, unknown> | undefined> => ({
      user_id: "1",
      signup_role: "teacher",
      signup_approved_at: null,
      email_verified_at: new Date(),
      is_active: true,
    })),
    orderBy: vi.fn(() => select),
    limit: vi.fn(() => select),
    execute: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  };
  const db = {
    selectFrom: vi.fn(() => select),
    updateTable: vi.fn(() => update),
    insertInto: vi.fn(() => insert),
    transaction: vi.fn(() => ({ execute: (work: (transaction: unknown) => unknown) => work(db) })),
  };
  return {
    db: db as never,
    update,
    revokedWhere,
    insertValues,
    select,
  };
}

describe("AdminSignupApprovalService list contract", () => {
  it("does not replace a code or send mail when the common budget is exhausted", async () => {
    const d = databaseDouble();
    const config = {
      get: (key: string) => (key === "DATABASE_ENGINE" ? "postgres" : "synthetic-mail-budget-test"),
    };
    const mailer = { sendSignupApprovalEmail: vi.fn() };
    const limiter = {
      consumeAll: vi.fn().mockResolvedValue({
        allowed: false,
        count: 1,
        limit: 1,
        remaining: 0,
        retryAfterSeconds: 60,
      }),
    };
    const service = new AdminSignupApprovalService(
      d.db,
      config as never,
      mailer as never,
      limiter as never,
    );
    await expect(
      service.issue("teacher@example.invalid", "teacher", "1", "request", true, "192.0.2.1"),
    ).rejects.toMatchObject({ status: 429 });
    expect(d.update.set).not.toHaveBeenCalled();
    expect(d.insertValues).toHaveLength(0);
    expect(mailer.sendSignupApprovalEmail).not.toHaveBeenCalled();
  });
  it("returns only lifecycle metadata and keeps approval secrets undiscoverable", async () => {
    const d = databaseDouble();
    d.select.execute.mockResolvedValueOnce([
      {
        consumed_at: null,
        expires_at: new Date("2030-01-01T00:10:00Z"),
        id: "approval-active",
        issued_at: new Date("2030-01-01T00:00:00Z"),
        revoked_at: null,
        role: "teacher",
        status: "active",
      },
      {
        consumed_at: new Date("2030-01-01T00:05:00Z"),
        expires_at: new Date("2030-01-01T00:10:00Z"),
        id: "approval-consumed",
        issued_at: new Date("2030-01-01T00:00:00Z"),
        revoked_at: null,
        role: "student",
        status: "consumed",
      },
    ]);

    const response = await new AdminSignupApprovalService(
      d.db,
      {
        get: vi.fn((key: string) =>
          key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key",
        ),
      } as never,
      undefined,
      { consumeAll: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    ).list();

    expect(response).toEqual({
      approvals: [
        {
          consumed_at: null,
          expires_at: "2030-01-01T00:10:00.000Z",
          id: "approval-active",
          issued_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
          role: "teacher",
          status: "active",
        },
        {
          consumed_at: "2030-01-01T00:05:00.000Z",
          expires_at: "2030-01-01T00:10:00.000Z",
          id: "approval-consumed",
          issued_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
          role: "student",
          status: "consumed",
        },
      ],
    });
    expect(JSON.stringify(response)).not.toMatch(/code|digest|email/iu);
    expect(d.select.limit).toHaveBeenCalledWith(100);
  });
});

describe("AdminSignupApprovalService issue contract", () => {
  it.each([true, false])(
    "enforces email ownership before administrator approval and prevents self-resend after verification (%s)",
    async (admin) => {
      const d = databaseDouble();
      d.select.executeTakeFirst.mockResolvedValueOnce({
        user_id: "1",
        signup_role: "teacher",
        signup_approved_at: null,
        is_active: true,
        email_verified_at: admin ? null : new Date(),
      });
      const service = new AdminSignupApprovalService(
        d.db,
        {
          get: (key: string) => (key === "DATABASE_ENGINE" ? "postgres" : "test-email-hmac-key"),
        } as never,
        undefined,
        { consumeAll: vi.fn().mockResolvedValue({ allowed: true }) } as never,
      );
      await expect(
        service.issue("teacher@example.invalid", "teacher", admin ? "2" : null, "request", true),
      ).rejects.toMatchObject({
        response: {
          code: admin ? "SIGNUP_EMAIL_VERIFICATION_REQUIRED" : "SIGNUP_EMAIL_ALREADY_VERIFIED",
        },
      });
      expect(d.update.set).not.toHaveBeenCalled();
      expect(d.insertValues).toHaveLength(0);
    },
  );
  it.each([
    "same",
    "other-account",
    "other-purpose",
    "legacy",
    "exhausted",
    "admin-issued",
  ] as const)("reuses only a usable code bound to this account and purpose (%s)", async (kind) => {
    const d = databaseDouble(),
      secret = "test-email-hmac-key",
      email = "teacher@example.invalid";
    const previousCode = "000001";
    d.select.executeTakeFirst.mockResolvedValueOnce({
      user_id: "1",
      signup_role: "teacher",
      signup_approved_at: null,
      is_active: true,
      email_verified_at: null,
    });
    d.select.executeTakeFirst.mockResolvedValueOnce({
      id: "previous",
      expires_at: new Date("2030-01-01"),
      code_encrypted: encryptSignupCode(previousCode, secret, email, "teacher"),
      code_digest:
        kind === "legacy"
          ? Buffer.alloc(32)
          : approvalCodeDigest(
              secret,
              email,
              "teacher",
              previousCode,
              kind === "other-account" ? "2" : "1",
              kind === "other-purpose" ? "approval" : "email",
            ),
      failed_attempts: kind === "exhausted" ? 5 : 0,
      issued_by_admin_account_id: kind === "admin-issued" ? "2" : null,
    });
    const service = new AdminSignupApprovalService(
      d.db,
      {
        get: (key: string) => (key === "DATABASE_ENGINE" ? "postgres" : secret),
      } as never,
      undefined,
      { consumeAll: vi.fn().mockResolvedValue({ allowed: true }) } as never,
    );
    const result = await service.issue(email, "teacher", null, "request", true);
    if (kind === "same") {
      expect(result.code).toBe(previousCode);
      expect(d.insertValues).toHaveLength(0);
      expect(d.update.set).not.toHaveBeenCalled();
    } else {
      expect(d.insertValues[0]?.code_digest).toEqual(
        approvalCodeDigest(secret, email, "teacher", result.code, "1", "email"),
      );
      expect(d.insertValues[0]?.issued_by_admin_account_id).toBeNull();
      expect(d.update.set).toHaveBeenCalledOnce();
    }
  });
  it.each([false, true])(
    "emails the issued code after commit without repeating the DB transaction when SMTP fails=%s",
    async (mailFailure) => {
      const d = databaseDouble();
      let committed = false;
      const database = {
        ...(d.db as object),
        transaction: vi.fn(() => ({
          execute: async (work: (transaction: unknown) => Promise<unknown>) => {
            const result = await work(d.db);
            committed = true;
            return result;
          },
        })),
      };
      const mailer = {
        sendSignupApprovalEmail: vi.fn(async () => {
          expect(committed).toBe(true);
          if (mailFailure) throw new Error("private SMTP reply");
          return "sent";
        }),
      };
      const config = {
        get: vi.fn((key: string) =>
          key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key",
        ),
      };
      const result = await new AdminSignupApprovalService(
        database as never,
        config as never,
        mailer as never,
        { consumeAll: vi.fn().mockResolvedValue({ allowed: true }) } as never,
      ).issue(" Teacher@Example.Invalid ", "teacher", "admin-1", "request-1");
      expect(result.email_delivery_status).toBe(mailFailure ? "failed" : "sent");
      expect(result.code).toMatch(/^[0-9]{6}$/u);
      expect(mailer.sendSignupApprovalEmail).toHaveBeenCalledWith("teacher@example.invalid", {
        code: result.code,
        role: "teacher",
        expiresAt: result.expiresAt,
      });
      expect(database.transaction).toHaveBeenCalledOnce();
    },
  );

  it.each(["student", null])(
    "rejects teacher issuance for stored role %s before revoking a valid code",
    async (signup_role) => {
      const d = databaseDouble();
      d.select.executeTakeFirst.mockResolvedValueOnce({
        user_id: "1",
        signup_role,
        signup_approved_at: null,
        email_verified_at: new Date(),
        is_active: true,
      });
      const service = new AdminSignupApprovalService(
        d.db,
        {
          get: vi.fn((key: string) =>
            key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key",
          ),
        } as never,
        undefined,
        { consumeAll: vi.fn().mockResolvedValue({ allowed: true }) } as never,
      );
      await expect(
        service.issue("student@example.invalid", "teacher", "1", "request"),
      ).rejects.toMatchObject({ response: { code: "SIGNUP_ROLE_MISMATCH" } });
      expect(d.update.set).not.toHaveBeenCalled();
      expect(d.insertValues).toHaveLength(0);
    },
  );

  it("stores a 32-byte base64url email digest and revokes active codes regardless of issuer", async () => {
    const d = databaseDouble();
    const config = {
      get: vi.fn((key: string) => (key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key")),
    } as never;
    const result = await new AdminSignupApprovalService(d.db, config, undefined, {
      consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
    } as never).issue(
      " Admin@Example.com ",
      "teacher",
      "issuer-2",
      "00000000-0000-4000-8000-000000000001",
    );
    const inserted = d.insertValues.at(0)!;
    const digest = inserted.email_key_digest as Buffer;
    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest.length).toBe(32);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(d.revokedWhere.issued_by_admin_account_id).toBeUndefined();
    expect(d.revokedWhere.email_key_digest).toEqual(digest);
    expect(d.revokedWhere.role).toBe("teacher");
    expect(inserted.issued_by_admin_account_id).toBe("issuer-2");
    expect(d.insertValues.at(1)).toMatchObject({
      action: "issue",
      admin_actor_account_id: "issuer-2",
      approval_id: "approval-1",
      result_code: "issued",
      role: "teacher",
      user_actor_id: null,
    });
    expect(d.insertValues.at(2)).toMatchObject({
      action: "admin.signup_approval.issued",
    });
  });

  it("records reissue distinctly from first issuance", async () => {
    const d = databaseDouble();
    d.update.executeTakeFirst.mockResolvedValueOnce({ id: "approval-old" });
    const config = {
      get: vi.fn((key: string) => (key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key")),
    } as never;

    await new AdminSignupApprovalService(d.db, config, undefined, {
      consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
    } as never).issue(
      "teacher@example.com",
      "teacher",
      "issuer-2",
      "00000000-0000-4000-8000-000000000002",
    );

    expect(d.insertValues.at(1)).toMatchObject({
      action: "reissue",
      result_code: "reissued",
    });
    expect(d.insertValues.at(2)).toMatchObject({
      action: "admin.signup_approval.reissued",
    });
  });

  it("records a successful revoke in both approval and operation audit trails", async () => {
    const d = databaseDouble();
    d.update.executeTakeFirst.mockResolvedValueOnce({ id: "approval-1", role: "student" });
    const config = {
      get: vi.fn((key: string) => (key === "DATABASE_ENGINE" ? undefined : "test-email-hmac-key")),
    } as never;

    await expect(
      new AdminSignupApprovalService(d.db, config, undefined, {
        consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
      } as never).revoke("approval-1", "issuer-2", "00000000-0000-4000-8000-000000000003"),
    ).resolves.toEqual({ revoked: true });
    expect(d.insertValues.at(0)).toMatchObject({
      action: "revoke",
      admin_actor_account_id: "issuer-2",
      approval_id: "approval-1",
      result_code: "revoked",
      role: "student",
    });
    expect(d.insertValues.at(1)).toMatchObject({
      action: "admin.signup_approval.revoked",
    });
  });
});
