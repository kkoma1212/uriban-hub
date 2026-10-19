import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicAccountResponse } from "./public-account-response.js";

describe("public account response timing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([0, 25, 350, 499])(
    "pads a %d ms operation to the same floor without blocking",
    async (elapsed) => {
      vi.useFakeTimers();
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(elapsed);
      const completed = vi.fn();
      const result = publicAccountResponse(async () => ({ request_accepted: true })).then(
        completed,
      );
      await vi.advanceTimersByTimeAsync(499 - elapsed);
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(completed).toHaveBeenCalledExactlyOnceWith({ request_accepted: true });
    },
  );

  it("does not add latency to slow work or replace its result", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(900);
    await expect(publicAccountResponse(async () => "accepted")).resolves.toBe("accepted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves errors after the same floor and never converts failure to acceptance", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const failure = new Error("storage unavailable");
    const rejected = vi.fn();
    const result = publicAccountResponse(async () => {
      throw failure;
    }).catch(rejected);
    await vi.advanceTimersByTimeAsync(499);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
