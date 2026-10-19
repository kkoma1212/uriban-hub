import { describe, expect, it, vi } from "vitest";
import { LoginAdmission, loginNetworkSubject } from "./login-admission.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RateLimitRequest } from "../common/rate-limit/redis-rate-limiter.js";

const config = { emailHmacKey: "synthetic-test-key-only", emailHmacKeyVersion: "test" };
function fixture(policy = { max_attempts: 3, cooldown_seconds: 60 }) {
  const allowed = { allowed: true, count: 1, remaining: 2, limit: 3, retryAfterSeconds: 60 };
  const limiter = {
    consume: vi.fn(async (_: RateLimitRequest) => allowed),
    peek: vi.fn(async (_: RateLimitRequest) => allowed),
    getPolicy: vi.fn(async () => policy),
  };
  return { limiter, admission: new LoginAdmission(limiter as never, config as never) };
}

describe("login admission", () => {
  it.each([
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["0:0:0:0:0:ffff:cb00:7107", "203.0.113.7"],
    ["2001:0db8:0000:0001::1234", "2001:db8:0:1::/64"],
    ["2001:db8:0:1:ffff::2", "2001:db8:0:1::/64"],
    ["invalid", "unknown"],
  ])("groups the network %s as %s", (input, expected) => {
    expect(loginNetworkSubject(input)).toBe(expected);
  });

  it("charges fixed admission budgets before consulting the policy or failure budget", async () => {
    const { limiter, admission } = fixture();
    limiter.consume.mockResolvedValue({
      allowed: false,
      count: 300,
      limit: 300,
      remaining: 0,
      retryAfterSeconds: 15,
    });
    await expect(admission.enter("unknown@example.invalid", "203.0.113.7")).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(limiter.consume).toHaveBeenCalledExactlyOnceWith({
      key: expect.stringMatching(/^login-admission:network:/u),
      limit: 300,
      windowSeconds: 60,
    });
    expect(limiter.getPolicy).not.toHaveBeenCalled();
    expect(limiter.peek).not.toHaveBeenCalled();
  });

  it("isolates shared-school-IP failures by email and cross-network failures by origin", async () => {
    const { limiter, admission } = fixture();
    const first = await admission.enter("one@example.invalid", "203.0.113.7");
    const otherStudent = await admission.enter("two@example.invalid", "203.0.113.7");
    const otherNetwork = await admission.enter("one@example.invalid", "203.0.113.8");
    expect(new Set([first.pair.key, otherStudent.pair.key, otherNetwork.pair.key]).size).toBe(3);
    expect(limiter.consume.mock.calls[0]?.[0].key).toBe(limiter.consume.mock.calls[3]?.[0].key);
    expect(JSON.stringify(limiter.consume.mock.calls)).not.toMatch(/example|203\.0\.113/u);
  });

  it("charges blocked requests and prevents administrator settings from weakening security floors", async () => {
    const { limiter, admission } = fixture({ max_attempts: 20, cooldown_seconds: 1 });
    limiter.peek.mockImplementation(async (request) =>
      request.key === "login-admission:service:v1"
        ? { allowed: true, count: 0, limit: 600, remaining: 600, retryAfterSeconds: 60 }
        : { allowed: false, count: 5, limit: 5, remaining: 0, retryAfterSeconds: 60 },
    );
    await expect(admission.enter("one@example.invalid", "203.0.113.7")).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(limiter.consume).toHaveBeenCalledTimes(2);
    expect(limiter.peek).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, windowSeconds: 60 }),
    );
  });
});

function securityFixture() {
  const counts = new Map<string, number>();
  const blockedPairs = new Set<string>();
  const result = (count: number, limit: number, allowed: boolean) => ({
    allowed,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: 60,
  });
  const limiter = {
    consume: async (request: RateLimitRequest) => {
      const count = counts.get(request.key) ?? 0;
      if (count >= request.limit!) return result(count, request.limit!, false);
      counts.set(request.key, count + 1);
      return result(count + 1, request.limit!, true);
    },
    peek: async (request: RateLimitRequest) => {
      const count = blockedPairs.has(request.key) ? request.limit! : (counts.get(request.key) ?? 0);
      return result(count, request.limit!, count < request.limit!);
    },
    getPolicy: vi.fn(async () => ({ max_attempts: 3, cooldown_seconds: 60 })),
  };
  const config = { emailHmacKey: "synthetic-review-only", emailHmacKeyVersion: "test" };
  const admission = new LoginAdmission(limiter as never, config as never);
  return { admission, counts, blockedPairs, limiter };
}

describe("rejected login traffic and service admission", () => {
  it("preserves admission for another network after a blocked pair repeats requests", async () => {
    const { admission, blockedPairs } = securityFixture();
    const failedPair = await admission.enter("blocked@example.invalid", "203.0.113.10");
    blockedPairs.add(failedPair.pair.key);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await expect(admission.enter("blocked@example.invalid", "203.0.113.10")).rejects.toThrow();
    }
    await expect(admission.enter("other@example.invalid", "198.51.100.20")).resolves.toMatchObject({
      pair: { limit: 3, windowSeconds: 60 },
    });
  });

  it("contains one exhausted network even when the attacker rotates email addresses", async () => {
    const { admission } = securityFixture();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await admission.enter(`first-${attempt}@example.invalid`, "203.0.113.10");
    }
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await expect(
        admission.enter(`blocked-${attempt}@example.invalid`, "203.0.113.10"),
      ).rejects.toThrow();
    }
    await expect(admission.enter("other@example.invalid", "198.51.100.20")).resolves.toMatchObject({
      pair: { limit: 3 },
    });
  });

  it("rejects full service capacity before loading a database-backed policy", async () => {
    const { admission, counts, limiter } = securityFixture();
    counts.set("login-admission:service:v1", 600);
    await expect(admission.enter("other@example.invalid", "198.51.100.20")).rejects.toThrow();
    expect(limiter.getPolicy).not.toHaveBeenCalled();
  });

  it("reserves the last global slot atomically when two networks arrive together", async () => {
    const { admission, counts } = securityFixture();
    counts.set("login-admission:service:v1", 599);
    const results = await Promise.allSettled([
      admission.enter("first@example.invalid", "198.51.100.20"),
      admission.enter("second@example.invalid", "203.0.113.10"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("account-level login waits (2026-10-02 user decision)", () => {
  async function fail(
    limiter: ReturnType<typeof securityFixture>["limiter"],
    budgets: Awaited<ReturnType<LoginAdmission["enter"]>>,
  ) {
    for (const request of [budgets.network, budgets.accountSlow, budgets.accountLockAfter]) {
      await limiter.consume(request);
    }
  }

  it("spaces attempts 30 seconds apart after five failures from any network", async () => {
    const { admission, limiter } = securityFixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fail(
        limiter,
        await admission.enter("target@example.invalid", `203.0.113.${attempt + 1}`),
      );
    }
    // 여섯 번째는 들어가되 간격을 쓰고, 30초 안의 다음 시도는 다른 주소여도 막힌다.
    await expect(admission.enter("target@example.invalid", "198.51.100.1")).resolves.toBeDefined();
    await expect(admission.enter("target@example.invalid", "198.51.100.2")).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    // 다른 계정은 영향을 받지 않는다(같은 학교 주소).
    await expect(admission.enter("friend@example.invalid", "198.51.100.2")).resolves.toBeDefined();
  });

  it("stops the account for 15 minutes once the lock is set, whatever the network", async () => {
    const { admission, limiter, counts } = securityFixture();
    const budgets = await admission.enter("target@example.invalid", "203.0.113.1");
    counts.set(budgets.accountLock.key, 1);
    await expect(admission.enter("target@example.invalid", "198.51.100.9")).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(budgets.accountLock).toMatchObject({ limit: 1, windowSeconds: 900 });
    expect(budgets.accountLockAfter).toMatchObject({ limit: 30, windowSeconds: 3_600 });
    expect(limiter).toBeDefined();
  });

  it("refuses a network with 60 failures a minute before it reserves shared capacity", async () => {
    const { admission, counts } = securityFixture();
    const budgets = await admission.enter("first@example.invalid", "203.0.113.50");
    counts.set(budgets.network.key, 60);
    const before = counts.get("login-admission:service:v1");
    await expect(admission.enter("next@example.invalid", "203.0.113.50")).rejects.toBeInstanceOf(
      RateLimitedException,
    );
    expect(counts.get("login-admission:service:v1")).toBe(before);
    await expect(admission.enter("next@example.invalid", "198.51.100.50")).resolves.toBeDefined();
  });

  it("keys account budgets without the raw email", () => {
    const { admission } = securityFixture();
    const budgets = admission.accountBudgets("target@example.invalid");
    expect(JSON.stringify(budgets)).not.toMatch(/example|target/u);
    expect(new Set(Object.values(budgets).map((request) => request.key)).size).toBe(4);
  });
});
