import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import { SignUpRequestDto } from "../../auth/auth.dto.js";
import { CreateLocalTestAccountDto } from "../../local-test-admin/local-test-admin.dto.js";
import { ApproveMemberDto, MemberReasonDto } from "../../members/members.dto.js";

function errorsFor<T extends object>(type: new () => T, values: Partial<T>): number {
  return validateSync(plainToInstance(type, values)).length;
}

describe("user-visible DTO text validation", () => {
  it("uses code-point and plain-text rules for signup display names", () => {
    const valid = {
      age_route: "over_14" as const,
      approval_code: "123456",
      consents: { privacy: true as const, terms: true as const },
      display_name: "학생 <3",
      email: "student@example.com",
      password: "unit-test-safe-123",
      role: "student" as const,
    };
    expect(errorsFor(SignUpRequestDto, valid)).toBe(0);
    expect(
      errorsFor(SignUpRequestDto, { ...valid, display_name: "❤️".repeat(20) }),
    ).toBeGreaterThan(0);
    expect(errorsFor(SignUpRequestDto, { ...valid, display_name: "<b>학생</b>" })).toBeGreaterThan(
      0,
    );
  });

  it("applies the same rules to local test and member text fields", () => {
    expect(
      errorsFor(CreateLocalTestAccountDto, {
        display_name: "<b>학생</b>",
        email: "student@example.com",
        email_verified: true,
        password: "unit-test-safe-123",
      }),
    ).toBeGreaterThan(0);
    expect(
      errorsFor(ApproveMemberDto, {
        display_name_in_class: "<b>학생</b>",
        student_number: null,
      }),
    ).toBeGreaterThan(0);
    expect(errorsFor(MemberReasonDto, { reason: "<b>사유</b>" })).toBeGreaterThan(0);
  });
});
