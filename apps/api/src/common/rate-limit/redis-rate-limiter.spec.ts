import { afterEach, describe, expect, it, vi } from "vitest";

import { RateLimitServiceUnavailableException } from "./rate-limit.errors.js";
import { createRedisRateLimiter, RedisRateLimiter } from "./redis-rate-limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RedisRateLimiter input validation", () => {
  it.each([
    { key: "", limit: 1, windowSeconds: 1 },
    { key: "classhub:rate-limit:test", limit: 0, windowSeconds: 1 },
    { key: "classhub:rate-limit:test", limit: 1, windowSeconds: 0 },
  ])("rejects an invalid request before connecting", async (request) => {
    const limiter = createRedisRateLimiter("redis://127.0.0.1:1");

    await expect(limiter.consume(request)).rejects.toBeInstanceOf(RangeError);
    await limiter.close();
  });

  it.each([
    { key: "", limit: 1, windowSeconds: 1 },
    { key: "classhub:rate-limit:test", limit: 0, windowSeconds: 1 },
    { key: "classhub:rate-limit:test", limit: 1, windowSeconds: 0 },
  ])("rejects an invalid peek request before connecting", async (request) => {
    const limiter = createRedisRateLimiter("redis://127.0.0.1:1");

    await expect(limiter.peek(request)).rejects.toBeInstanceOf(RangeError);
    await limiter.close();
  });

  it("reads an exhausted counter without incrementing it", async () => {
    const client = {
      connect: vi.fn(),
      destroy: vi.fn(),
      eval: vi.fn().mockResolvedValue([20, 321]),
      isOpen: true,
      isReady: true,
      ping: vi.fn(),
    };
    const limiter = new RedisRateLimiter(client as never);

    await expect(
      limiter.peek({
        key: "classhub:rate-limit:login-failure",
        limit: 20,
        windowSeconds: 15 * 60,
      }),
    ).resolves.toEqual({
      allowed: false,
      count: 20,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 321,
    });
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("'GET'"), {
      arguments: [],
      keys: ["classhub:rate-limit:login-failure:policy:20:900"],
    });
    expect(client.eval.mock.calls[0]?.[0]).not.toContain("'INCR'");
  });

  it("allows a missing counter and fails closed on an invalid read result", async () => {
    const client = {
      connect: vi.fn(),
      destroy: vi.fn(),
      eval: vi.fn().mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([20, -1]),
      isOpen: true,
      isReady: true,
      ping: vi.fn(),
    };
    const limiter = new RedisRateLimiter(client as never);
    const request = {
      key: "classhub:rate-limit:login-failure",
      limit: 20,
      windowSeconds: 15 * 60,
    };

    await expect(limiter.peek(request)).resolves.toEqual({
      allowed: true,
      count: 0,
      limit: 20,
      remaining: 20,
      retryAfterSeconds: 1,
    });
    await expect(limiter.peek(request)).rejects.toBeInstanceOf(
      RateLimitServiceUnavailableException,
    );
  });

  it("destroys a ready client when an EVAL response exceeds the operation deadline", async () => {
    vi.useFakeTimers();
    let isOpen = true;
    let isReady = true;
    const client = {
      connect: vi.fn(),
      destroy: vi.fn(() => {
        isOpen = false;
        isReady = false;
      }),
      eval: vi.fn(() => new Promise<never>(() => undefined)),
      get isOpen() {
        return isOpen;
      },
      get isReady() {
        return isReady;
      },
      ping: vi.fn(),
    };
    const limiter = new RedisRateLimiter(client as never);
    const operation = limiter.consume({
      key: "classhub:rate-limit:stalled-eval",
      limit: 1,
      windowSeconds: 60,
    });
    const rejection = expect(operation).rejects.toBeInstanceOf(
      RateLimitServiceUnavailableException,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys a client whose connection handshake exceeds the operation deadline", async () => {
    vi.useFakeTimers();
    let isOpen = false;
    let isReady = false;
    const client = {
      connect: vi.fn(() => {
        isOpen = true;
        return new Promise<never>(() => undefined);
      }),
      destroy: vi.fn(() => {
        isOpen = false;
        isReady = false;
      }),
      get isOpen() {
        return isOpen;
      },
      get isReady() {
        return isReady;
      },
      ping: vi.fn(),
    };
    const limiter = new RedisRateLimiter(client as never);
    const operation = limiter.ensureAvailable();
    const rejection = expect(operation).rejects.toBeInstanceOf(
      RateLimitServiceUnavailableException,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.ping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
