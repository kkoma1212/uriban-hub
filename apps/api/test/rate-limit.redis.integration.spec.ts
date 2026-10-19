import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RateLimitServiceUnavailableException } from "../src/common/rate-limit/rate-limit.errors.js";
import {
  createRedisRateLimiter,
  type RedisRateLimiter,
} from "../src/common/rate-limit/redis-rate-limiter.js";

let container: StartedNativeTestService;
let limiter: RedisRateLimiter;
let redisUrl: string;

function createObserver(url: string) {
  return createClient({ url });
}

let observer: ReturnType<typeof createObserver>;

function key(name: string): string {
  return `classhub:rate-limit:test:${name}:${randomUUID()}`;
}

function withSafetyDeadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Redis operation did not settle within ${milliseconds}ms.`)),
      milliseconds,
    );
  });

  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

beforeAll(async () => {
  container = await startNativeTestService("redis");

  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  limiter = createRedisRateLimiter(redisUrl);
  observer = createObserver(redisUrl);
  observer.on("error", () => undefined);
  await observer.connect();
});

afterAll(async () => {
  if (observer?.isReady) {
    await observer.quit();
  } else if (observer?.isOpen) {
    observer.destroy();
  }

  await limiter?.close();
  await container?.stop({ remove: true, removeVolumes: true });
});

describe("RedisRateLimiter", () => {
  it("reserves all budgets atomically across concurrent callers", async () => {
    const recipient = { key: key("mail-recipient"), limit: 5, windowSeconds: 60 };
    const service = { key: key("mail-service"), limit: 100, windowSeconds: 3_600 };
    const results = await Promise.all(
      Array.from({ length: 40 }, () => limiter.consumeAll([recipient, service])),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(await observer.get(`${service.key}:fixed:100:3600`)).toBe("5");
    expect(
      await limiter.consumeAll([{ ...recipient, key: key("another-recipient") }, service]),
    ).toMatchObject({ allowed: true });
    expect(await observer.get(`${service.key}:fixed:100:3600`)).toBe("6");
  });

  it("does not reserve a cooldown or recipient budget when the service is full", async () => {
    const requests = [
      { key: key("mail-cooldown"), limit: 1, windowSeconds: 60 },
      { key: key("mail-full-service"), limit: 2, windowSeconds: 86_400 },
    ];
    await observer.set(`${requests[1]!.key}:fixed:2:86400`, "2", { EX: 3_600 });
    expect(await limiter.consumeAll(requests)).toMatchObject({
      allowed: false,
      count: 2,
      limit: 2,
    });
    expect(await observer.exists(`${requests[0]!.key}:fixed:1:60`)).toBe(0);
    expect(await observer.get(`${requests[1]!.key}:fixed:2:86400`)).toBe("2");
  });

  it("preserves fixed expiry when the limit is reached and returns the longest blocked wait", async () => {
    const short = { key: key("mail-short"), limit: 2, windowSeconds: 3_600 };
    const long = { key: key("mail-long"), limit: 1, windowSeconds: 86_400 };
    await observer.set(`${short.key}:fixed:2:3600`, "1", { EX: 20 });
    expect((await limiter.consumeAll([short])).allowed).toBe(true);
    expect(await observer.ttl(`${short.key}:fixed:2:3600`)).toBeLessThanOrEqual(20);
    await observer.set(`${long.key}:fixed:1:86400`, "1", { EX: 600 });
    const result = await limiter.consumeAll([short, long]);
    expect(result).toMatchObject({ allowed: false, limit: 1 });
    expect(result.retryAfterSeconds).toBeGreaterThan(500);
    expect(await observer.ttl(`${short.key}:fixed:2:3600`)).toBeLessThanOrEqual(20);
  });

  it.each(["invalid", "01", "1e0", "-1", "1.5", "1000000001"])(
    "fails closed before any mutation for corrupt counter %s",
    async (value) => {
      const first = { key: key("mail-intact"), limit: 10, windowSeconds: 60 };
      const corrupt = { key: key("mail-corrupt"), limit: 10, windowSeconds: 60 };
      await observer.set(`${corrupt.key}:fixed:10:60`, value, { EX: 60 });
      await expect(limiter.consumeAll([first, corrupt])).rejects.toBeInstanceOf(
        RateLimitServiceUnavailableException,
      );
      expect(await observer.exists(`${first.key}:fixed:10:60`)).toBe(0);
      expect(await observer.get(`${corrupt.key}:fixed:10:60`)).toBe(value);
    },
  );

  it("fails closed for a counter without expiry", async () => {
    const request = { key: key("mail-no-ttl"), limit: 10, windowSeconds: 60 };
    await observer.set(`${request.key}:fixed:10:60`, "1");
    await expect(limiter.consumeAll([request])).rejects.toBeInstanceOf(
      RateLimitServiceUnavailableException,
    );
    expect(await observer.ttl(`${request.key}:fixed:10:60`)).toBe(-1);
  });

  it("retains budgets when the API client is closed and reopened", async () => {
    const request = { key: key("mail-reconnect"), limit: 1, windowSeconds: 60 };
    const first = createRedisRateLimiter(redisUrl);
    await first.consumeAll([request]);
    await first.close();
    const next = createRedisRateLimiter(redisUrl);
    try {
      expect((await next.consumeAll([request])).allowed).toBe(false);
    } finally {
      await next.close();
    }
  });

  it("rejects duplicate or unbounded budgets before contacting Redis", async () => {
    const request = { key: key("mail-invalid-budget"), limit: 1, windowSeconds: 60 };
    await expect(limiter.consumeAll([])).rejects.toBeInstanceOf(RangeError);
    await expect(limiter.consumeAll([request, request])).rejects.toBeInstanceOf(RangeError);
    await expect(
      limiter.consumeAll(
        Array.from({ length: 17 }, (_, i) => ({ ...request, key: `${request.key}:${i}` })),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(limiter.consumeAll([{ ...request, limit: 1.1 }])).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(limiter.consumeAll([{ ...request, windowSeconds: 0 }])).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await observer.exists(`${request.key}:fixed:1:60`)).toBe(0);
  });

  it("increments and assigns the fixed-window TTL atomically", async () => {
    const redisKey = key("fixed-window");

    const first = await limiter.consume({ key: redisKey, limit: 3, windowSeconds: 60 });
    const second = await limiter.consume({ key: redisKey, limit: 3, windowSeconds: 60 });

    expect(first).toMatchObject({ allowed: true, count: 1, remaining: 2 });
    expect(second).toMatchObject({ allowed: true, count: 2, remaining: 1 });
    expect(await observer.get(`${redisKey}:policy:3:60`)).toBe("2");
    expect(await observer.ttl(`${redisKey}:policy:3:60`)).toBeGreaterThan(0);
  });

  it("allows exactly the configured number under concurrent load", async () => {
    const redisKey = key("concurrent");
    const coldLimiter = createRedisRateLimiter(redisUrl);

    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          coldLimiter.consume({ key: redisKey, limit: 5, windowSeconds: 60 }),
        ),
      );

      expect(results.filter((result) => result.allowed)).toHaveLength(5);
      expect(results.filter((result) => !result.allowed)).toHaveLength(15);
      expect(await observer.get(`${redisKey}:policy:5:60`)).toBe("5");
      expect(await observer.ttl(`${redisKey}:policy:5:60`)).toBeGreaterThan(0);
    } finally {
      await coldLimiter.close();
    }
  });

  it("repairs a counter key that has lost its TTL", async () => {
    const redisKey = key("ttl-repair");
    await observer.set(`${redisKey}:policy:5:30`, "2");
    expect(await observer.ttl(`${redisKey}:policy:5:30`)).toBe(-1);

    const result = await limiter.consume({ key: redisKey, limit: 5, windowSeconds: 30 });

    expect(result).toMatchObject({ allowed: true, count: 3, remaining: 2 });
    expect(await observer.ttl(`${redisKey}:policy:5:30`)).toBeGreaterThan(0);
  });

  it("starts the full cooldown on the third attempt, keeps it fixed while blocked, and resets after expiry", async () => {
    const redisKey = key("default-policy");
    const storedKey = `${redisKey}:policy:3:60`;
    await limiter.consume({ key: redisKey });
    await observer.expire(storedKey, 10);
    await limiter.consume({ key: redisKey });
    expect(await observer.ttl(storedKey)).toBeLessThanOrEqual(10);
    expect(await limiter.consume({ key: redisKey })).toMatchObject({
      allowed: true,
      count: 3,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    await observer.expire(storedKey, 12);
    expect(await limiter.consume({ key: redisKey })).toMatchObject({
      allowed: false,
      count: 3,
      retryAfterSeconds: 12,
    });
    await observer.pExpire(storedKey, 1);
    await expect.poll(() => observer.exists(storedKey)).toBe(0);
    expect(await limiter.consume({ key: redisKey })).toMatchObject({
      allowed: true,
      count: 1,
      remaining: 2,
    });
  });

  // T-RETRY-AFTER-ROUNDING(2026-10-04): Redis TTL은 남은 시간을 반올림해 최대 0.5초 짧게 알려 준다.
  // 화면이 그만큼 일찍 풀려 바로 다시 누르면 한 번 더 막혔다 — 안내는 남은 시간보다 짧으면 안 된다.
  it("never reports a blocked wait shorter than the remaining expiry", async () => {
    const redisKey = key("retry-after-ceiling");
    const storedKey = `${redisKey}:policy:1:60`;
    await limiter.consume({ key: redisKey, limit: 1, windowSeconds: 60 });
    await observer.pExpire(storedKey, 1_400);
    const blocked = await limiter.consume({ key: redisKey, limit: 1, windowSeconds: 60 });
    expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 2 });
    const peeked = await limiter.peek({ key: redisKey, limit: 1, windowSeconds: 60 });
    expect(peeked.retryAfterSeconds).toBe(2);

    const budget = { key: key("retry-after-ceiling-fixed"), limit: 1, windowSeconds: 60 };
    await observer.set(`${budget.key}:fixed:1:60`, "1", { PX: 1_400 });
    expect(await limiter.consumeAll([budget])).toMatchObject({
      allowed: false,
      retryAfterSeconds: 2,
    });
  });

  it("uses an updated administrator pair on the next request across limiter instances", async () => {
    let policy = { max_attempts: 1, cooldown_seconds: 60 };
    const one = createRedisRateLimiter(redisUrl, async () => policy);
    const two = createRedisRateLimiter(redisUrl, async () => policy);
    const redisKey = key("changed-policy");
    try {
      expect((await one.consume({ key: redisKey })).allowed).toBe(true);
      expect((await two.consume({ key: redisKey })).allowed).toBe(false);
      policy = { max_attempts: 2, cooldown_seconds: 15 };
      expect(await two.consume({ key: redisKey })).toMatchObject({
        allowed: true,
        limit: 2,
        count: 1,
        retryAfterSeconds: 15,
      });
      expect((await one.consume({ key: redisKey })).allowed).toBe(true);
      expect((await two.consume({ key: redisKey })).allowed).toBe(false);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it("fails closed with the stable 503 error when Redis is unavailable", async () => {
    const unavailableLimiter = createRedisRateLimiter("redis://127.0.0.1:1");

    try {
      const operation = unavailableLimiter.consume({
        key: key("unavailable"),
        limit: 1,
        windowSeconds: 60,
      });

      await expect(operation).rejects.toMatchObject({
        response: {
          code: "RATE_LIMIT_SERVICE_UNAVAILABLE",
          message: "요청 제한 서비스를 사용할 수 없습니다.",
        },
        status: 503,
      });
      await expect(operation).rejects.toBeInstanceOf(RateLimitServiceUnavailableException);
    } finally {
      await unavailableLimiter.close();
    }
  });

  it("fails closed on a connected response stall and reconnects for the next request", async () => {
    const stalledLimiter = createRedisRateLimiter(redisUrl);
    let operation: Promise<unknown> | undefined;

    try {
      await stalledLimiter.ensureAvailable();
      await observer.sendCommand(["CLIENT", "PAUSE", "4000", "ALL"]);

      operation = stalledLimiter.consume({
        key: key("response-stall"),
        limit: 1,
        windowSeconds: 60,
      });
      const stalledError = await withSafetyDeadline(operation, 2_500).then(
        () => new Error("Expected the stalled Redis operation to fail closed."),
        (error: unknown) => error,
      );
      expect(stalledError).toBeInstanceOf(RateLimitServiceUnavailableException);
      expect(stalledError).toMatchObject({
        response: { code: "RATE_LIMIT_SERVICE_UNAVAILABLE" },
        status: 503,
      });

      await observer.sendCommand(["CLIENT", "UNPAUSE"]);
      const recovered = await stalledLimiter.consume({
        key: key("after-response-stall"),
        limit: 1,
        windowSeconds: 60,
      });
      expect(recovered).toMatchObject({ allowed: true, count: 1 });
    } finally {
      await observer.sendCommand(["CLIENT", "UNPAUSE"]).catch(() => undefined);
      await operation?.catch(() => undefined);
      await stalledLimiter.close();
    }
  }, 15_000);
});
