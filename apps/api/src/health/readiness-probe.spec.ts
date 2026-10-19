import { describe, expect, it, vi } from "vitest";

import { ReadinessProbeCoordinator } from "./readiness-probe.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ReadinessProbeCoordinator", () => {
  it("requires both dependency probes to succeed", async () => {
    const database = vi.fn().mockResolvedValue(undefined);
    const redis = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ReadinessProbeCoordinator({ database, redis }, 50);

    await expect(coordinator.isReady()).resolves.toBe(true);
    expect(database).toHaveBeenCalledOnce();
    expect(redis).toHaveBeenCalledOnce();
  });

  it.each(["database", "redis"] as const)(
    "fails closed when the %s probe rejects",
    async (failedProbe) => {
      const database = vi.fn().mockResolvedValue(undefined);
      const redis = vi.fn().mockResolvedValue(undefined);
      const failed = new Error("postgresql://user:secret@db or redis://:secret@cache");
      (failedProbe === "database" ? database : redis).mockRejectedValueOnce(failed);
      const coordinator = new ReadinessProbeCoordinator({ database, redis }, 50);

      await expect(coordinator.isReady()).resolves.toBe(false);
    },
  );

  it("bounds responses and reuses one unresolved probe instead of building a probe storm", async () => {
    const stalled = deferred();
    const database = vi.fn(() => stalled.promise);
    const redis = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ReadinessProbeCoordinator({ database, redis }, 10);

    await expect(
      Promise.all(Array.from({ length: 12 }, () => coordinator.isReady())),
    ).resolves.toEqual(Array.from({ length: 12 }, () => false));
    expect(database).toHaveBeenCalledOnce();
    expect(redis).toHaveBeenCalledOnce();

    await expect(coordinator.isReady()).resolves.toBe(false);
    expect(database).toHaveBeenCalledOnce();
    expect(redis).toHaveBeenCalledOnce();

    stalled.resolve();
    await stalled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(coordinator.isReady()).resolves.toBe(true);
    expect(database).toHaveBeenCalledTimes(2);
    expect(redis).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid response deadline", () => {
    expect(
      () =>
        new ReadinessProbeCoordinator(
          {
            database: vi.fn().mockResolvedValue(undefined),
            redis: vi.fn().mockResolvedValue(undefined),
          },
          0,
        ),
    ).toThrow(RangeError);
  });
});
