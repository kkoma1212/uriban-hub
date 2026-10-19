import { NotFoundException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PasswordResetEnabledGuard } from "./password-reset-enabled.guard.js";

function makeGuard(enabled: boolean) {
  const config = {
    get: vi.fn(() => enabled),
  };

  return {
    config,
    guard: new PasswordResetEnabledGuard(config as never),
  };
}

describe("PasswordResetEnabledGuard", () => {
  it("fails closed with an explicit unavailable 404 when password reset is disabled", () => {
    const { config, guard } = makeGuard(false);

    expect(() => guard.canActivate({} as ExecutionContext)).toThrow(NotFoundException);
    expect(() => guard.canActivate({} as ExecutionContext)).toThrowError(
      expect.objectContaining({
        status: 404,
        response: expect.objectContaining({ code: "PASSWORD_RESET_UNAVAILABLE" }),
      }),
    );
    expect(config.get).toHaveBeenCalledWith("PASSWORD_RESET_ENABLED", {
      infer: true,
    });
  });

  it("allows the request only when password reset is explicitly enabled", () => {
    const { config, guard } = makeGuard(true);

    expect(guard.canActivate({} as ExecutionContext)).toBe(true);

    expect(config.get).toHaveBeenCalledWith("PASSWORD_RESET_ENABLED", {
      infer: true,
    });
  });
});
