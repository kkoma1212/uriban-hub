import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { validate } from "class-validator";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { AdminAccountsController } from "./admin-accounts.controller.js";
import {
  CreateAdminAccountDto,
  ReplaceAdminAccountRolesDto,
  UpdateAdminAccountStatusDto,
} from "./admin-accounts.dto.js";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import { AdminRolesGuard } from "../admin-auth/admin-roles.guard.js";

describe("admin account security contract", () => {
  it("restricts controller to super_admin and protects every mutation with csrf + step-up", () => {
    expect(Reflect.getMetadata("classhub:required-admin-roles", AdminAccountsController)).toEqual([
      "super_admin",
    ]);
    for (const method of [
      "create",
      "updateStatus",
      "replaceRoles",
      "resetCredentials",
      "resetMfa",
    ]) {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (AdminAccountsController.prototype as unknown as Record<string, unknown>)[method] as object,
      );
      expect(guards).toEqual(expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]));
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAccountsController)).toEqual(
      expect.arrayContaining([AdminRolesGuard]),
    );
  });

  it("requires at least one role and validates status/reason", async () => {
    const create = Object.assign(new CreateAdminAccountDto(), {
      email: "a@example.com",
      display_name: "Admin",
      roles: [],
    });
    expect((await validate(create)).map((e) => e.property)).toContain("roles");
    const roles = Object.assign(new ReplaceAdminAccountRolesDto(), { roles: [], reason: "" });
    const roleErrors = await validate(roles);
    expect(roleErrors.map((e) => e.property)).toEqual(expect.arrayContaining(["roles", "reason"]));
    const status = Object.assign(new UpdateAdminAccountStatusDto(), {
      status: "bogus",
      reason: "",
    });
    const statusErrors = await validate(status);
    expect(statusErrors.map((e) => e.property)).toEqual(
      expect.arrayContaining(["status", "reason"]),
    );
  });
});
