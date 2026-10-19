import { createHmac } from "node:crypto";
import type { DB } from "@classhub/db";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type Transaction,
  type TransactionBuilder,
} from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitServiceUnavailableException } from "../../common/rate-limit/rate-limit.errors.js";
import type {
  RateLimitRequest,
  RateLimitResult,
} from "../../common/rate-limit/redis-rate-limiter.js";
import type { CreateMembershipRequestCommand } from "../membership.types.js";
import { requestMembershipMariaDb } from "./request-membership.js";

const input = (): CreateMembershipRequestCommand => ({
  clientIp: "192.0.2.17",
  inviteCode: "ABCDEFGH",
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  userId: "9223372036854775807",
});
const authConfig = { emailHmacKey: "synthetic-unit-hmac-key", emailHmacKeyVersion: "v7" };
const allowed = (): RateLimitResult => ({
  allowed: true,
  count: 1,
  limit: 3,
  remaining: 2,
  retryAfterSeconds: 60,
});
const blocked = (): RateLimitResult => ({ ...allowed(), allowed: false, retryAfterSeconds: 37 });

function boundary() {
  const transaction = vi.fn(() => {
    throw new Error("DB access is not expected at this boundary");
  });
  const consume = vi.fn<(request: RateLimitRequest) => Promise<RateLimitResult>>();
  consume.mockResolvedValue(blocked());
  return {
    database: { transaction } as unknown as Kysely<DB>,
    transaction,
    consume,
    dependencies: { rateLimiter: { consume }, authConfig },
  };
}

// Only the four preliminary SELECT results are supplied. Real Kysely compiles
// their bound parameters, but DummyDriver cannot connect to any database.
// No membership mutation, CALL, audit or commit behavior is simulated here.
function preliminaryBoundary() {
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  const rows: Record<string, unknown>[][] = [
    [{ display_name: "합성 학생", is_active: 1, deleted_at: null, approved: 1 }],
    [],
    [],
    [{ class_id: "9007199254740993" }],
  ];
  const executeQuery = vi
    .spyOn(database.getExecutor(), "executeQuery")
    .mockImplementation(async () => {
      const next = rows.shift();
      if (!next) throw new Error("Only preliminary SELECTs belong in this test");
      return { rows: next };
    });
  const execute = vi.fn(async (callback: (tx: Transaction<DB>) => Promise<string>) =>
    callback(database as Transaction<DB>),
  );
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementation(() => ({ execute }) as unknown as TransactionBuilder<DB>);
  const consume = vi.fn<(request: RateLimitRequest) => Promise<RateLimitResult>>();
  consume.mockResolvedValueOnce(allowed()).mockResolvedValue(blocked());
  return {
    database,
    transaction,
    executeQuery,
    rows,
    consume,
    dependencies: { rateLimiter: { consume }, authConfig },
  };
}

const failure = (status: number, code: string) => ({ status, response: { code } });
afterEach(() => vi.restoreAllMocks());

describe("MariaDB membership request command boundary", () => {
  it.each([
    { userId: "0" },
    { userId: "01" },
    { userId: "-1" },
    { userId: "1.0" },
    { userId: "1e3" },
    { userId: "9223372036854775808" },
    { userId: 1 },
    { userId: null },
    { inviteCode: "" },
    { inviteCode: "ABCDEFG" },
    { inviteCode: "ABCDEFGHJ" },
    { inviteCode: "ABCDEFG0" },
    { inviteCode: "ABCDEFG1" },
    { inviteCode: "ABCDEFGI" },
    { inviteCode: "ABCDEFGL" },
    { inviteCode: "ABCDEFGO" },
    { inviteCode: "ABC DEFG" },
    { inviteCode: "ABCDEFG\uD800" },
    { inviteCode: 12345678 },
    { clientIp: "localhost" },
    { clientIp: "256.1.1.1" },
    { clientIp: "192.0.2.17:3000" },
    { clientIp: "192.0.2.17/32" },
    { clientIp: " 192.0.2.17" },
    { clientIp: "[2001:db8::1]" },
    { clientIp: null },
    { requestId: "not-a-uuid" },
    { requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee " },
    { requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeg" },
    { requestId: null },
  ])("rejects invalid identity/DTO input before Redis or DB: %o", async (change) => {
    const harness = boundary();
    await expect(
      requestMembershipMariaDb(
        harness.database,
        { ...input(), ...change } as CreateMembershipRequestCommand,
        harness.dependencies,
      ),
    ).rejects.toMatchObject(failure(400, "VALIDATION_FAILED"));
    expect(harness.consume).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { userId: "1", clientIp: "127.0.0.1", inviteCode: "  abjkmpz2  " },
    { userId: "9007199254740993", clientIp: "2001:db8::1" },
    { clientIp: "::ffff:192.0.2.17", requestId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" },
  ])("accepts valid ID/IP/UUID and normalized code before rate limiting: %o", async (change) => {
    const harness = boundary();
    await expect(
      requestMembershipMariaDb(harness.database, { ...input(), ...change }, harness.dependencies),
    ).rejects.toMatchObject(failure(429, "RATE_LIMITED"));
    expect(harness.consume).toHaveBeenCalledTimes(1);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("keeps the existing HMAC namespace/version and IP limit without exposing the IP", async () => {
    const harness = boundary();
    await expect(
      requestMembershipMariaDb(harness.database, input(), harness.dependencies),
    ).rejects.toMatchObject({
      ...failure(429, "RATE_LIMITED"),
      response: { code: "RATE_LIMITED", retry_after_seconds: 37 },
    });
    const digest = createHmac("sha256", authConfig.emailHmacKey)
      .update(JSON.stringify(["invite_code_ip", `${input().userId}:${input().clientIp}`]), "utf8")
      .digest("base64url");
    expect(harness.consume).toHaveBeenCalledExactlyOnceWith({
      key: `invite-code:ip:v7:${digest}`,
    });
    expect(harness.consume.mock.calls[0]?.[0].key).not.toContain(input().clientIp);
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});

describe("MariaDB membership request rate-limit staging", () => {
  it.each([
    new Error("private Redis connection URL"),
    new RateLimitServiceUnavailableException("private Redis connection URL"),
  ])(
    "emits a fresh 503 without Redis causes and never starts a DB transaction",
    async (original) => {
      const harness = boundary();
      harness.consume.mockRejectedValueOnce(original);
      const error: unknown = await requestMembershipMariaDb(
        harness.database,
        input(),
        harness.dependencies,
      ).catch((caught: unknown) => caught);
      expect(error).toMatchObject(failure(503, "RATE_LIMIT_SERVICE_UNAVAILABLE"));
      expect(error).not.toBe(original);
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("private Redis connection URL");
      expect(harness.consume).toHaveBeenCalledTimes(1);
      expect(harness.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { allowed: "true" },
    { allowed: false },
    { allowed: false, retryAfterSeconds: 0 },
    { allowed: false, retryAfterSeconds: 1.5 },
    { allowed: false, retryAfterSeconds: Number.NaN },
  ])("fails closed on malformed limiter results: %o", async (result) => {
    const harness = boundary();
    harness.consume.mockResolvedValueOnce(result as RateLimitResult);
    await expect(
      requestMembershipMariaDb(harness.database, input(), harness.dependencies),
    ).rejects.toMatchObject(failure(503, "RATE_LIMIT_SERVICE_UNAVAILABLE"));
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("uses the shared account policy and blocks before any database query", async () => {
    const harness = preliminaryBoundary();
    await expect(
      requestMembershipMariaDb(harness.database, input(), harness.dependencies),
    ).rejects.toMatchObject(failure(429, "RATE_LIMITED"));
    expect(harness.consume).toHaveBeenCalledTimes(2);
    expect(harness.consume).toHaveBeenNthCalledWith(2, {
      key: `membership-request:user:${input().userId}`,
    });
    expect(harness.executeQuery).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("does not enter the write transaction when the account limiter fails", async () => {
    const harness = preliminaryBoundary();
    harness.consume
      .mockReset()
      .mockResolvedValueOnce(allowed())
      .mockRejectedValueOnce(new Error("private Redis URL"));
    const error: unknown = await requestMembershipMariaDb(
      harness.database,
      input(),
      harness.dependencies,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject(failure(503, "RATE_LIMIT_SERVICE_UNAVAILABLE"));
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("private Redis URL");
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.executeQuery).not.toHaveBeenCalled();
  });

  it("normalizes the captured invite and preserves identity when the input changes during the first await", async () => {
    const harness = preliminaryBoundary();
    const command = { ...input(), inviteCode: "  abjkmpz2  " };
    const original = { ...command };
    harness.rows[3] = [];
    harness.consume
      .mockReset()
      .mockImplementationOnce(async () => {
        Object.assign(command, {
          userId: "7",
          inviteCode: "ZZZZZZZZ",
          clientIp: "203.0.113.9",
          requestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        });
        return allowed();
      })
      .mockResolvedValue(allowed());
    await expect(
      requestMembershipMariaDb(harness.database, command, harness.dependencies),
    ).rejects.toMatchObject(failure(400, "INVITE_CODE_INVALID_OR_EXPIRED"));
    expect(harness.executeQuery.mock.calls.slice(0, 3).map(([query]) => query.parameters)).toEqual([
      [original.userId],
      [original.userId],
      [original.userId],
    ]);
    expect(harness.executeQuery.mock.calls[3]?.[0].parameters).toEqual(["ABJKMPZ2"]);
    expect(harness.consume).toHaveBeenNthCalledWith(2, {
      key: `membership-request:user:${original.userId}`,
    });
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the caller's code during normalization", async () => {
    const harness = preliminaryBoundary();
    harness.consume.mockReset().mockResolvedValue(allowed());
    harness.rows[3] = [];
    const command = { ...input(), inviteCode: "  abjkmpz2  " };
    await expect(
      requestMembershipMariaDb(harness.database, command, harness.dependencies),
    ).rejects.toMatchObject(failure(400, "INVITE_CODE_INVALID_OR_EXPIRED"));
    expect(command.inviteCode).toBe("  abjkmpz2  ");
    expect(harness.executeQuery.mock.calls[3]?.[0].parameters).toEqual(["ABJKMPZ2"]);
  });

  it.each([
    { errno: 1062, sqlState: "23000" },
    { errno: 1213, sqlState: "40001" },
    { errno: 1205, sqlState: "HY000" },
  ])("does not retry a preliminary DB failure after consuming the attempt: %o", async (native) => {
    const harness = preliminaryBoundary();
    harness.consume.mockReset().mockResolvedValue(allowed());
    harness.executeQuery.mockRejectedValueOnce({ ...native, sql: "private SQL" });
    const error: unknown = await requestMembershipMariaDb(
      harness.database,
      input(),
      harness.dependencies,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject(failure(500, "INTERNAL_ERROR"));
    expect(JSON.stringify(error)).not.toContain("private SQL");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery).toHaveBeenCalledTimes(1);
    expect(harness.consume).toHaveBeenCalledTimes(2);
  });

  it("returns the attempt count and retry deadline on the third invalid invite", async () => {
    const harness = preliminaryBoundary();
    harness.rows[3] = [];
    harness.consume.mockReset().mockResolvedValue({
      ...allowed(),
      count: 3,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    const error = await requestMembershipMariaDb(
      harness.database,
      input(),
      harness.dependencies,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 429,
      response: {
        code: "RATE_LIMITED",
        retry_after_seconds: 60,
        details: { attempts: 3, max_attempts: 3, remaining_attempts: 0 },
      },
    });
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.executeQuery).toHaveBeenCalledTimes(4);
  });
});
