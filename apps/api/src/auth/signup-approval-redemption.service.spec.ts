import "reflect-metadata";

import { Buffer } from "node:buffer";
import type { DB } from "@classhub/db";
import { ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalCodeDigest } from "../admin-signup-approval/admin-signup-approval.policy.js";
import type { AppEnvironment } from "../config/environment.js";
import { ALLOW_UNVERIFIED_EMAIL } from "./allow-unverified-email.decorator.js";
import { createPrivacySafeDigest } from "./auth-crypto.js";
import type { AuthConfig } from "./auth.types.js";
import { AuthenticatedCsrfGuard } from "./authenticated-csrf.guard.js";
import type { AuthenticatedFastifyRequest } from "./authenticated-request.js";
import {
  RedeemSignupApprovalDto,
  SignupApprovalRedemptionController,
} from "./signup-approval-redemption.controller.js";
import { SignupApprovalRedemptionService } from "./signup-approval-redemption.service.js";

const userId = "9007199255440011";
const adminId = "9007199255440012";
const approvalId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const email = "self@example.invalid";
const now = new Date("2026-09-07T01:02:03.444Z");
const config: AuthConfig = {
  agePolicyVersion: "age-1",
  emailHmacKey: "synthetic-redemption-unit-hmac-key",
  emailHmacKeyVersion: "unit",
  privacyPolicyVersion: "privacy-1",
  termsPolicyVersion: "terms-1",
};
type Engine = "postgres" | "mariadb";
type Row = Record<string, unknown>;
type Step = {
  table: string;
  kind: "select" | "insert into" | "update";
  rows?: Row[];
  affected?: bigint;
  error?: Error;
};
const select = (table: string, rows: Row[] = []): Step => ({ table, kind: "select", rows });
const write = (table: string, kind: "insert into" | "update", affected = 1n): Step => ({
  table,
  kind,
  affected,
});
const date = (engine: Engine, value = now): Date | string =>
  engine === "postgres" ? value : value.toISOString().replace("T", " ").replace("Z", "000");
const user = (engine: Engine, changes: Row = {}): Row => ({
  id: userId,
  email_normalized: email,
  email_verified_at: date(engine),
  signup_approved_at: null,
  signup_role: "student",
  is_active: engine === "postgres" ? true : 1,
  deleted_at: null,
  ...changes,
});
const approval = (engine: Engine, changes: Row = {}): Row => ({
  id: approvalId,
  issued_by_admin_account_id: adminId,
  expires_at: date(engine, new Date(now.getTime() + 60_000)),
  failed_attempts: 0,
  consumed_at: null,
  revoked_at: null,
  ...changes,
});

// Real Kysely dialect compilation and Maria row codec; scripted connection only.
// These transaction events do not claim actual DB persistence or concurrency verification.
function harness(engine: Engine, steps: Step[], allowed = true) {
  const queries: CompiledQuery[] = [],
    events: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          queries.push(query);
          const step = steps.shift();
          expect(step, "unexpected redemption query").toBeDefined();
          expect(query.sql).toMatch(
            new RegExp(
              "^" +
                step!.kind +
                (step!.kind === "select" ? " .* from " : " ") +
                '["`]' +
                step!.table +
                '["`]',
            ),
          );
          events.push(`${step!.kind}:${step!.table}`);
          if (engine === "mariadb") expect(query.sql).not.toMatch(/\breturning\b/iu);
          if (step!.error) throw step!.error;
          const rows =
            step!.rows ??
            (engine === "postgres" && /\breturning\b/u.test(query.sql) && step!.affected === 1n
              ? [{ id: step!.table === "users" ? userId : approvalId }]
              : []);
          return { rows, numAffectedRows: step!.affected } as QueryResult<R>;
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused stream");
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
    override async releaseConnection() {
      events.push("release");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => (engine === "mariadb" ? new MysqlAdapter() : new PostgresAdapter()),
      createIntrospector: (db) =>
        engine === "mariadb" ? new MysqlIntrospector(db) : new PostgresIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  const rateLimiter = {
    consume: vi.fn(async () => {
      events.push("rate");
      return { allowed, count: 1, limit: 10, remaining: 9, retryAfterSeconds: 60 };
    }),
  };
  const service = new SignupApprovalRedemptionService(
    database,
    config,
    rateLimiter as never,
    engine === "mariadb"
      ? new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine })
      : undefined,
  );
  return { service, queries, events, steps, rateLimiter };
}
function successSteps(engine: Engine, role: "student" | "teacher"): Step[] {
  return [
    select("users", [user(engine, { signup_role: role })]),
    select("admin_signup_approvals", [approval(engine)]),
    write("admin_signup_approvals", "update"),
    ...(role === "teacher"
      ? [select("teacher_profiles"), write("teacher_profiles", "insert into")]
      : []),
    write("users", "update"),
    write("admin_signup_approval_events", "insert into"),
  ];
}

describe.each(["postgres", "mariadb"] as const)("signup authority separation on %s", (engine) => {
  it.each(["student", "teacher"] as const)(
    "verifies email without self-granting a teacher profile (%s)",
    async (role) => {
      const h = harness(engine, [
        select("users", [user(engine, { signup_role: role, email_verified_at: null })]),
        select("admin_signup_approvals", [approval(engine, { issued_by_admin_account_id: null })]),
        write("admin_signup_approvals", "update"),
        write("users", "update"),
        write("admin_signup_approval_events", "insert into"),
      ]);
      await expect(h.service.redeem(userId, "123456", requestId)).resolves.toEqual({
        next_action: "BOOTSTRAP",
        signup_approved: role === "student",
      });
      expect(h.queries.some((query) => query.sql.includes("teacher_profiles"))).toBe(false);
      const update = h.queries[3]!;
      expect(update.sql.split(" where ")[0]).toContain("email_verified_at");
      expect(update.sql.split(" where ")[0]!.includes("signup_approved_at")).toBe(
        role === "student",
      );
      expect(h.queries[1]!.parameters[0]).toEqual(
        approvalCodeDigest(config.emailHmacKey, email, role, "123456", userId, "email"),
      );
      expect(h.events).toContain("commit");
    },
  );

  it("rejects an administrator code while email is unverified even if a forged row matches", async () => {
    const h = harness(engine, [
      select("users", [user(engine, { signup_role: "teacher", email_verified_at: null })]),
      select("admin_signup_approvals", [approval(engine)]),
    ]);
    await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
      response: { code: "SIGNUP_APPROVAL_INVALID" },
    });
    expect(h.queries.every((query) => query.sql.startsWith("select"))).toBe(true);
    expect(h.events).toContain("rollback");
  });

  it.each([true, false])(
    "rejects an exhausted code without increment or activation (correct=%s)",
    async (correct) => {
      const exhausted = approval(engine, { failed_attempts: 5 });
      const h = harness(engine, [
        select("users", [user(engine)]),
        select("admin_signup_approvals", correct ? [exhausted] : []),
        ...(correct ? [] : [select("admin_signup_approvals", [exhausted])]),
        write("admin_signup_approval_events", "insert into"),
      ]);
      await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
        response: { code: "SIGNUP_APPROVAL_INVALID" },
      });
      expect(h.queries.at(-1)!.parameters).toContain("approval_attempts_exhausted");
      expect(h.queries.some((query) => query.sql.startsWith("update"))).toBe(false);
      expect(h.events).toContain("commit");
    },
  );
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(now));
afterEach(() => vi.useRealTimers());

describe.each(["postgres", "mariadb"] as const)(
  "%s signup approval redemption boundaries",
  (engine) => {
    it("records a missing legacy role once without granting approval or teacher privileges", async () => {
      const h = harness(engine, [
        select("users", [user(engine, { signup_role: null })]),
        write("users", "update"),
      ]);
      await expect(h.service.confirmRole(userId, "teacher")).resolves.toEqual({
        signup_role: "teacher",
      });
      expect(h.steps).toHaveLength(0);
      expect(h.queries[1]!.sql).toMatch(/signup_role.*is null.*signup_approved_at.*is null/u);
      expect(h.queries.some((query) => query.sql.includes("teacher_profiles"))).toBe(false);
      expect(h.events).toContain("commit");
    });

    it("rejects changing a registered student into a teacher before any write", async () => {
      const h = harness(engine, [select("users", [user(engine)])]);
      await expect(h.service.confirmRole(userId, "teacher")).rejects.toMatchObject({
        response: { code: "SIGNUP_ROLE_ALREADY_SET" },
      });
      expect(h.queries).toHaveLength(1);
      expect(h.events).toContain("rollback");
    });

    it("does not guess an unrecorded role from a submitted approval number", async () => {
      const h = harness(engine, [select("users", [user(engine, { signup_role: null })])]);
      await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
        response: { code: "SIGNUP_ROLE_REQUIRED" },
      });
      expect(h.queries).toHaveLength(1);
    });

    it("looks up a wrong-type number only within the registered student role", async () => {
      const h = harness(engine, [
        select("users", [user(engine)]),
        select("admin_signup_approvals"),
        select("admin_signup_approvals"),
        write("admin_signup_approval_events", "insert into"),
      ]);
      await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
        response: { code: "SIGNUP_APPROVAL_INVALID" },
      });
      for (const query of h.queries.slice(1, 3)) {
        expect(query.parameters).toContain("student");
        expect(query.parameters).not.toContain("teacher");
      }
      expect(h.queries.some((query) => query.sql.includes("teacher_profiles"))).toBe(false);
      expect(h.events).toContain("commit");
    });

    it.each(["student", "teacher"] as const)(
      "approves the administrator-issued %s role in one transaction",
      async (role) => {
        const h = harness(engine, successSteps(engine, role));
        await expect(h.service.redeem(userId, "123456", requestId)).resolves.toEqual({
          next_action: "BOOTSTRAP",
          signup_approved: true,
        });
        expect(h.steps).toHaveLength(0);
        expect(h.events.slice(0, 3)).toEqual(["rate", "begin", "select:users"]);
        expect(h.events.slice(-2)).toEqual(["commit", "release"]);
        expect(h.events).not.toContain("rollback");
        expect(h.queries[0]!.sql).toMatch(/for update$/u);
        expect(h.queries[0]!.parameters).toEqual([userId]);
        expect(h.queries[1]!.sql).toMatch(/for update$/u);
        const emailDigest = Buffer.from(
          createPrivacySafeDigest(config.emailHmacKey, "admin-signup-approval-email", email),
          "base64url",
        );
        expect(h.queries[1]!.parameters).toEqual([
          approvalCodeDigest(config.emailHmacKey, email, role, "123456", userId, "approval"),
          emailDigest,
          role,
        ]);
        const consume = h.queries[2]!;
        expect(consume.sql).toMatch(/consumed_at.*is null.*revoked_at.*is null.*expires_at.*>/u);
        expect(consume.parameters).toContain(userId);
        const activate = h.queries.find(
          (query) => query.sql.startsWith("update") && /["`]users["`]/u.test(query.sql),
        )!;
        expect(activate.sql).toMatch(
          /signup_approved_at.*is null.*is_active.*=.*deleted_at.*is null/u,
        );
        expect(activate.parameters).toContainEqual(date(engine));
        const audit = h.queries.at(-1)!;
        expect(audit.parameters).toEqual(
          expect.arrayContaining([approvalId, requestId, "approved", role, userId]),
        );
        expect(h.queries.flatMap((query) => query.parameters)).not.toContain(email);
        expect(h.queries.flatMap((query) => query.parameters)).not.toContain("123456");
        const profile = h.queries.find((query) =>
          /^insert into ["`]teacher_profiles/u.test(query.sql),
        );
        if (role === "teacher")
          expect(profile?.parameters).toEqual(
            expect.arrayContaining([userId, adminId, "active", false]),
          );
        else expect(profile).toBeUndefined();
      },
    );

    it("commits a wrong-code attempt and its audit before the generic public denial", async () => {
      const h = harness(engine, [
        select("users", [user(engine, { signup_role: "teacher" })]),
        select("admin_signup_approvals"),
        select("admin_signup_approvals", [approval(engine, { failed_attempts: 4 })]),
        write("admin_signup_approvals", "update"),
        write("admin_signup_approval_events", "insert into"),
      ]);
      await expect(
        h.service.redeem(userId, "654321", requestId).catch((error: unknown) => {
          h.events.push("public-denial");
          throw error;
        }),
      ).rejects.toMatchObject({ response: { code: "SIGNUP_APPROVAL_INVALID" } });
      expect(h.steps).toHaveLength(0);
      expect(h.queries[2]!.sql).toMatch(/for update$/u);
      expect(h.queries[3]!.parameters).toEqual([5, approvalId, 4]);
      expect(h.queries.at(-1)!.parameters).toContain("approval_code_mismatch");
      expect(h.queries.at(-1)!.parameters).toContain("teacher");
      expect(h.events.indexOf("commit")).toBeLessThan(h.events.indexOf("public-denial"));
      expect(h.events).not.toContain("rollback");
      expect(h.queries.some((query) => /^update ["`]users|teacher_profiles/u.test(query.sql))).toBe(
        false,
      );
    });

    it.each(["expired", "revoked", "consumed"] as const)(
      "audits %s approval without charging or activating",
      async (kind) => {
        const changes: Record<typeof kind, Row> = {
          expired: { expires_at: date(engine) },
          revoked: { revoked_at: date(engine) },
          consumed: { consumed_at: date(engine) },
        };
        const expected = {
          expired: "approval_expired",
          revoked: "approval_revoked",
          consumed: "approval_consumed",
        };
        const h = harness(engine, [
          select("users", [user(engine)]),
          select("admin_signup_approvals", [approval(engine, changes[kind])]),
          write("admin_signup_approval_events", "insert into"),
        ]);
        await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
          response: { code: "SIGNUP_APPROVAL_INVALID" },
        });
        expect(h.steps).toHaveLength(0);
        expect(h.queries.at(-1)!.parameters).toContain(expected[kind]);
        expect(h.events).toContain("commit");
        expect(h.events).not.toContain("rollback");
        expect(h.queries.some((query) => query.sql.startsWith("update"))).toBe(false);
      },
    );

    it.each(["missing", "inactive", "deleted"] as const)(
      "stops a %s account before approval lookup",
      async (kind) => {
        const rows =
          kind === "missing"
            ? []
            : [
                user(
                  engine,
                  kind === "inactive"
                    ? { is_active: engine === "postgres" ? false : 0 }
                    : { deleted_at: date(engine) },
                ),
              ];
        const h = harness(engine, [select("users", rows)]);
        await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
          response: { code: "ACCOUNT_UNAVAILABLE" },
        });
        expect(h.queries).toHaveLength(1);
        expect(h.events).toContain("rollback");
        expect(h.events).not.toContain("commit");
      },
    );

    it("returns repeat success without consulting a different role code or creating a teacher profile", async () => {
      const h = harness(engine, [
        select("users", [user(engine, { signup_approved_at: date(engine) })]),
      ]);
      await expect(h.service.redeem(userId, "999999", requestId)).resolves.toEqual({
        next_action: "BOOTSTRAP",
        signup_approved: true,
      });
      expect(h.queries).toHaveLength(1);
      expect(h.events).toContain("commit");
    });

    it("rolls back prior code consumption and profile creation when activation loses its guard", async () => {
      const steps = successSteps(engine, "teacher");
      steps.splice(-2, 2, write("users", "update", 0n));
      const h = harness(engine, steps);
      await expect(h.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
        response: { code: "INTERNAL_ERROR" },
      });
      expect(h.steps).toHaveLength(0);
      expect(h.events).toContain("insert into:teacher_profiles");
      expect(h.events).toContain("rollback");
      expect(h.events).not.toContain("commit");
      expect(h.queries.some((query) => query.sql.includes("admin_signup_approval_events"))).toBe(
        false,
      );
    });

    it("rolls back when audit insertion fails and never retries the transaction", async () => {
      const error = new Error("synthetic audit insertion failure");
      const steps = successSteps(engine, "student");
      steps.at(-1)!.error = error;
      const h = harness(engine, steps);
      await expect(h.service.redeem(userId, "123456", requestId)).rejects.toBe(error);
      expect(h.events.filter((event) => event === "begin")).toHaveLength(1);
      expect(h.events).toContain("rollback");
      expect(h.events).not.toContain("commit");
    });

    it("rejects malformed codes and account throttling before acquiring a transaction", async () => {
      const invalid = harness(engine, []);
      await expect(invalid.service.redeem(userId, "12x456", requestId)).rejects.toMatchObject({
        response: { code: "SIGNUP_APPROVAL_INVALID" },
      });
      expect(invalid.events).toEqual([]);
      const limited = harness(engine, [], false);
      await expect(limited.service.redeem(userId, "123456", requestId)).rejects.toMatchObject({
        response: { code: "RATE_LIMITED" },
      });
      expect(limited.events).toEqual(["rate"]);
    });
  },
);

describe("signup approval controller identity boundary", () => {
  const pipe = new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true });
  it("accepts exactly a six-digit code and forbids caller email, role or user selection", async () => {
    const validate = (body: object) =>
      pipe.transform(body, { metatype: RedeemSignupApprovalDto, type: "body" });
    await expect(validate({ approval_code: "123456" })).resolves.toEqual({
      approval_code: "123456",
    });
    for (const extra of [
      { email: "other@example.invalid" },
      { role: "teacher" },
      { user_id: "99" },
    ])
      await expect(validate({ approval_code: "123456", ...extra })).rejects.toMatchObject({
        status: 400,
      });
    for (const approval_code of [123456, "12345", "１２３４５６", "12345a"])
      await expect(validate({ approval_code })).rejects.toMatchObject({ status: 400 });
  });
  it("requires the CSRF session guard and passes only its authenticated identity to the service", async () => {
    const confirm = SignupApprovalRedemptionController.prototype.confirm;
    expect(Reflect.getMetadata(GUARDS_METADATA, confirm)).toEqual([AuthenticatedCsrfGuard]);
    expect(Reflect.getMetadata(ALLOW_UNVERIFIED_EMAIL, confirm)).toBe(true);
    const redeem = vi.fn().mockResolvedValue({ next_action: "BOOTSTRAP", signup_approved: true });
    const controller = new SignupApprovalRedemptionController({ redeem } as never);
    const request = {
      id: requestId,
      authenticatedSession: { userId },
    } as AuthenticatedFastifyRequest;
    await controller.confirm({ approval_code: "123456" }, request);
    expect(redeem).toHaveBeenCalledExactlyOnceWith(userId, "123456", requestId);
    expect(() =>
      controller.confirm({ approval_code: "123456" }, {
        id: requestId,
      } as AuthenticatedFastifyRequest),
    ).toThrow();
    expect(redeem).toHaveBeenCalledOnce();
  });
});
