import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";

import { AdminAuthController } from "./admin-auth.controller.js";
import { AdminChangePasswordRequestDto } from "./admin-auth.dto.js";
import { AdminCsrfGuard } from "./admin-csrf.guard.js";
import { AdminStepUpGuard } from "./admin-step-up.guard.js";

describe("administrator password change contract", () => {
  it("requires CSRF and recent step-up authentication", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminAuthController.prototype.changePassword,
    );
    expect(guards).toEqual(expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]));
  });
  it("requires session authentication and Origin/CSRF validation, but no extra password or OTP for renewal", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAuthController.prototype.renew)).toEqual([
      AdminCsrfGuard,
    ]);
  });

  it("requires at least six code points with letters and digits, without an upper length limit", () => {
    expect(
      validateSync(
        plainToInstance(AdminChangePasswordRequestDto, {
          new_password: "가".repeat(5) + "1",
        }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(AdminChangePasswordRequestDto, {
          new_password: "가".repeat(4) + "1",
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(AdminChangePasswordRequestDto, { new_password: "가".repeat(7) + "1" }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(AdminChangePasswordRequestDto, { new_password: "가".repeat(130) + "1" }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(AdminChangePasswordRequestDto, { new_password: "가".repeat(8) }))
        .length,
    ).toBeGreaterThan(0);
  });
});
