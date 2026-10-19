import { describe, expect, it, vi } from "vitest";
import { cachedRequestLimitPolicy, invalidateRequestLimitPolicy } from "./request-limit-policy.js";

describe("bounded request policy cache", () => {
  it("coalesces concurrent refresh, protects cached values and expires within two seconds", async () => {
    let now = 0;
    const load = vi.fn(async () => ({ max_attempts: 3, cooldown_seconds: 60 }));
    const get = cachedRequestLimitPolicy(load, () => now);
    const results = await Promise.all(Array.from({ length: 100 }, () => get()));
    expect(load).toHaveBeenCalledOnce();
    results[0]!.max_attempts = 20;
    expect((await get()).max_attempts).toBe(3);
    now = 2_000;
    await Promise.all([get(), get()]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidates after a committed update and discards an older refresh in flight", async () => {
    let resolve!: (value: { max_attempts: number; cooldown_seconds: number }) => void;
    const load = vi.fn(async () => ({ max_attempts: 2, cooldown_seconds: 120 }));
    load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const get = cachedRequestLimitPolicy(load);
    const reading = get();
    invalidateRequestLimitPolicy();
    resolve({ max_attempts: 20, cooldown_seconds: 1 });
    await expect(reading).resolves.toEqual({ max_attempts: 2, cooldown_seconds: 120 });
    expect(load).toHaveBeenCalledTimes(2);
    invalidateRequestLimitPolicy();
    await get();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("fails closed after expiry and briefly caches failures instead of hammering the database", async () => {
    let now = 0;
    const load = vi.fn(async () => ({ max_attempts: 3, cooldown_seconds: 60 }));
    const get = cachedRequestLimitPolicy(load, () => now);
    await get();
    load.mockRejectedValue(new Error("database unavailable"));
    now = 2_000;
    await expect(get()).rejects.toThrow("database unavailable");
    await expect(get()).rejects.toThrow("database unavailable");
    expect(load).toHaveBeenCalledTimes(2);
    now += 250;
    load.mockResolvedValue({ max_attempts: 1, cooldown_seconds: 60 });
    await expect(get()).resolves.toEqual({ max_attempts: 1, cooldown_seconds: 60 });
  });
});
