import { createMariaDbDatabase, NFC_PASSWORD_INPUT_VERSION, type DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import { Kysely, PostgresDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hasher = vi.hoisted(() => ({ hashPassword: vi.fn(), verifyPassword: vi.fn() }));
vi.mock("../../auth/password-hasher.js", () => hasher);

import { NewPasswordRejectedException, UnauthenticatedException } from "../../auth/auth.errors.js";
import { RateLimitServiceUnavailableException } from "../../common/rate-limit/rate-limit.errors.js";
import type { AppEnvironment } from "../../config/environment.js";
import {
  AccountProfileBlockedException,
  AccountDeletionBlockedByClassException,
  InvalidCurrentPasswordException,
} from "../account.errors.js";
import { AccountService } from "../account.service.js";
import { DELETED_GUARDIAN_EMAIL } from "../guardian-consent-minimization.js";
import { mapMariaDbAccountError } from "./account-errors.js";

type Step = { rows?: Record<string, unknown>[]; error?: unknown; affectedRows?: number };
const userId = "9007199254740993",
  sessionId = "9007199254740995";
const classId = "9007199254740997",
  memberId = "9007199254740999";
const rawNow = "2026-09-07 00:00:00.123999";
const now = new Date("2026-09-07T00:00:00.123Z");
const future = "2026-09-08 00:00:00.123999";
const nextPassword = "Changed7";
const databases: Kysely<DB>[] = [];
const isProductQuery = (statement: string) =>
  /^\s*(?:select|insert|update|delete|call)\b/iu.test(statement);

function boundary(
  steps: Step[],
  engine: "mariadb" | "postgres" = "mariadb",
  config: Partial<Record<keyof AppEnvironment, unknown>> = {},
) {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const release = vi.fn(),
    destroy = vi.fn();
  const state: { commitError?: unknown; rollbackError?: unknown } = {};
  let started = false;
  function response(statement: string, parameters: readonly unknown[]): Step {
    statements.push({ sql: statement, parameters });
    if (/^(?:START TRANSACTION|begin)/iu.test(statement)) started = true;
    if (/^commit$/iu.test(statement)) return { error: state.commitError };
    if (/^rollback$/iu.test(statement) && started) return { error: state.rollbackError };
    if (!isProductQuery(statement)) return {};
    const step = steps.shift();
    if (!step) return { error: new Error("Unexpected boundary query") };
    return step;
  }
  const database =
    engine === "mariadb"
      ? createMariaDbDatabase<DB>(
          () => ({
            getConnection(callback) {
              callback(null, {
                query(statement, parameters, reply) {
                  const step = response(statement, parameters);
                  reply(
                    step.error,
                    step.rows ?? { affectedRows: step.affectedRows ?? 1, insertId: 0 },
                  );
                },
                release,
                destroy,
              });
            },
            end: (callback) => callback(null),
          }),
          {
            host: "mariadb.test.invalid",
            database: "synthetic_account",
            user: "synthetic_app",
            password: "synthetic",
            sslCa: "-----BEGIN CERTIFICATE-----\nsynthetic fixture",
          },
        )
      : new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: {
              connect: async () => ({
                query: async (statement: string, parameters: readonly unknown[] = []) => {
                  const step = response(statement, parameters);
                  if (step.error) throw step.error;
                  return {
                    rows: step.rows ?? [],
                    rowCount: step.affectedRows ?? 1,
                    command: statement.trim().split(" ")[0]?.toUpperCase(),
                  };
                },
                release,
              }),
              end: async () => undefined,
            } as never,
          }),
        });
  databases.push(database);
  const rateLimiter = {
    ensureAvailable: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const securityMailer = {
    sendSecurityChange: vi.fn(async () => {
      statements.push({ sql: "NOTICE", parameters: [] });
      return "accepted" as const;
    }),
  };
  const service = new AccountService(
    database,
    rateLimiter as never,
    { emailHmacKey: "synthetic-account-test-key", emailHmacKeyVersion: "test" } as never,
    publisher as never,
    engine === "mariadb"
      ? new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb", ...config })
      : undefined,
    securityMailer,
  );
  return {
    service,
    database,
    steps,
    statements,
    rateLimiter,
    publisher,
    securityMailer,
    release,
    destroy,
    state,
    queries: () => statements.filter(({ sql }) => isProductQuery(sql)),
    commits: () => statements.filter(({ sql }) => /^commit$/iu.test(sql)).length,
    rollbacks: () => statements.filter(({ sql }) => /^rollback$/iu.test(sql)).length,
  };
}

const user = (overrides: Record<string, unknown> = {}) => ({
  deleted_at: null,
  is_active: 1,
  display_name: "합성 이름",
  email_normalized: "account@example.invalid",
  email_verified_at: rawNow,
  updated_at: rawNow,
  password_hash: "synthetic-existing-hash",
  password_input_version: NFC_PASSWORD_INPUT_VERSION,
  ...overrides,
});
const session = (overrides: Record<string, unknown> = {}) => ({
  expires_at: future,
  revoked_at: null,
  ...overrides,
});
const profileCommand = { userId, sessionId, displayName: "새 표시명" };
const passwordCommand = {
  userId,
  sessionId,
  currentPassword: "synthetic current password",
  newPassword: nextPassword,
  clientIp: "203.0.113.19",
};
const deletionCommand = {
  userId,
  sessionId,
  currentPassword: "synthetic current password",
  confirmation: "탈퇴",
  clientIp: "203.0.113.19",
  requestId: "11111111-1111-4111-8111-111111111111",
  userAgent: undefined,
};
const member = {
  id: memberId,
  class_id: classId,
  role: "student",
  status: "approved",
  row_version: "9007199254741001",
};

function deletionSteps(withMember = true): Step[] {
  return [
    { rows: [user()] },
    { rows: [session()] },
    { rows: [{ now: rawNow }] },
    { rows: [] }, // 프로필 사진 표 설치 여부(미설치)
    { rows: [] }, // 알림 구독 표 설치 여부(미설치, 2026-10-03 탈퇴 시 구독 삭제)
    { rows: withMember ? [member] : [] },
    {},
    { rows: [{ actor_class_id: withMember ? classId : null, occurred_raw: rawNow }] },
    { rows: [{ id: userId }] },
    {
      rows: withMember
        ? [
            {
              ...member,
              status: "account_deleted",
              row_version: "9007199254741002",
              display_name_in_class: null,
              student_number: null,
              changed_raw: rawNow,
              updated_raw: rawNow,
            },
          ]
        : [],
    },
    ...(withMember ? [{ rows: [{ id: "991" }] }] : []),
    { rows: [] },
    { rows: [] },
    ...(withMember ? [{}] : []),
    {},
    {},
    {},
    {},
    ...(withMember ? [{}, {}, {}] : []),
    {},
    {},
  ];
}

function postgresDeletionSteps(guardian: Step = {}, finalUser: Step = { rows: [{ id: userId }] }) {
  return [
    { rows: [user({ is_active: true })] },
    { rows: [session({ expires_at: new Date(future.replace(" ", "T") + "Z") })] },
    { rows: [{ now }] },
    { rows: [] }, // 프로필 사진 표 설치 여부(미설치)
    { rows: [] }, // 알림 구독 표 설치 여부(미설치, 2026-10-03 탈퇴 시 구독 삭제)
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    {},
    {},
    {},
    ...Array.from({ length: 6 }, () => ({ rows: [{ exists: false }] })),
    {},
    guardian,
    finalUser,
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  hasher.hashPassword.mockReset().mockResolvedValue("synthetic-new-hash");
  hasher.verifyPassword.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
  vi.useRealTimers();
});

describe("AccountService MariaDB SQL and transaction boundary", () => {
  it("keeps PostgreSQL default Date/RETURNING and profile lock order", async () => {
    const probe = boundary(
      [
        { rows: [user({ is_active: true, updated_at: now })] },
        { rows: [] },
        { rows: [session({ expires_at: new Date(future.replace(" ", "T") + "Z") })] },
        { rows: [{ now }] },
        { rows: [{ display_name: "새 표시명", updated_at: now }] },
      ],
      "postgres",
    );
    await expect(probe.service.updateProfile(profileCommand)).resolves.toEqual({
      display_name: "새 표시명",
      profile_updated: true,
      updated_at: now.toISOString(),
    });
    expect(probe.queries().map(({ sql }) => sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('returning "display_name", "updated_at"'),
        expect.stringContaining("clock_timestamp()"),
      ]),
    );
    expect(probe.commits()).toBe(1);
  });

  it("locks users→teacher profile→own session; updates and reads back under the same transaction", async () => {
    const probe = boundary([
      { rows: [user()] },
      { rows: [{ status: "active", temporary_password_must_change: 0 }] },
      { rows: [session()] },
      { rows: [{ now: rawNow }] },
      {},
      { rows: [{ display_name: "새 표시명", updated_at: rawNow }] },
    ]);
    await expect(probe.service.updateProfile(profileCommand)).resolves.toEqual({
      display_name: "새 표시명",
      profile_updated: true,
      updated_at: now.toISOString(),
    });
    const queries = probe.queries();
    expect(queries.slice(0, 3).map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/from `users`.*for update$/u),
      expect.stringMatching(/from `teacher_profiles`.*for update$/u),
      expect.stringMatching(/from `sessions`.*`user_id` = \?.*for update$/u),
    ]);
    expect(queries[2]?.parameters).toEqual([sessionId, userId]);
    expect(queries[3]?.sql).toContain("UTC_TIMESTAMP(6)");
    expect(queries[4]?.parameters).toContainEqual(now);
    expect(queries.some(({ sql }) => /returning|clock_timestamp|to_regclass/u.test(sql))).toBe(
      false,
    );
    expect(probe.commits()).toBe(1);
    expect(probe.steps).toHaveLength(0);
  });

  it("preserves no-op timestamps and rejects temporary-password accounts even for no-op", async () => {
    const steps = [
      { rows: [user()] },
      { rows: [] },
      { rows: [session()] },
      { rows: [{ now: rawNow }] },
    ];
    const probe = boundary(steps);
    await expect(
      probe.service.updateProfile({ ...profileCommand, displayName: " 합성 이름 " }),
    ).resolves.toEqual({
      display_name: "합성 이름",
      profile_updated: false,
      updated_at: now.toISOString(),
    });
    expect(probe.queries()).toHaveLength(4);
    const blocked = boundary([
      { rows: [user()] },
      { rows: [{ status: "active", temporary_password_must_change: 1 }] },
      { rows: [session()] },
      { rows: [{ now: rawNow }] },
    ]);
    await expect(
      blocked.service.updateProfile({ ...profileCommand, displayName: "합성 이름" }),
    ).rejects.toBeInstanceOf(AccountProfileBlockedException);
    expect(blocked.commits()).toBe(0);
  });

  it.each(["2026-02-30 00:00:00.000000", "2026-09-07 00:00:00.123", new Date(), null])(
    "fails closed on malformed date %s",
    async (updated_at) => {
      const probe = boundary([{ rows: [user({ updated_at })] }]);
      await expect(probe.service.updateProfile(profileCommand)).rejects.toMatchObject({
        status: 500,
      });
      expect(probe.commits()).toBe(0);
      expect(probe.rollbacks()).toBeGreaterThan(1);
    },
  );

  it("rejects string booleans and sessions expiring in the current PG-compatible millisecond", async () => {
    const malformed = boundary([{ rows: [user({ is_active: "0" })] }]);
    await expect(malformed.service.updateProfile(profileCommand)).rejects.toMatchObject({
      status: 500,
    });
    const expired = boundary([
      { rows: [user()] },
      { rows: [] },
      { rows: [session({ expires_at: rawNow })] },
      { rows: [{ now: rawNow }] },
    ]);
    await expect(expired.service.updateProfile(profileCommand)).rejects.toBeInstanceOf(
      UnauthenticatedException,
    );
    expect(expired.commits()).toBe(0);
  });

  it("changes NFC password input, clears temporary-password gates and revokes every unrevoked session", async () => {
    const probe = boundary([
      { rows: [user()] },
      { rows: [user()] },
      { rows: [session()] },
      {},
      {},
      {},
    ]);
    await expect(probe.service.changePassword(passwordCommand)).resolves.toEqual({
      next_action: "LOGIN",
      password_changed: true,
    });
    expect(hasher.verifyPassword).toHaveBeenCalledExactlyOnceWith(
      passwordCommand.currentPassword,
      "synthetic-existing-hash",
    );
    const queries = probe.queries();
    expect(queries[3]?.parameters).toContain(NFC_PASSWORD_INPUT_VERSION);
    expect(queries[4]?.sql).toContain("`temporary_password_must_change` = ?");
    expect(queries[5]?.sql).toContain("where `user_id` = ? and `revoked_at` is null");
    expect(queries[5]?.parameters).toEqual([now, userId]);
    expect(probe.commits()).toBe(1);
    expect(probe.securityMailer.sendSecurityChange).toHaveBeenCalledExactlyOnceWith({
      email: "account@example.invalid",
      kind: "password_changed",
      occurredAt: now,
    });
    expect(probe.statements.at(-1)?.sql).toBe("NOTICE");
  });

  it.each(["unverified", "commit-failure"] as const)(
    "does not send a security notice for %s",
    async (failure) => {
      const account = user({ email_verified_at: failure === "unverified" ? null : rawNow });
      const probe = boundary([
        { rows: [account] },
        { rows: [account] },
        { rows: [session()] },
        {},
        {},
        {},
      ]);
      if (failure === "commit-failure") {
        probe.state.commitError = new Error("synthetic commit failure");
        await expect(probe.service.changePassword(passwordCommand)).rejects.toThrow();
      } else await probe.service.changePassword(passwordCommand);
      expect(probe.securityMailer.sendSecurityChange).not.toHaveBeenCalled();
    },
  );

  it("rechecks new-password policy against identity read after acquiring the user lock", async () => {
    const probe = boundary([
      { rows: [user()] },
      { rows: [user({ display_name: nextPassword })] },
      { rows: [session()] },
    ]);
    await expect(probe.service.changePassword(passwordCommand)).rejects.toBeInstanceOf(
      NewPasswordRejectedException,
    );
    expect(hasher.hashPassword).toHaveBeenCalledOnce();
    expect(hasher.verifyPassword).toHaveBeenCalledOnce();
    expect(probe.queries().some(({ sql }) => /^update/iu.test(sql))).toBe(false);
    expect(probe.commits()).toBe(0);
  });

  it("uses HMAC rate-limit subject and rolls back when Redis fails while recording a bad password", async () => {
    hasher.verifyPassword.mockResolvedValue(false);
    const probe = boundary([{ rows: [user()] }, { rows: [user()] }, { rows: [session()] }]);
    probe.rateLimiter.consume.mockRejectedValue(
      new RateLimitServiceUnavailableException(new Error("private-redis-secret")),
    );
    const error = await probe.service
      .changePassword(passwordCommand)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RateLimitServiceUnavailableException);
    expect(JSON.stringify(error)).not.toContain("private-redis-secret");
    expect(probe.rateLimiter.consume.mock.calls[0]?.[0]).toEqual({
      key: expect.stringMatching(
        new RegExp(`^password-change-failure:user:${userId}:ip:test:[A-Za-z0-9_-]{43}$`, "u"),
      ),
    });
    expect(JSON.stringify(probe.rateLimiter.consume.mock.calls)).not.toContain(
      passwordCommand.clientIp,
    );
    expect(probe.commits()).toBe(0);
  });

  it("deletes via the protected routine, verifies exact BIGINT/OUT/history and cleans PII without deleting tallies", async () => {
    const probe = boundary(deletionSteps());
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toEqual({
      account_deleted: true,
      next_action: "LOGIN",
    });
    expect(probe.steps).toHaveLength(0);
    expect(probe.commits()).toBe(1);
    const queries = probe.queries();
    expect(queries[3]?.sql).toContain("user_profile_photos");
    expect(queries[4]?.sql).toContain("push_subscriptions");
    expect(queries[5]?.sql).not.toContain("for update");
    expect(queries[6]?.parameters.slice(0, 2)).toEqual([userId, `[${classId}]`]);
    expect(queries[6]?.parameters[2]).toMatch(/^deleted\$/u);
    expect(queries.some(({ sql }) => /UPDATE (?:`?users|`?class_members)/iu.test(sql))).toBe(false);
    const sqlText = queries.map(({ sql }) => sql).join("\n");
    for (const table of ["student_assessment_records", "poll_votes", "election_participants"])
      expect(sqlText).toContain(`delete from \`${table}\``);
    expect(sqlText).not.toMatch(/seat_draw|team_draw|duty_/u);
    expect(sqlText).toContain("update `election_candidates`");
    expect(sqlText).not.toContain("delete from `election_candidates`");
    expect(sqlText).not.toContain("election_tallies");
    const consent = queries.find(({ sql }) => sql.startsWith("update `user_consents`"));
    expect(consent?.parameters).toEqual([
      null,
      now,
      new Date(now.getTime() + 365 * 86400000),
      userId,
    ]);
    expect(consent?.sql).toContain("`withdrawn_at` is null and `retention_expires_at` is null");
    const guardian = queries.find(({ sql }) =>
      sql.startsWith("update `guardian_consent_requests`"),
    );
    expect(guardian?.parameters).toEqual([DELETED_GUARDIAN_EMAIL, null, null, userId]);
    expect(guardian?.sql).toBe(
      "update `guardian_consent_requests` set `guardian_email_normalized` = ?, `approval_token_hash` = ?, `completion_token_hash` = ? where `user_id` = ? and `consumed_at` is not null",
    );
    const audit = queries.find(({ sql }) => sql.includes("INSERT INTO audit_logs"));
    expect(audit?.parameters).toContain(rawNow);
    expect(JSON.stringify(audit?.parameters)).not.toContain("합성 이름");
    expect(probe.publisher.publish).toHaveBeenCalledOnce();
    expect(probe.publisher.publish.mock.calls[0]?.[0]).toMatchObject({
      action: "account.deleted",
      actor_class_id: classId,
      actor_email_hmac: null,
      occurred_at: now.toISOString(),
    });
  });

  // 2026-10-03 사용자 결정(보관기간 ①): 처리방침대로 계정 삭제 때 알림 구독을 즉시 지운다.
  it("deletes the user's push subscriptions in the same transaction when the push table is installed", async () => {
    const steps = deletionSteps(false);
    steps.splice(4, 1, { rows: [{ installed: 1 }] }, { affectedRows: 2 });
    const probe = boundary(steps);
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    expect(probe.steps).toHaveLength(0);
    const pushDelete = probe.queries()[5];
    expect(pushDelete?.sql).toMatch(/^delete from `push_subscriptions` where `user_id` = \?$/u);
    expect(pushDelete?.parameters).toEqual([userId]);
    expect(probe.commits()).toBe(1);
  });

  it("deletes the user's profile photo in the same transaction when the photo table is installed", async () => {
    const steps = deletionSteps(false);
    steps.splice(3, 1, { rows: [{ installed: 1 }] }, { affectedRows: 1 });
    const probe = boundary(steps);
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    expect(probe.steps).toHaveLength(0);
    const photoDelete = probe.queries()[4];
    expect(photoDelete?.sql).toMatch(/^delete from `user_profile_photos` where `user_id` = \?$/u);
    expect(photoDelete?.parameters).toEqual([userId]);
    expect(probe.commits()).toBe(1);
  });

  it("with the photo table declared installed, deletes without the visibility probe and fails closed on error", async () => {
    const steps = deletionSteps(false);
    steps.splice(3, 1, { affectedRows: 1 });
    const probe = boundary(steps, "mariadb", { PROFILE_PHOTOS_DATABASE_INSTALLED: true });
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    expect(probe.queries()[3]?.sql).toMatch(
      /^delete from `user_profile_photos` where `user_id` = \?$/u,
    );
    expect(
      probe
        .queries()
        .some(
          ({ sql }) => sql.includes("information_schema") && sql.includes("user_profile_photos"),
        ),
    ).toBe(false);

    // Codex R4: 권한이 빠진 채 설치로 선언되면 삭제 오류가 탈퇴 전체를 되돌린다(사진을 남긴 채 완료하지 않는다).
    const denied = deletionSteps(false);
    denied.splice(3, 1, {
      error: { errno: 1142, sqlState: "42000", message: "DELETE command denied" },
    });
    const failing = boundary(denied, "mariadb", { PROFILE_PHOTOS_DATABASE_INSTALLED: true });
    await expect(failing.service.deleteAccount(deletionCommand)).rejects.toBeDefined();
    expect(failing.commits()).toBe(0);
    expect(failing.publisher.publish).not.toHaveBeenCalled();
  });

  it("supports an account with no memberships or guardian consent without manufacturing cleanup IDs", async () => {
    const steps = deletionSteps(false);
    steps[steps.length - 1] = { affectedRows: 0 };
    const probe = boundary(steps);
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    expect(probe.steps).toHaveLength(0);
    expect(probe.queries()[6]?.parameters[1]).toBe("[]");
    expect(probe.queries().some(({ sql }) => sql.includes("INSERT INTO audit_logs"))).toBe(false);
  });

  it("minimizes only the deleting user's completed guardian contact in the PostgreSQL transaction", async () => {
    const probe = boundary(postgresDeletionSteps(), "postgres");
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toEqual({
      account_deleted: true,
      next_action: "LOGIN",
    });
    const guardian = probe
      .queries()
      .find(({ sql }) => sql.startsWith('update "guardian_consent_requests"'));
    expect(guardian?.parameters).toEqual([DELETED_GUARDIAN_EMAIL, null, null, userId]);
    expect(guardian?.sql).toBe(
      'update "guardian_consent_requests" set "guardian_email_normalized" = $1, "approval_token_hash" = $2, "completion_token_hash" = $3 where "user_id" = $4 and "consumed_at" is not null',
    );
    expect(probe.steps).toHaveLength(0);
    expect(probe.commits()).toBe(1);
    expect(probe.publisher.publish).toHaveBeenCalledOnce();
  });

  it.each(["postgres", "mariadb"] as const)(
    "rolls back %s account deletion when guardian minimization fails and publishes no success",
    async (engine) => {
      const failure = new Error("Synthetic guardian cleanup failure");
      const steps =
        engine === "postgres" ? postgresDeletionSteps({ error: failure }) : deletionSteps(false);
      if (engine === "mariadb") steps[steps.length - 1] = { error: failure };
      const probe = boundary(steps, engine);
      await expect(probe.service.deleteAccount(deletionCommand)).rejects.toBeDefined();
      expect(probe.commits()).toBe(0);
      expect(probe.rollbacks()).toBeGreaterThan(0);
      expect(probe.publisher.publish).not.toHaveBeenCalled();
      expect(probe.queries().at(-1)?.sql).toContain("guardian_consent_requests");
    },
  );

  it("rolls back PostgreSQL guardian minimization when the final account update fails", async () => {
    const failure = new Error("Synthetic final account update failure");
    const probe = boundary(postgresDeletionSteps({}, { error: failure }), "postgres");
    await expect(probe.service.deleteAccount(deletionCommand)).rejects.toBe(failure);
    expect(probe.commits()).toBe(0);
    expect(probe.rollbacks()).toBe(1);
    expect(probe.publisher.publish).not.toHaveBeenCalled();
    expect(probe.queries().at(-2)?.sql).toContain("guardian_consent_requests");
  });

  it("preserves historical membership status/version while scrubbing PII and using all membership IDs for cleanup", async () => {
    const steps = deletionSteps();
    const historical = { ...member, id: "9007199254741011", status: "left", row_version: "17" };
    steps[5]?.rows?.push(historical);
    steps[9]?.rows?.push({
      ...historical,
      display_name_in_class: null,
      student_number: null,
      changed_raw: "2026-08-01 00:00:00.000000",
      updated_raw: rawNow,
    });
    const probe = boundary(steps);
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    const cleanup = probe.queries().find(({ sql }) => sql.startsWith("delete from `poll_votes`"));
    expect(cleanup?.parameters).toEqual([memberId, historical.id]);
    expect(
      probe
        .queries()
        .filter(({ sql }) => sql.includes("SELECT id FROM class_member_status_history")),
    ).toHaveLength(1);
  });

  it("keeps the live-class teacher conflict and does not continue after a routine SIGNAL", async () => {
    const steps = deletionSteps();
    steps[5] = { error: { errno: 30411, sqlState: "45000", message: "private-routine-text" } };
    const probe = boundary(steps);
    await expect(probe.service.deleteAccount(deletionCommand)).rejects.toBeInstanceOf(
      AccountDeletionBlockedByClassException,
    );
    expect(probe.queries()).toHaveLength(6);
    expect(probe.commits()).toBe(0);
    expect(probe.publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects an unknown engine instead of silently selecting PostgreSQL", () => {
    const probe = boundary([]);
    const environment = new ConfigService<AppEnvironment, true>();
    vi.spyOn(environment, "get").mockReturnValue("unknown" as never);
    expect(
      () =>
        new AccountService(
          probe.database,
          probe.rateLimiter as never,
          {} as never,
          probe.publisher as never,
          environment,
        ),
    ).toThrow("Unsupported database engine");
    expect(probe.statements).toHaveLength(0);
  });

  it("rejects a stale OUT class or missing history before any caller cleanup and rolls back CALL", async () => {
    const stale = deletionSteps();
    stale[7] = { rows: [{ actor_class_id: "12", occurred_raw: rawNow }] };
    const probe = boundary(stale);
    await expect(probe.service.deleteAccount(deletionCommand)).rejects.toMatchObject({
      status: 500,
    });
    expect(probe.commits()).toBe(0);
    expect(probe.publisher.publish).not.toHaveBeenCalled();
    const missing = deletionSteps();
    missing[10] = { rows: [] };
    const second = boundary(missing);
    await expect(second.service.deleteAccount(deletionCommand)).rejects.toMatchObject({
      status: 500,
    });
    expect(second.queries().some(({ sql }) => /^delete from/iu.test(sql))).toBe(false);
    expect(second.commits()).toBe(0);
  });

  it("rolls back protected deletion and caller audit if any required cleanup table fails", async () => {
    const steps = deletionSteps();
    steps[16] = {
      error: { errno: 1146, sqlState: "42S02", sql: "private-sql", message: "private-message" },
    };
    const probe = boundary(steps);
    const error = await probe.service
      .deleteAccount(deletionCommand)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 500 });
    expect(JSON.stringify(error)).not.toContain("private-");
    expect(probe.commits()).toBe(0);
    expect(probe.publisher.publish).not.toHaveBeenCalled();
  });

  it("retries only a native body deadlock after rollback, publishes once and never retries a timeout", async () => {
    const probe = boundary([
      { error: { errno: 1213, sqlState: "40001" } },
      ...deletionSteps(false),
    ]);
    await expect(probe.service.deleteAccount(deletionCommand)).resolves.toMatchObject({
      account_deleted: true,
    });
    expect(probe.statements.filter(({ sql }) => sql.startsWith("START TRANSACTION"))).toHaveLength(
      2,
    );
    expect(probe.publisher.publish).toHaveBeenCalledOnce();
    const timeout = boundary([{ error: { errno: 1205, sqlState: "HY000" } }]);
    await expect(timeout.service.deleteAccount(deletionCommand)).rejects.toMatchObject({
      status: 500,
    });
    expect(timeout.queries()).toHaveLength(1);
  });

  it.each(["commit", "rollback"] as const)(
    "does not retry %s failure and discards the uncertain connection",
    async (phase) => {
      const probe = boundary(
        phase === "commit" ? deletionSteps(false) : [{ error: { errno: 1213, sqlState: "40001" } }],
      );
      const error = { errno: 1213, sqlState: "40001", message: "private-control-error" };
      if (phase === "commit") probe.state.commitError = error;
      else probe.state.rollbackError = error;
      await expect(probe.service.deleteAccount(deletionCommand)).rejects.toMatchObject({
        status: 500,
      });
      expect(
        probe.statements.filter(({ sql }) => sql.startsWith("START TRANSACTION")),
      ).toHaveLength(1);
      expect(probe.destroy).toHaveBeenCalledOnce();
      expect(probe.release).not.toHaveBeenCalled();
      expect(probe.publisher.publish).not.toHaveBeenCalled();
    },
  );

  it("maps only exact deletion SIGNAL pairs and excludes private metadata and accessor values", () => {
    expect(mapMariaDbAccountError({ errno: 30411, sqlState: "45000" }, true)).toBeInstanceOf(
      AccountDeletionBlockedByClassException,
    );
    expect(mapMariaDbAccountError({ errno: 30414, sqlState: "45000" }, true)).toBeInstanceOf(
      UnauthenticatedException,
    );
    for (const error of [
      { errno: 30411, sqlState: "40001" },
      { errno: "30411", sqlState: "45000" },
      { sqlState: "40001" },
      null,
      {
        get errno() {
          throw new Error("private-getter");
        },
        sqlState: "45000",
      },
    ]) {
      expect(mapMariaDbAccountError(error, true)).toMatchObject({ status: 500 });
    }
    expect(mapMariaDbAccountError({ errno: 30411, sqlState: "45000" })).toMatchObject({
      status: 500,
    });
  });

  it("does not call protected deletion for a wrong current password", async () => {
    hasher.verifyPassword.mockResolvedValue(false);
    const probe = boundary(deletionSteps());
    await expect(probe.service.deleteAccount(deletionCommand)).rejects.toBeInstanceOf(
      InvalidCurrentPasswordException,
    );
    expect(probe.queries()).toHaveLength(3);
    expect(probe.publisher.publish).not.toHaveBeenCalled();
  });
});
