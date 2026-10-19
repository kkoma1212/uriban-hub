import { createMariaDbDatabase, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import { AdminUsersService } from "../admin-management/admin-users.service.js";
import { AdminSignupApprovalService } from "./admin-signup-approval.service.js";
import { decryptSignupCode } from "../mail/signup-code-vault.js";

const approvalId = "00000000-0000-4000-8000-000000000100";
const adminId = "9007199254741101",
  userId = "9007199254741102";
const requestId = "00000000-0000-4000-8000-000000000001";
const email = "member@example.invalid",
  timestamp = "2026-09-07 12:00:00.123456";
const config = new ConfigService<AppEnvironment, true>({
  DATABASE_ENGINE: "mariadb",
  EMAIL_HMAC_KEY: "synthetic-unit-key",
});
type Row = Record<string, unknown>;
type Call = { sql: string; parameters: readonly unknown[] };
const databases: ReturnType<typeof createMariaDbDatabase<DB>>[] = [];

// Compiled by the actual MysqlQueryCompiler and rollback-only driver. Scripted wire
// rows prove the caller boundary only; database permissions/concurrency require real QA.
function boundary() {
  const calls: Call[] = [];
  const fixture = {
    accountExists: true,
    signupRole: "teacher" as string | null,
    previousOpen: false,
    revocable: true,
    approvals: [
      {
        id: approvalId,
        role: "teacher",
        consumed_at: null,
        revoked_at: null,
        issued_at: timestamp,
        expires_at: "2026-09-07 12:10:00.123456",
        status: "active",
      },
    ] as Row[],
    users: [
      {
        id: userId,
        email_normalized: email,
        display_name: "Synthetic member",
        is_active: 1,
        email_verified_at: null,
        signup_approved_at: null,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ] as Row[],
    fail: undefined as ((call: Call) => unknown) | undefined,
  };
  const database = createMariaDbDatabase<DB>(
    () => ({
      getConnection(callback) {
        callback(null, {
          query(statement, parameters, reply) {
            const call = { sql: statement, parameters };
            calls.push(call);
            const failure = fixture.fail?.(call);
            if (failure !== undefined) return reply(failure, undefined);
            if (/^(?:SET |ROLLBACK|COMMIT|START TRANSACTION)/u.test(statement))
              return reply(null, { affectedRows: 0, insertId: 0 });
            if (statement.startsWith("update `admin_signup_approvals`"))
              return reply(null, { affectedRows: fixture.previousOpen ? 1 : 0, insertId: 0 });
            if (statement.startsWith("insert"))
              return reply(null, { affectedRows: 1, insertId: 0 });
            if (statement.includes("from `users`"))
              return reply(
                null,
                statement.includes("for update")
                  ? fixture.accountExists
                    ? [
                        {
                          user_id: userId,
                          signup_role: fixture.signupRole,
                          signup_approved_at: null,
                          email_verified_at: timestamp,
                          is_active: 1,
                        },
                      ]
                    : []
                  : fixture.users,
              );
            if (statement.includes("from `admin_signup_approvals`"))
              return reply(
                null,
                statement.includes("for update")
                  ? fixture.revocable
                    ? [{ id: approvalId, role: "teacher" }]
                    : []
                  : fixture.approvals,
              );
            return reply(new Error("Unexpected synthetic approval SQL"), undefined);
          },
          release: vi.fn(),
          destroy: vi.fn(),
        });
      },
      end: (callback) => callback(null),
    }),
    {
      host: "approval.test.invalid",
      database: "synthetic",
      user: "synthetic_app",
      password: "synthetic",
      sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic",
    },
  );
  databases.push(database);
  return {
    database,
    calls,
    fixture,
    approvals: new AdminSignupApprovalService(database, config, undefined, {
      consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
    } as never),
    users: new AdminUsersService(database, config),
  };
}
function statements(calls: Call[]) {
  return calls.filter((call) => /^(?:select|insert|update)/u.test(call.sql));
}
function assertMaria(calls: Call[]) {
  for (const call of statements(calls)) {
    expect(call.sql).not.toMatch(/::|\breturning\b|\bilike\b|pg_advisory|clock_timestamp/iu);
    expect(call.parameters.some((value) => value instanceof Date)).toBe(false);
  }
}
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe("MariaDB administrator signup approvals", () => {
  it("rejects an invalid engine before SQL", () => {
    const h = boundary();
    const invalid = new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<
      AppEnvironment,
      true
    >;
    expect(
      () =>
        new AdminSignupApprovalService(h.database, invalid, undefined, {
          consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
        } as never),
    ).toThrow("Invalid signup approval database engine");
    expect(() => new AdminUsersService(h.database, invalid)).toThrow(
      "Invalid administrator user database engine",
    );
    expect(h.calls).toHaveLength(0);
  });

  it("lists lifecycle metadata with native UUID and Date6 without disclosing email or code digests", async () => {
    const h = boundary();
    h.fixture.approvals = [
      ...h.fixture.approvals,
      { ...h.fixture.approvals[0], consumed_at: timestamp, status: "consumed" },
      { ...h.fixture.approvals[0], revoked_at: timestamp, status: "revoked" },
      { ...h.fixture.approvals[0], status: "expired" },
    ];
    const result = await h.approvals.list();
    expect(result.approvals).toHaveLength(4);
    expect(result.approvals[0]).toEqual({
      id: approvalId,
      role: "teacher",
      status: "active",
      consumed_at: null,
      revoked_at: null,
      issued_at: "2026-09-07T12:00:00.123Z",
      expires_at: "2026-09-07T12:10:00.123Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/email|code|digest/iu);
    const read = statements(h.calls)[0]!;
    expect(read.sql).toMatch(
      /consumed_at IS NOT NULL[\s\S]*revoked_at IS NOT NULL[\s\S]*expires_at <= UTC_TIMESTAMP\(6\)/u,
    );
    expect(read.parameters).toContain(100);
    assertMaria(h.calls);
  });

  it.each([false, true])(
    "issues/reissues after users lock, stores a sealed resend code and retrieves server UUID (reissue=%s)",
    async (reissue) => {
      const h = boundary();
      h.fixture.previousOpen = reissue;
      const result = await h.approvals.issue(
        " Member@Example.invalid ",
        "teacher",
        adminId,
        requestId,
      );
      expect(result).toEqual({
        id: approvalId,
        email_delivery_status: "failed",
        code: expect.stringMatching(/^\d{6}$/u),
        expiresAt: new Date("2026-09-07T12:10:00.123Z"),
      });
      const business = statements(h.calls);
      expect(business[0]?.sql).toContain("from `users`");
      expect(business[0]?.sql).toContain("`deleted_at` is null for update");
      expect(business[0]?.parameters).toEqual([email]);
      const revoke = business[1]!;
      expect(revoke.sql).toContain("`consumed_at` is null and `revoked_at` is null");
      expect(revoke.sql).not.toContain("issued_by_admin_account_id");
      const insertion = business[2]!;
      expect(insertion.sql).toMatch(/^insert into `admin_signup_approvals`/u);
      expect(insertion.sql).not.toMatch(/\(`id`/u);
      const digests = insertion.parameters.filter(Buffer.isBuffer);
      expect(digests.map((value) => value.length)).toEqual([32, 32]);
      const columns = [...insertion.sql.matchAll(/`([^`]+)`/gu)].slice(1).map((match) => match[1]);
      const encryptedCode = insertion.parameters[columns.indexOf("code_encrypted")];
      expect(typeof encryptedCode).toBe("string");
      expect(decryptSignupCode(String(encryptedCode), "synthetic-unit-key", email, "teacher")).toBe(
        result.code,
      );
      expect(insertion.parameters[columns.indexOf("recipient_email")]).toBe(email);
      expect(business[3]?.sql).toContain(
        "where `code_digest` = ? and `email_key_digest` = ? and `role` = ?",
      );
      for (const call of business.slice(1)) {
        if (call !== insertion) expect(call.parameters).not.toContain(email);
        expect(call.parameters).not.toContain(result.code);
      }
      const event = business.find((call) =>
        call.sql.startsWith("insert into `admin_signup_approval_events`"),
      )!;
      expect(event.parameters).toContain(reissue ? "reissue" : "issue");
      expect(event.parameters).toContain(reissue ? "reissued" : "issued");
      expect(event.parameters).toContain(approvalId);
      const audit = business.find((call) =>
        call.sql.startsWith("insert into `admin_operation_audit_logs`"),
      )!;
      expect(audit.parameters).toContain(JSON.stringify({ role: "teacher", status: "active" }));
      expect(audit.parameters).toContain(null);
      expect(audit.parameters).toContain(
        reissue ? "admin.signup_approval.reissued" : "admin.signup_approval.issued",
      );
      assertMaria(h.calls);
    },
  );

  it("rejects an unregistered email without revoking or issuing any approval", async () => {
    const h = boundary();
    h.fixture.accountExists = false;
    await expect(h.approvals.issue(email, "student", adminId, requestId)).rejects.toMatchObject({
      status: 404,
      response: { code: "SIGNUP_ACCOUNT_NOT_FOUND" },
    });
    expect(statements(h.calls)).toHaveLength(1);
    expect(h.calls.some((call) => call.sql === "COMMIT")).toBe(false);
  });

  it.each([false, true])(
    "revokes only an open locked approval and audits exactly successful changes (present=%s)",
    async (present) => {
      const h = boundary();
      h.fixture.revocable = present;
      h.fixture.previousOpen = true;
      expect(await h.approvals.revoke(approvalId, adminId, requestId)).toEqual({
        revoked: present,
      });
      const business = statements(h.calls);
      expect(business[0]?.sql).toContain(
        "`consumed_at` is null and `revoked_at` is null for update",
      );
      if (!present) expect(business).toHaveLength(1);
      else {
        expect(business[1]?.sql).toContain("`consumed_at` is null and `revoked_at` is null");
        expect(business[2]?.parameters).toContain("revoke");
        expect(business[3]?.parameters).toContain(
          JSON.stringify({ role: "teacher", status: "active" }),
        );
        expect(business[3]?.parameters).toContain(
          JSON.stringify({ role: "teacher", status: "revoked" }),
        );
      }
      assertMaria(h.calls);
    },
  );

  it.each(["audit", "commit"] as const)(
    "does not return a code or retry after %s failure",
    async (stage) => {
      const h = boundary();
      const failure = new Error("synthetic private failure");
      h.fixture.fail = (call) =>
        (
          stage === "audit"
            ? call.sql.startsWith("insert into `admin_operation_audit_logs`")
            : call.sql === "COMMIT"
        )
          ? failure
          : undefined;
      await expect(h.approvals.issue(email, "teacher", adminId, requestId)).rejects.toBe(failure);
      expect(
        h.calls.filter((call) => call.sql.startsWith("insert into `admin_signup_approvals`")),
      ).toHaveLength(1);
      if (stage === "audit") expect(h.calls.some((call) => call.sql === "COMMIT")).toBe(false);
      else expect(h.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
    },
  );
});

describe("MariaDB administrator member search", () => {
  it("preserves pending approval, native BIGINT/booleans and public Date milliseconds", async () => {
    const h = boundary();
    expect(await h.users.list("  MeMbEr  ")).toEqual({
      truncated: false,
      users: [
        {
          id: userId,
          email,
          display_name: "Synthetic member",
          is_active: true,
          email_verified: false,
          signup_approved: false,
          created_at: new Date("2026-09-07T12:00:00.123Z"),
          updated_at: new Date("2026-09-07T12:00:00.123Z"),
        },
      ],
    });
    const query = statements(h.calls)[0]!;
    expect(query.sql).toContain("LOWER(email_normalized) LIKE LOWER(?) ESCAPE ?");
    expect(query.sql).toContain("LOWER(display_name) LIKE LOWER(?) ESCAPE ?");
    expect(query.sql).toContain("`deleted_at` is null");
    expect(query.sql).toContain("order by `updated_at` desc, `id` desc limit ?");
    expect(query.parameters).toEqual(["%MeMbEr%", "\\", "%MeMbEr%", "\\", 51]);
    assertMaria(h.calls);
  });

  it("masks emails for support-only administrators (C2-09, I2-04)", async () => {
    const h = boundary();
    const result = await h.users.list("member", { revealEmail: false });
    expect(result.users[0]?.email).not.toBe(email);
    expect(result.users[0]?.email).toMatch(/^.{1,2}\*\*\*@/u);
  });

  it("escapes literal percent/underscore/backslash and applies 50+1 cap", async () => {
    const h = boundary();
    h.fixture.users = Array.from({ length: 51 }, (_, index) => ({
      ...h.fixture.users[0],
      id: String(BigInt(userId) + BigInt(index)),
      is_active: 0,
      email_verified_at: timestamp,
      signup_approved_at: timestamp,
    }));
    const result = await h.users.list("%_\\");
    expect(result.truncated).toBe(true);
    expect(result.users).toHaveLength(50);
    expect(result.users[0]).toMatchObject({
      is_active: false,
      email_verified: true,
      signup_approved: true,
    });
    expect(statements(h.calls)[0]?.parameters).toEqual([
      "%\\%\\_\\\\%",
      "\\",
      "%\\%\\_\\\\%",
      "\\",
      51,
    ]);
  });

  it.each([" ", "a", "x".repeat(101)])(
    "rejects an invalid search before acquiring a connection",
    async (search) => {
      const h = boundary();
      await expect(h.users.list(search)).rejects.toMatchObject({ status: 400 });
      expect(h.calls).toHaveLength(0);
    },
  );
});
