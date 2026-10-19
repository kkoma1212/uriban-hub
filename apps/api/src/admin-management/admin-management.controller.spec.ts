import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { AdminCsrfGuard } from "../admin-auth/admin-csrf.guard.js";
import { AdminStepUpGuard } from "../admin-auth/admin-step-up.guard.js";
import {
  AdminActivityTrendQueryDto,
  ListAdminClassActivityQueryDto,
  ListAdminClassesQueryDto,
  ListAdminPeopleQueryDto,
} from "./admin-directory.dto.js";
import { maskEmail } from "./admin-directory.service.js";
import { summarizeDevice } from "./admin-sessions.service.js";
import { AdminManagementController } from "./admin-management.controller.js";
import {
  CreateAdminTermsVersionDto,
  ListAdminMembersQueryDto,
  ListAdminTermsConsentsQueryDto,
  UpdateAdminInquiryDto,
  UpdateAdminMemberStatusDto,
} from "./admin-management.dto.js";

const roles = (method: string) =>
  Reflect.getMetadata(
    "classhub:required-admin-roles",
    AdminManagementController.prototype[method as keyof typeof AdminManagementController.prototype],
  );
const guards = (method: string) =>
  Reflect.getMetadata(
    "__guards__",
    AdminManagementController.prototype[method as keyof typeof AdminManagementController.prototype],
  ) ?? [];

describe("AdminManagementController security contract", () => {
  it("declares least-privilege role metadata for management endpoints", () => {
    expect(roles("listUsers")).toEqual(["super_admin", "account_manager", "support"]);
    expect(roles("listClasses")).toEqual(["super_admin", "account_manager", "support"]);
    expect(roles("listPeople")).toEqual(["super_admin", "account_manager", "support"]);
    expect(roles("operationsStatus")).toEqual(["super_admin", "security_auditor"]);
    expect(roles("listSessions")).toEqual(["super_admin", "security_auditor"]);
    expect(roles("revokeSession")).toEqual(["super_admin"]);
    expect(guards("revokeSession")).toEqual([AdminCsrfGuard, AdminStepUpGuard]);
    expect(roles("listClassActivity")).toEqual(["super_admin", "account_manager", "support"]);
    expect(roles("activityTrend")).toEqual([
      "super_admin",
      "account_manager",
      "support",
      "security_auditor",
    ]);
    expect(roles("listMembers")).toEqual(["super_admin", "account_manager"]);
    expect(roles("update")).toEqual(["super_admin", "account_manager"]);
    expect(roles("createTerms")).toEqual(["super_admin"]);
    expect(roles("listTerms")).toEqual(["super_admin", "security_auditor"]);
    expect(roles("listConsents")).toEqual(["super_admin", "security_auditor"]);
    expect(roles("listInquiries")).toEqual(["super_admin", "support"]);
    expect(roles("updateInquiry")).toEqual(["super_admin", "support"]);
  });

  it("protects mutations with CSRF and step-up where policy requires it", () => {
    expect(guards("update")).toEqual(expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]));
    expect(guards("createTerms")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
    expect(guards("updateState")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
    expect(guards("updateInquiry")).toEqual(expect.arrayContaining([AdminCsrfGuard]));
    expect(guards("updateUserStatus")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
    expect(guards("resetUserPassword")).toEqual(
      expect.arrayContaining([AdminCsrfGuard, AdminStepUpGuard]),
    );
  });

  it("validates terms payload and member status DTOs", () => {
    expect(
      validateSync(
        plainToInstance(CreateAdminTermsVersionDto, {
          document_type: "terms",
          policy_version: "2026.09",
          title: "서비스 약관",
          content: "본문",
        }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(CreateAdminTermsVersionDto, {
          document_type: "marketing",
          policy_version: "",
          title: "",
          content: "",
        }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(plainToInstance(UpdateAdminMemberStatusDto, { status: "approved" })),
    ).toHaveLength(0);
    expect(
      validateSync(plainToInstance(UpdateAdminMemberStatusDto, { status: "unknown" })).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(plainToInstance(UpdateAdminMemberStatusDto, { status: "removed" })).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(UpdateAdminMemberStatusDto, {
          reason: "운영자 확인 후 처리",
          status: "removed",
        }),
      ),
    ).toHaveLength(0);
  });

  it("requires scoped personal-data searches and accepts explicit inquiry unassignment", () => {
    expect(
      validateSync(plainToInstance(ListAdminMembersQueryDto, {})).map((error) => error.property),
    ).toContain("search");
    expect(
      validateSync(plainToInstance(ListAdminMembersQueryDto, { search: "김학생" })),
    ).toHaveLength(0);

    expect(
      validateSync(plainToInstance(ListAdminTermsConsentsQueryDto, {})).map(
        (error) => error.property,
      ),
    ).toEqual(expect.arrayContaining(["consent_type", "policy_version"]));
    expect(
      validateSync(
        plainToInstance(ListAdminTermsConsentsQueryDto, {
          consent_type: "terms",
          policy_version: "2026-09-03",
        }),
      ),
    ).toHaveLength(0);

    expect(
      validateSync(
        plainToInstance(UpdateAdminInquiryDto, {
          assigned_admin_account_id: null,
          status: "open",
        }),
      ),
    ).toHaveLength(0);
  });

  it("lists classes without a search term but rejects bad filters and pages", () => {
    const errors = (value: object) =>
      validateSync(plainToInstance(ListAdminClassesQueryDto, value)).map((error) => error.property);
    expect(errors({})).toEqual([]);
    expect(errors({ search: "합성", status: "active", page: "2" })).toEqual([]);
    expect(errors({ search: "a" })).toContain("search");
    expect(errors({ status: "deleted" })).toContain("status");
    expect(errors({ page: "0" })).toContain("page");
    expect(errors({ page: "1.5" })).toContain("page");
  });

  it("lists people without a search term, rejects bad filters and masks emails", () => {
    const errors = (value: object) =>
      validateSync(plainToInstance(ListAdminPeopleQueryDto, value)).map((error) => error.property);
    expect(errors({})).toEqual([]);
    expect(errors({ role: "teacher", status: "pending", page: "3" })).toEqual([]);
    expect(errors({ role: "admin" })).toContain("role");
    expect(errors({ status: "deleted" })).toContain("status");
    expect(errors({ page: "0" })).toContain("page");
    expect(maskEmail("student1@example.com")).toBe("st***@example.com");
    expect(maskEmail("ab@example.com")).toBe("a***@example.com");
    expect(maskEmail("a@example.com")).toBe("***@example.com");
    expect(maskEmail("broken")).toBe("***");
    const chromeWindows =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(summarizeDevice(chromeWindows)).toBe("Chrome · Windows");
    expect(summarizeDevice(chromeWindows.replace("Chrome/140.0", "Chrome/140.0 Whale/4.0"))).toBe(
      "웨일 · Windows",
    );
    expect(
      summarizeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iOS");
    expect(summarizeDevice(null)).toBe("알 수 없음");
    expect(summarizeDevice("curl/8.0")).toBe("기타");
  });

  it("reads class activity for 7 or 30 days only", () => {
    const errors = (value: object) =>
      validateSync(plainToInstance(ListAdminClassActivityQueryDto, value)).map(
        (error) => error.property,
      );
    expect(errors({})).toEqual([]);
    expect(errors({ days: "30", page: "2" })).toEqual([]);
    expect(errors({ days: "14" })).toContain("days");
    expect(errors({ days: "7; DROP" })).toContain("days");
    expect(errors({ page: "0" })).toContain("page");
    const trendErrors = (value: object) =>
      validateSync(plainToInstance(AdminActivityTrendQueryDto, value)).map(
        (error) => error.property,
      );
    expect(trendErrors({})).toEqual([]);
    expect(trendErrors({ days: "30" })).toEqual([]);
    expect(trendErrors({ days: "90" })).toContain("days");
  });
});
