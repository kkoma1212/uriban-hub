import type { DB } from "@classhub/db";
import { createHash } from "node:crypto";
import {
  CONSENT_DOCUMENT_TYPES,
  type LegalConsentSnapshot,
} from "../../legal/legal-consent-snapshot.js";
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
import { AuthService } from "../auth.service.js";
import type { AuthConfig, SignUpCommand } from "../auth.types.js";
import type { AppEnvironment } from "../../config/environment.js";
import {
  authDateValue,
  authMariaDate,
  authNumericId,
  authUpdateSucceeded,
  isMariaSignupDuplicate,
} from "./auth-persistence.js";

vi.mock("../password-hasher.js", () => ({
  hashPassword: vi.fn().mockResolvedValue("synthetic-password-hash"),
}));
const now = "2026-09-07T01:02:03.444Z";
const clock = "2026-09-07 01:02:03.444987";
const future = "2026-09-08 01:02:03.444987";
const userId = "9007199255440001";
const guardianId = "22222222-2222-4222-8222-222222222222";
const config: AuthConfig = {
  agePolicyVersion: "age-1",
  emailHmacKey: "synthetic-unit-auth-hmac-key-only",
  emailHmacKeyVersion: "unit",
  privacyPolicyVersion: "privacy-1",
  termsPolicyVersion: "terms-1",
};
const requestContext = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userAgent: "synthetic-unit-agent",
};
const guardian = {
  approved_at: clock,
  consumed_at: null,
  expires_at: future,
  guardian_email_normalized: "guardian@example.invalid",
  id: guardianId,
  invalidated_at: null,
  privacy_policy_version: config.privacyPolicyVersion,
  terms_policy_version: config.termsPolicyVersion,
  user_id: null,
};
const command = (extra: Partial<SignUpCommand> = {}): SignUpCommand => ({
  age_route: "over_14",
  role: "student",
  consents: { terms: true, privacy: true },
  display_name: "QA student",
  email: "student@example.invalid",
  password: "Safe1234",
  ...extra,
});
type Row = Record<string, unknown>;
type Step = { sql: RegExp; result?: QueryResult<Row>; error?: unknown };
const select = (table: string, rows: Row[] = []): Step => ({
  sql: new RegExp("^select .* from `" + table + "`"),
  result: { rows },
});
const write = (
  verb: "insert into" | "update",
  table: string,
  count = 1n,
  insertId?: bigint,
): Step => ({
  sql: new RegExp("^" + verb + " `" + table + "`"),
  result: { rows: [], numAffectedRows: count, ...(insertId === undefined ? {} : { insertId }) },
});
const dbClock = (): Step => ({
  sql: /^SELECT UTC_TIMESTAMP\(6\) AS auth_clock$/u,
  result: { rows: [{ auth_clock: clock }] },
});
const duplicate = () =>
  Object.assign(new Error("private synthetic SQL/password/token payload"), {
    errno: 1062,
    sqlState: "23000",
    code: "ER_DUP_ENTRY",
  });

// Real Kysely MySQL compilation + row plugins, scripted driver boundaries only.
// The begin/commit/rollback events prove service ordering, not real DB durability.
function harness(
  steps: Step[],
  options: { commitError?: Error; mailFailure?: boolean; bindingRequired?: boolean } = {},
) {
  const events: string[] = [];
  const queries: CompiledQuery[] = [];
  class ScriptedDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
          events.push("query");
          queries.push(query);
          const next = steps.shift();
          expect(next, "unexpected auth query").toBeDefined();
          expect(query.sql).toMatch(next!.sql);
          expect(query.sql).not.toMatch(/\breturning\b|interval '/iu);
          if (next!.error) throw next!.error;
          return (next!.result ?? { rows: [] }) as QueryResult<R>;
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
      if (options.commitError) throw options.commitError;
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
      createDriver: () => new ScriptedDriver(),
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const rateLimiter = {
    consumeAll: vi.fn().mockResolvedValue({ allowed: true }),
    consume: vi.fn(async () => {
      events.push("rate");
      return { allowed: true, count: 1, limit: 10, remaining: 9, retryAfterSeconds: 60 };
    }),
    close: vi.fn(),
  };
  const deliver = async () => {
    events.push("mail");
    if (options.mailFailure) throw new Error("private SMTP credential");
  };
  const mailer = {
    sendGuardianConsentEmail: vi.fn(deliver),
    sendVerificationEmail: vi.fn(deliver),
  };
  const publisher = {
    publish: vi.fn(async () => {
      events.push("security_audit");
    }),
    close: vi.fn(),
  };
  const environment = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: "mariadb",
    LEGAL_CONSENT_BINDING_ENABLED: options.bindingRequired ?? false,
  });
  const service = new AuthService(
    database,
    rateLimiter as never,
    mailer,
    config,
    publisher,
    environment,
  );
  return { service, events, queries, steps, mailer, publisher, rateLimiter };
}
function signupSteps(_role: "student" | "teacher" = "student", withGuardian = false): Step[] {
  return [
    dbClock(),
    ...(withGuardian ? [select("guardian_consent_requests", [guardian])] : []),
    select("users"),
    write("insert into", "users", 1n, BigInt(userId)),
    select("users", [{ id: userId }]),
    write("insert into", "user_consents"),
    ...(withGuardian ? [write("update", "guardian_consent_requests")] : []),
  ];
}

const legalRows = () =>
  CONSENT_DOCUMENT_TYPES.map((type, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    document_type: type,
    policy_version: type + "-published-1",
    title: type,
    content: "합성 검증용 게시 문서 " + type,
    content_sha256: createHash("sha256")
      .update("합성 검증용 게시 문서 " + type)
      .digest(),
    effective_at: "2026-09-01 00:00:00.000000",
    published_at: "2026-09-01 00:00:00.000000",
  }));
const legalSnapshot = (): LegalConsentSnapshot =>
  Object.fromEntries(
    legalRows().map((row) => [
      row.document_type,
      {
        id: row.id,
        policy_version: row.policy_version,
        content_sha256: row.content_sha256.toString("hex"),
      },
    ]),
  ) as LegalConsentSnapshot;

describe("published legal document binding in MariaDB auth", () => {
  it("stores the exact four documents with explicit terms/privacy consents in one signup transaction", async () => {
    const steps = signupSteps();
    steps.splice(1, 0, select("admin_terms_versions", legalRows()));
    const target = harness(steps, { bindingRequired: true });
    await target.service.signUp(
      command({ legal_documents: legalSnapshot() }),
      "127.0.0.1",
      requestContext,
    );
    const writeQuery = target.queries.find((query) =>
      query.sql.startsWith("insert into `user_consents`"),
    )!;
    const encoded = JSON.stringify(legalSnapshot());
    expect(writeQuery.parameters.filter((value) => value === encoded)).toHaveLength(3);
    expect(writeQuery.parameters).toContain("terms-published-1");
    expect(writeQuery.parameters).toContain("privacy_consent-published-1");
    expect(writeQuery.parameters).not.toContain("privacy_policy");
    expect(
      target.queries.find((query) => query.sql.includes("from `admin_terms_versions`"))!.sql,
    ).toContain("for update");
    expect(target.events).toContain("commit");
  });
  it.each(CONSENT_DOCUMENT_TYPES)(
    "rejects changed %s evidence before creating a user",
    async (type) => {
      const stale = legalSnapshot();
      stale[type].content_sha256 = "f".repeat(64);
      const target = harness([dbClock(), select("admin_terms_versions", legalRows())], {
        bindingRequired: true,
      });
      await expect(
        target.service.signUp(command({ legal_documents: stale }), "127.0.0.1"),
      ).rejects.toMatchObject({ status: 409 });
      expect(target.events).toContain("rollback");
      expect(target.queries.some((query) => query.sql.startsWith("insert"))).toBe(false);
    },
  );
  it("does not collect or send guardian consent when one document is unpublished", async () => {
    const target = harness([select("admin_terms_versions", legalRows().slice(0, 3))], {
      bindingRequired: true,
    });
    await expect(
      target.service.requestGuardianConsent(
        "guardian@example.invalid",
        "127.0.0.1",
        legalSnapshot(),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(target.mailer.sendGuardianConsentEmail).not.toHaveBeenCalled();
  });
  it("persists the request snapshot before sending the guardian mail", async () => {
    const target = harness(
      [
        select("admin_terms_versions", legalRows()),
        write("insert into", "guardian_consent_requests"),
        select("guardian_consent_requests", [{ expires_at: future }]),
      ],
      { bindingRequired: true },
    );
    await target.service.requestGuardianConsent(
      "guardian@example.invalid",
      "127.0.0.1",
      legalSnapshot(),
    );
    expect(target.queries[1]!.parameters).toContain(JSON.stringify(legalSnapshot()));
    expect(target.events.indexOf("commit")).toBeLessThan(target.events.indexOf("mail"));
  });
  it("confirms an unchanged request only on an explicit confirmation", async () => {
    const target = harness(
      [
        dbClock(),
        select("admin_terms_versions", legalRows()),
        select("guardian_consent_requests", [
          { ...guardian, approved_at: null, document_snapshot: JSON.stringify(legalSnapshot()) },
        ]),
        write("update", "guardian_consent_requests"),
      ],
      { bindingRequired: true },
    );
    await expect(
      target.service.confirmGuardianConsent("a".repeat(43), legalSnapshot()),
    ).resolves.toEqual({ guardian_consent: true });
    expect(target.events).toContain("commit");
  });
  it.each(CONSENT_DOCUMENT_TYPES)(
    "rejects approval when the request's %s document differs",
    async (type) => {
      const stale = legalSnapshot();
      stale[type].content_sha256 = "f".repeat(64);
      const target = harness(
        [
          dbClock(),
          select("admin_terms_versions", legalRows()),
          select("guardian_consent_requests", [
            { ...guardian, approved_at: null, document_snapshot: JSON.stringify(stale) },
          ]),
        ],
        { bindingRequired: true },
      );
      await expect(
        target.service.confirmGuardianConsent("a".repeat(43), legalSnapshot()),
      ).rejects.toMatchObject({ status: 400 });
      expect(target.queries.some((query) => query.sql.startsWith("update"))).toBe(false);
    },
  );
  it.each([null, "{}"])(
    "rejects a legacy guardian proof without inventing missing evidence (%s)",
    async (value) => {
      const target = harness(
        [
          dbClock(),
          select("admin_terms_versions", legalRows()),
          select("guardian_consent_requests", [{ ...guardian, document_snapshot: value }]),
        ],
        { bindingRequired: true },
      );
      await expect(
        target.service.signUp(
          command({
            age_route: "guardian_consent",
            legal_documents: legalSnapshot(),
            guardian_consent: { request_id: guardianId, completion_token: "b".repeat(43) },
          }),
          "127.0.0.1",
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(target.queries.some((query) => query.sql.startsWith("insert"))).toBe(false);
    },
  );
  it("reports an approved request as expired after a policy-only change", async () => {
    const stale = legalSnapshot();
    stale.privacy_policy.content_sha256 = "f".repeat(64);
    const target = harness(
      [
        select("admin_terms_versions", legalRows()),
        select("guardian_consent_requests", [
          { ...guardian, document_snapshot: JSON.stringify(stale) },
        ]),
      ],
      { bindingRequired: true },
    );
    await expect(
      target.service.getGuardianConsentStatus({
        request_id: guardianId,
        completion_token: "b".repeat(43),
      }),
    ).resolves.toEqual({ status: "expired" });
  });
});
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date(now)));
afterEach(() => vi.useRealTimers());

describe("MariaDB AuthService query and transaction contracts", () => {
  it.each(["student", "teacher"] as const)(
    "creates only a pending %s signup without an approval code and accepts exactly 8 characters",
    async (role) => {
      const h = harness([
        dbClock(),
        select("users"),
        write("insert into", "users", 1n, BigInt(userId)),
        select("users", [{ id: userId }]),
        write("insert into", "user_consents"),
      ]);
      const pendingCommand = command({ role, password: "Rainy42!" });
      delete pendingCommand.approval_code;
      expect(pendingCommand.password).toHaveLength(8);
      expect(pendingCommand).not.toHaveProperty("approval_code");
      await expect(h.service.signUp(pendingCommand, "192.0.2.8", requestContext)).resolves.toEqual({
        next_action: "LOGIN",
        signup_delivery_status: "failed",
      });
      expect(h.steps).toHaveLength(0);
      const userInsert = h.queries.find((query) => query.sql.startsWith("insert into `users`"))!;
      const columns = userInsert.sql
        .slice(userInsert.sql.indexOf("(") + 1, userInsert.sql.indexOf(")"))
        .split(", ");
      expect(userInsert.parameters[columns.indexOf("`signup_approved_at`")]).toBeNull();
      expect(
        h.queries.some((query) =>
          /teacher_profiles|admin_signup_approvals|admin_signup_approval_events/u.test(query.sql),
        ),
      ).toBe(false);
      expect(h.events).toContain("commit");
      expect(h.events).not.toContain("rollback");
      expect(h.mailer.sendVerificationEmail).not.toHaveBeenCalled();
    },
  );
  it.each(["student", "teacher"] as const)(
    "signs up %s with exact large user ID and original consent policy",
    async (role) => {
      const h = harness(signupSteps(role));
      await expect(
        h.service.signUp(command({ role }), "2001:0DB8:0:0::1", requestContext),
      ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });
      expect(h.steps).toHaveLength(0);
      expect(h.events.slice(0, 3)).toEqual(["rate", "rate", "begin"]);
      expect(h.events).toContain("commit");
      expect(h.events).not.toContain("rollback");
      expect(h.mailer.sendVerificationEmail).not.toHaveBeenCalled();
      const user = h.queries.find((query) => query.sql.startsWith("insert into `users`"))!;
      expect(user.parameters).toContain(null);
      expect(user.parameters).toContain("nfc_v1");
      const consents = h.queries.find((query) =>
        query.sql.startsWith("insert into `user_consents`"),
      )!;
      expect(consents.sql.match(/INET6_NTOA\(INET6_ATON\(\?\)\)/gu)).toHaveLength(3);
      expect(consents.parameters.filter((value) => value === userId)).toHaveLength(3);
      expect(consents.parameters).toContain("age_over_14");
      expect(
        h.queries.flatMap((query) => query.parameters).some((value) => value instanceof Date),
      ).toBe(false);
      expect(h.queries.some((query) => query.sql.includes("teacher_profiles"))).toBe(false);
    },
  );
  it("consumes guardian proof with the pending signup with one DB6 transaction clock", async () => {
    const h = harness(signupSteps("student", true));
    const reference = { completion_token: "a".repeat(43), request_id: guardianId };
    await expect(
      h.service.signUp(
        command({ age_route: "guardian_consent", guardian_consent: reference }),
        "192.0.2.3",
        requestContext,
      ),
    ).resolves.toEqual({ next_action: "LOGIN", signup_delivery_status: "failed" });
    const consumed = h.queries.find((query) =>
      query.sql.startsWith("update `guardian_consent_requests`"),
    )!;
    expect(consumed.parameters.filter((value) => value === clock)).toHaveLength(2);
    expect(consumed.parameters).toContain(userId);
    expect(h.queries.flatMap((query) => query.parameters)).not.toContain(
      reference.completion_token,
    );
    expect(
      h.queries.find((query) => query.sql.startsWith("insert into `user_consents`"))!.parameters,
    ).not.toContain("age_over_14");
  });
  it("guardian consume CAS failure rolls back user, consents and approval work", async () => {
    const steps = signupSteps("student", true);
    steps.splice(-1, 1, write("update", "guardian_consent_requests", 0n));
    const h = harness(steps);
    await expect(
      h.service.signUp(
        command({
          age_route: "guardian_consent",
          guardian_consent: { completion_token: "a".repeat(43), request_id: guardianId },
        }),
        "192.0.2.3",
      ),
    ).rejects.toMatchObject({ response: { code: "TOKEN_INVALID_OR_EXPIRED" } });
    expect(h.steps).toHaveLength(0);
    expect(h.events).toContain("rollback");
    expect(h.events).not.toContain("commit");
  });
  it.each([true, false])(
    "maps users INSERT duplicate only after rollback and active email confirmation (%s)",
    async (confirmed) => {
      const steps = signupSteps().slice(0, 3);
      steps[2] = { sql: /^insert into `users`/u, error: duplicate() };
      steps.push(select("users", confirmed ? [{ id: userId }] : []));
      const h = harness(steps);
      await expect(h.service.signUp(command(), "192.0.2.4")).rejects.toMatchObject({
        response: { code: confirmed ? "EMAIL_ALREADY_REGISTERED" : "INTERNAL_ERROR" },
      });
      const rollback = h.events.indexOf("rollback");
      expect(rollback).toBeGreaterThan(-1);
      expect(h.events.slice(rollback + 1)).toContain("query");
      expect(h.events).not.toContain("commit");
      expect(h.steps).toHaveLength(0);
    },
  );
  it("a consent INSERT failure rolls back and is never treated as an email duplicate", async () => {
    const steps = signupSteps();
    steps[steps.length - 1] = {
      sql: /^insert into `user_consents`/u,
      error: duplicate(),
    };
    const h = harness(steps);
    await expect(h.service.signUp(command(), "192.0.2.5")).rejects.not.toMatchObject({
      response: { code: "SIGNUP_APPROVAL_INVALID" },
    });
    expect(h.events).toContain("rollback");
    expect(h.events).not.toContain("commit");
    expect(h.steps).toHaveLength(0);
  });
  it.each([false, true])(
    "guardian request commits exact expiry before mail; mail failure=%s",
    async (mailFailure) => {
      const h = harness(
        [
          write("insert into", "guardian_consent_requests"),
          select("guardian_consent_requests", [{ expires_at: future }]),
        ],
        { mailFailure },
      );
      const result = await h.service.requestGuardianConsent(
        " Guardian@Example.invalid ",
        "192.0.2.6",
      );
      expect(result.consent_delivery_status).toBe(mailFailure ? "failed" : "sent");
      expect(result.expires_at).toBe("2026-09-08T01:02:03.444Z");
      expect(result.completion_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(h.events.indexOf("commit")).toBeLessThan(h.events.indexOf("mail"));
      expect(h.queries[0]!.sql).toContain("DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 24 HOUR)");
      expect(h.queries.flatMap((query) => query.parameters)).not.toContain(result.completion_token);
    },
  );
  it("uncertain guardian COMMIT prevents mail and is not retried", async () => {
    const h = harness(
      [
        write("insert into", "guardian_consent_requests"),
        select("guardian_consent_requests", [{ expires_at: future }]),
      ],
      { commitError: new Error("synthetic commit failure") },
    );
    await expect(
      h.service.requestGuardianConsent("guardian@example.invalid", "192.0.2.7"),
    ).rejects.toThrow();
    expect(h.events.filter((event) => event === "begin")).toHaveLength(1);
    expect(h.mailer.sendGuardianConsentEmail).not.toHaveBeenCalled();
  });
  it.each([1n, 0n])(
    "confirms guardian with one timestamp or rejects raced consumption (%s)",
    async (count) => {
      const h = harness([
        dbClock(),
        select("guardian_consent_requests", [{ ...guardian, approved_at: null }]),
        write("update", "guardian_consent_requests", count),
      ]);
      const result = h.service.confirmGuardianConsent("a".repeat(43));
      if (count) await expect(result).resolves.toEqual({ guardian_consent: true });
      else
        await expect(result).rejects.toMatchObject({
          response: { code: "TOKEN_INVALID_OR_EXPIRED" },
        });
      expect(h.queries.at(-1)!.parameters.filter((value) => value === clock)).toHaveLength(2);
      expect(h.events).toContain(count ? "commit" : "rollback");
    },
  );
  it.each(["pending", "approved", "expired"] as const)(
    "decodes guardian status as %s",
    async (status) => {
      const h = harness([
        select("guardian_consent_requests", [
          {
            ...guardian,
            approved_at: status === "pending" ? null : clock,
            expires_at: status === "expired" ? "2026-09-06 00:00:00.000001" : future,
          },
        ]),
      ]);
      await expect(
        h.service.getGuardianConsentStatus({
          completion_token: "b".repeat(43),
          request_id: guardianId,
        }),
      ).resolves.toEqual({ status });
    },
  );
  it("confirms email under user then token locks and binds the same DB6 timestamp", async () => {
    const h = harness([
      select("email_verification_tokens", [{ id: "44", user_id: userId }]),
      dbClock(),
      select("users", [{ deleted_at: null, email_verified_at: null, is_active: 1 }]),
      select("email_verification_tokens", [
        { expires_at: future, used_at: null, invalidated_at: null },
      ]),
      write("update", "email_verification_tokens"),
      write("update", "users"),
    ]);
    await expect(h.service.confirmEmail("c".repeat(43))).resolves.toEqual({
      email_verified: true,
      next_action: "LOGIN",
    });
    expect(h.queries[2]!.sql).toMatch(/for update$/u);
    expect(h.queries[3]!.sql).toMatch(/for update$/u);
    expect(h.queries[4]!.parameters.filter((value) => value === clock)).toHaveLength(2);
    expect(h.queries[5]!.parameters.filter((value) => value === clock)).toHaveLength(2);
    expect(h.events).toContain("commit");
  });
  it("MariaDB numeric false rejects an inactive email-verification account before token work", async () => {
    const h = harness([
      select("email_verification_tokens", [{ id: "44", user_id: userId }]),
      dbClock(),
      select("users", [{ deleted_at: null, email_verified_at: null, is_active: 0 }]),
    ]);
    await expect(h.service.confirmEmail("c".repeat(43))).rejects.toMatchObject({
      response: { code: "TOKEN_INVALID_OR_EXPIRED" },
    });
    expect(h.events).toContain("rollback");
    expect(h.steps).toHaveLength(0);
  });
  it("resend commits token replacement before SMTP failure/security audit", async () => {
    const h = harness(
      [
        select("users", [
          {
            deleted_at: null,
            email_verified_at: null,
            is_active: 1,
            email_normalized: "student@example.invalid",
          },
        ]),
        select("email_verification_tokens", [{ id: "44" }]),
        write("update", "email_verification_tokens"),
        write("insert into", "email_verification_tokens"),
      ],
      { mailFailure: true },
    );
    await expect(
      h.service.resendVerification(userId, "192.0.2.8", requestContext),
    ).resolves.toEqual({ verification_delivery_status: "failed" });
    expect(h.events.indexOf("commit")).toBeLessThan(h.events.indexOf("mail"));
    expect(h.events.indexOf("mail")).toBeLessThan(h.events.indexOf("security_audit"));
    expect(h.queries[2]!.parameters).toContain("2026-09-07 01:02:03.444000");
    expect(h.queries[3]!.parameters).toContain("2026-09-08 01:02:03.444000");
    expect(JSON.stringify(h.publisher.publish.mock.calls)).not.toContain("student@example.invalid");
    expect(h.events).not.toContain("rollback");
  });
  it("resend token insertion failure prevents mail and delivery-failure audit", async () => {
    const h = harness([
      select("users", [
        {
          deleted_at: null,
          email_verified_at: null,
          is_active: 1,
          email_normalized: "student@example.invalid",
        },
      ]),
      select("email_verification_tokens"),
      write("update", "email_verification_tokens", 0n),
      { sql: /^insert into `email_verification_tokens`/u, error: duplicate() },
    ]);
    await expect(h.service.resendVerification(userId, "192.0.2.9")).rejects.toThrow();
    expect(h.events).toContain("rollback");
    expect(h.events).not.toContain("commit");
    expect(h.mailer.sendVerificationEmail).not.toHaveBeenCalled();
    expect(h.publisher.publish).not.toHaveBeenCalled();
  });
});

describe("Auth MariaDB storage boundaries", () => {
  it("preserves numeric ID precision and truncates DB6 only at the Date read boundary", () => {
    expect(authNumericId(userId)).toBe(userId);
    expect(authMariaDate("2024-02-29 01:02:03.444999").toISOString()).toBe(
      "2024-02-29T01:02:03.444Z",
    );
    for (const value of [
      "2026-02-29 00:00:00.000000",
      "2026-01-01 24:00:00.000000",
      "2026-01-01T00:00:00Z",
      null,
    ])
      expect(() => authMariaDate(value)).toThrow();
    for (const value of [9007199254740992, "01", "9223372036854775808", null])
      expect(() => authNumericId(value)).toThrow();
    expect(() => authDateValue(new Date("invalid"), true)).toThrow();
  });
  it("only accepts a single affected-row result and strict native duplicate tuple", () => {
    expect(authUpdateSucceeded({ numUpdatedRows: 0n } as never)).toBe(false);
    expect(authUpdateSucceeded({ numUpdatedRows: 1n } as never)).toBe(true);
    for (const count of [2n, 1, "1", undefined])
      expect(() => authUpdateSucceeded({ numUpdatedRows: count } as never)).toThrow();
    expect(isMariaSignupDuplicate(duplicate())).toBe(true);
    for (const error of [
      { errno: 1062, sqlState: "23000" },
      { cause: duplicate() },
      new Proxy(duplicate(), {}),
      { errno: 1062, sqlState: "40001", code: "ER_DUP_ENTRY" },
    ])
      expect(isMariaSignupDuplicate(error)).toBe(false);
    const getter = {
      get errno() {
        throw new Error("must not read accessor");
      },
    };
    expect(isMariaSignupDuplicate(getter)).toBe(false);
  });
});
