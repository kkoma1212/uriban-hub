import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordWorkCapacityError, PasswordWorkLimiter } from "./password-work-limiter.js";

afterEach(() => vi.useRealTimers());
describe("password work capacity", () => {
  it("bounds active and waiting work, preserves FIFO and recovers after rejection", async () => {
    const limiter = new PasswordWorkLimiter(1, 1);
    let release!: () => void;
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const queued = vi.fn(async () => "second");
    const second = limiter.run(queued);
    const excess = vi.fn(async () => "excess");
    await expect(limiter.run(excess)).rejects.toBeInstanceOf(PasswordWorkCapacityError);
    expect(queued).not.toHaveBeenCalled();
    expect(excess).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).resolves.toBe("second");
    await expect(
      limiter.run(async () => {
        throw new Error("KDF failed");
      }),
    ).rejects.toThrow("KDF failed");
    await expect(limiter.run(async () => "recovered")).resolves.toBe("recovered");
  });

  it("expires queued work without running it or releasing an active native operation", async () => {
    vi.useFakeTimers();
    const limiter = new PasswordWorkLimiter(1, 1, 50);
    let release!: () => void;
    const active = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const work = vi.fn(async () => undefined);
    const outcome = limiter.run(work).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await outcome).toBeInstanceOf(PasswordWorkCapacityError);
    expect(work).not.toHaveBeenCalled();
    const waiting = limiter.run(work);
    expect(work).not.toHaveBeenCalled();
    release();
    await Promise.all([active, waiting]);
    expect(work).toHaveBeenCalledOnce();
  });
});
