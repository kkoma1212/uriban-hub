import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import { AccountRecoveryController } from "./account-recovery.controller.js";
import { AccountRecoveryRequestDto } from "./account-recovery.dto.js";
import { AccountRecoveryService } from "./account-recovery.service.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";

const allowed = { allowed: true, count: 1, limit: 3, remaining: 2, retryAfterSeconds: 60 };
function harness(exists = true) {
  const query = {
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    executeTakeFirst: vi.fn(async () =>
      exists ? { email_normalized: "student@example.invalid" } : undefined,
    ),
  };
  const database = { selectFrom: vi.fn(() => query) };
  const limiter = { consume: vi.fn(async () => allowed), consumeAll: vi.fn(async () => allowed) };
  const mailer = { sendAccountRecoveryEmail: vi.fn(async () => "sent" as const) };
  const service = new AccountRecoveryService(database as never, limiter as never, mailer as never, {
    agePolicyVersion: "test",
    emailHmacKey: "synthetic-account-recovery-unit-key",
    emailHmacKeyVersion: "test",
    privacyPolicyVersion: "test",
    termsPolicyVersion: "test",
  });
  return { query, database, limiter, mailer, service };
}

describe("account recovery", () => {
  it("rejects the shared mail budget before account lookup or SMTP", async () => {
    const h = harness();
    h.limiter.consumeAll.mockResolvedValueOnce({ ...allowed, allowed: false });
    await expect(
      h.service.requestAccount("student@example.invalid", "192.0.2.1"),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.database.selectFrom).not.toHaveBeenCalled();
    expect(h.mailer.sendAccountRecoveryEmail).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "keeps HTTP acceptance identical for account existence %s",
    async (exists) => {
      const h = harness(exists);
      await expect(
        h.service.requestAccount(" Student@Example.Invalid ", "192.0.2.1"),
      ).resolves.toEqual({ request_accepted: true });
      expect(h.mailer.sendAccountRecoveryEmail).toHaveBeenCalledWith(
        "student@example.invalid",
        exists,
      );
      expect(h.query.where).toHaveBeenCalledWith("is_active", "=", true);
      expect(h.query.where).toHaveBeenCalledWith("deleted_at", "is", null);
      const requests = h.limiter.consume.mock.calls as unknown as Array<[{ key: string }]>;
      expect(requests).toHaveLength(2);
      expect(requests[0]![0].key).toMatch(/^account-recovery:email:/u);
      expect(requests[1]![0].key).toMatch(/^account-recovery:ip:/u);
      expect(JSON.stringify(requests)).not.toMatch(/student@|192\.0\.2\.1/u);
      expect(Object.keys(requests[0]![0])).toEqual(["key"]);
    },
  );

  it.each([true, false])(
    "does not expose SMTP failure for account existence %s",
    async (exists) => {
      const h = harness(exists);
      h.mailer.sendAccountRecoveryEmail.mockRejectedValueOnce(
        new Error("synthetic private SMTP reply"),
      );
      await expect(
        h.service.requestAccount("student@example.invalid", "192.0.2.1"),
      ).resolves.toEqual({ request_accepted: true });
    },
  );

  it("applies administrator request limits before either account lookup or mail", async () => {
    const h = harness();
    h.limiter.consume.mockResolvedValueOnce({
      ...allowed,
      allowed: false,
      count: 3,
      remaining: 0,
      retryAfterSeconds: 41,
    });
    await expect(
      h.service.requestAccount("student@example.invalid", "192.0.2.1"),
    ).rejects.toMatchObject({
      response: { code: "RATE_LIMITED", retry_after_seconds: 41 },
    });
    expect(h.database.selectFrom).not.toHaveBeenCalled();
    expect(h.mailer.sendAccountRecoveryEmail).not.toHaveBeenCalled();
  });

  it("requires the current application Origin and validates email before delegation", async () => {
    expect(
      Reflect.getMetadata("__guards__", AccountRecoveryController.prototype.request),
    ).toContain(PreAuthOriginGuard);
    expect(Reflect.getMetadata("__httpCode__", AccountRecoveryController.prototype.request)).toBe(
      202,
    );
    const valid = plainToInstance(AccountRecoveryRequestDto, {
      email: " Student@Example.Invalid ",
    });
    expect(await validate(valid)).toEqual([]);
    expect(valid.email).toBe("student@example.invalid");
    expect(
      await validate(plainToInstance(AccountRecoveryRequestDto, { email: "not-an-email" })),
    ).not.toEqual([]);
  });
});
