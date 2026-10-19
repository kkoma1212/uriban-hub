import { describe, expect, it, vi } from "vitest";
import { admitAuthMail, AUTH_MAIL_LIMITS, type AuthMailKind } from "./auth-mail-admission.js";
import type { RateLimitRequest } from "../common/rate-limit/redis-rate-limiter.js";
import { RateLimitServiceUnavailableException } from "../common/rate-limit/rate-limit.errors.js";

const config = {
  emailHmacKey: "synthetic-auth-mail-unit-key-only",
  emailHmacKeyVersion: "test-v1",
};
const allowed = { allowed: true, count: 1, limit: 1, remaining: 0, retryAfterSeconds: 60 };
function harness() {
  return {
    consumeAll: vi
      .fn<(requests: readonly Required<RateLimitRequest>[]) => Promise<typeof allowed>>()
      .mockResolvedValue(allowed),
  };
}
async function budgets(email: string, kind: AuthMailKind, clientIp = "192.0.2.1") {
  const limiter = harness();
  await admitAuthMail(limiter, config, email, kind, { clientIp });
  return limiter.consumeAll.mock.calls[0]![0];
}

describe("authentication mail admission", () => {
  it("reserves cooldown, recipient, source and service windows in one operation", async () => {
    const requests = await budgets("student@example.invalid", "password-reset");
    expect(requests).toHaveLength(7);
    expect(requests.map(({ limit, windowSeconds }) => [limit, windowSeconds])).toEqual([
      [1, 60],
      [10, 3_600],
      [30, 86_400],
      [300, 3_600],
      [1_000, 86_400],
      [3_000, 3_600],
      [10_000, 86_400],
    ]);
    expect(new Set(requests.map(({ key }) => key)).size).toBe(7);
  });

  it.each<AuthMailKind>([
    "signup-email",
    "signup-approval",
    "account-recovery",
    "guardian-consent",
    "email-verification",
  ])(
    "shares recipient and service budgets with the %s path, while keeping its cooldown separate",
    async (kind) => {
      const reset = await budgets(" Student@Example.Invalid ", "password-reset");
      const other = await budgets("student@example.invalid", kind, "192.0.2.99");
      expect(other.slice(1, 3)).toEqual(reset.slice(1, 3));
      expect(other.slice(-2)).toEqual(reset.slice(-2));
      expect(other[0]!.key).not.toBe(reset[0]!.key);
      expect(other[3]!.key).not.toBe(reset[3]!.key);
    },
  );

  it("does not merge plus addresses or expose email, IP, actor or secrets in keys", async () => {
    const first = await budgets("student+one@example.invalid", "password-reset");
    const second = await budgets("student+two@example.invalid", "password-reset");
    expect(first[1]!.key).not.toBe(second[1]!.key);
    const limiter = harness();
    await admitAuthMail(limiter, config, "student@example.invalid", "signup-approval", {
      clientIp: "2001:db8::1234",
      actor: { kind: "admin", id: "private-actor" },
    });
    expect(limiter.consumeAll.mock.calls[0]![0]).toHaveLength(9);
    expect(JSON.stringify(limiter.consumeAll.mock.calls)).not.toMatch(
      /student|example\.invalid|2001:|private-actor|synthetic-auth-mail-unit-key/u,
    );
  });

  it.each([
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["2001:db8:abcd:1::1", "2001:db8:abcd:1::ffff"],
  ])("groups equivalent network sources %s and %s", async (left, right) => {
    expect((await budgets("a@example.invalid", "password-reset", left)).slice(3, 5)).toEqual(
      (await budgets("b@example.invalid", "account-recovery", right)).slice(3, 5),
    );
  });

  it("keeps an actor's budget across recipients and IP changes", async () => {
    const limiter = harness();
    for (const clientIp of ["192.0.2.1", "192.0.2.2"]) {
      await admitAuthMail(limiter, config, `${clientIp}@example.invalid`, "signup-email", {
        clientIp,
        actor: { kind: "user", id: "123" },
      });
    }
    const [first, second] = limiter.consumeAll.mock.calls.map(([requests]) => requests.slice(5, 7));
    expect(first).toEqual(second);
    expect(first![0]!.limit).toBe(AUTH_MAIL_LIMITS.actorHour);
  });

  it("returns the governing retry time on denial and fails closed on Redis errors", async () => {
    const limiter = harness();
    limiter.consumeAll.mockResolvedValueOnce({ ...allowed, allowed: false, retryAfterSeconds: 71 });
    await expect(
      admitAuthMail(limiter, config, "a@example.invalid", "password-reset", {
        clientIp: "192.0.2.1",
      }),
    ).rejects.toMatchObject({ status: 429, response: { retry_after_seconds: 71 } });
    limiter.consumeAll.mockRejectedValueOnce(new RateLimitServiceUnavailableException());
    await expect(
      admitAuthMail(limiter, config, "a@example.invalid", "password-reset", {
        clientIp: "192.0.2.1",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("requires an accountable source", async () => {
    const limiter = harness();
    await expect(
      admitAuthMail(limiter, config, "a@example.invalid", "password-reset", {}),
    ).rejects.toThrow("source");
    expect(limiter.consumeAll).not.toHaveBeenCalled();
  });
});
