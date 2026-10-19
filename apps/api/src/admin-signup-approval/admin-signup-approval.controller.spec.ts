import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminRolesGuard } from "../admin-auth/admin-roles.guard.js";
import { AdminSessionGuard } from "../admin-auth/admin-session.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import { AdminSignupApprovalController } from "./admin-signup-approval.controller.js";

const methodGuards = (method: "issue" | "list" | "revoke") =>
  Reflect.getMetadata("__guards__", AdminSignupApprovalController.prototype[method]) ?? [];

describe("AdminSignupApprovalController security and list contract", () => {
  it("allows only account managers and super administrators", () => {
    expect(
      Reflect.getMetadata("classhub:required-admin-roles", AdminSignupApprovalController),
    ).toEqual(["super_admin", "account_manager"]);
    expect(Reflect.getMetadata("__guards__", AdminSignupApprovalController)).toEqual(
      expect.arrayContaining([AdminSessionGuard, AdminRolesGuard]),
    );
  });

  it("keeps the read endpoint refreshable without weakening mutation guards", () => {
    expect(methodGuards("list")).toEqual([]);
    expect(methodGuards("issue")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
    expect(methodGuards("revoke")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
  });

  it("delegates list reads without adding approval secrets", async () => {
    const response = {
      approvals: [
        {
          consumed_at: null,
          expires_at: "2030-01-01T00:10:00.000Z",
          id: "approval-1",
          issued_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
          role: "student",
          status: "active",
        },
      ],
    };
    const service = { list: vi.fn(async () => response) };

    await expect(new AdminSignupApprovalController(service as never).list()).resolves.toEqual(
      response,
    );
    expect(service.list).toHaveBeenCalledOnce();
    expect(JSON.stringify(response)).not.toMatch(/code|digest|email/iu);
  });
});
