import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller.js";
import { EmailAlreadyRegisteredException, InvalidGuardianConsentException } from "./auth.errors.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";

describe("anonymous signup response", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(600);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const request = { ip: "192.0.2.1", id: "synthetic-request", headers: {} } as never;
  const command = { email: "student@example.invalid" } as never;
  function controller(signUp: () => Promise<unknown>) {
    return new AuthController({ signUp } as never, {} as never, {} as never, {} as never);
  }

  it.each(["sent", "failed", "queued"])(
    "removes the internal %s delivery outcome and identifiers",
    async (status) => {
      const signUp = vi.fn().mockResolvedValue({
        next_action: "LOGIN",
        signup_delivery_status: status,
        user_id: "private",
      });
      await expect(controller(signUp).signUp(command, request)).resolves.toEqual({
        next_action: "LOGIN",
        request_accepted: true,
      });
      expect(signUp).toHaveBeenCalledExactlyOnceWith(command, "192.0.2.1", {
        requestId: "synthetic-request",
        userAgent: undefined,
      });
    },
  );

  it("returns the identical response for a confirmed duplicate", async () => {
    await expect(
      controller(async () => {
        throw new EmailAlreadyRegisteredException();
      }).signUp(command, request),
    ).resolves.toEqual({ next_action: "LOGIN", request_accepted: true });
  });

  it.each([
    new RateLimitedException(60),
    new InvalidGuardianConsentException(),
    new Error("database failure"),
  ])("preserves an unrelated failure rather than reporting success: %s", async (error) => {
    await expect(
      controller(async () => {
        throw error;
      }).signUp(command, request),
    ).rejects.toBe(error);
  });
});
