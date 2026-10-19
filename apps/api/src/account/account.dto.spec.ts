import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import {
  ChangePasswordRequestDto,
  DeleteAccountRequestDto,
  UpdateAccountProfileRequestDto,
} from "./account.dto.js";

function errorsFor(values: Record<string, unknown>): number {
  return validateSync(plainToInstance(ChangePasswordRequestDto, values)).length;
}

describe("ChangePasswordRequestDto", () => {
  it("accepts the shared password policy", () => {
    expect(errorsFor({ current_password: "temporary", new_password: "Change45" })).toBe(0);
    expect(
      errorsFor({ current_password: "long7!".repeat(128), new_password: "새로운7!".repeat(128) }),
    ).toBe(0);
  });

  it("rejects missing or policy-incomplete passwords", () => {
    const valid = { current_password: "temporary", new_password: "Change45" };
    for (const values of [
      { ...valid, current_password: "" },
      { ...valid, new_password: "Safe1" },
      { ...valid, new_password: "12345678" },
      { ...valid, new_password: "password" },
      { ...valid, new_password: 12345678 },
    ]) {
      expect(errorsFor(values)).toBeGreaterThan(0);
    }
  });
});

describe("DeleteAccountRequestDto", () => {
  function deletionErrorsFor(values: Record<string, unknown>): number {
    return validateSync(plainToInstance(DeleteAccountRequestDto, values)).length;
  }

  it("requires the current password and exact Korean confirmation phrase", () => {
    expect(
      deletionErrorsFor({ confirmation: "탈퇴", current_password: "currentPassword123" }),
    ).toBe(0);

    for (const values of [
      { confirmation: "", current_password: "currentPassword123" },
      { confirmation: "탈퇴 ", current_password: "currentPassword123" },
      { confirmation: "계정 탈퇴", current_password: "currentPassword123" },
      { confirmation: "탈퇴", current_password: "" },
      { confirmation: "탈퇴", current_password: 12345678 },
    ]) {
      expect(deletionErrorsFor(values)).toBeGreaterThan(0);
    }
  });
});

describe("UpdateAccountProfileRequestDto", () => {
  function profileErrorsFor(values: Record<string, unknown>): number {
    return validateSync(plainToInstance(UpdateAccountProfileRequestDto, values)).length;
  }

  it("trims before accepting a 2-20 Unicode code-point plain-text display name", () => {
    const instance = plainToInstance(UpdateAccountProfileRequestDto, {
      display_name: "  학생 이름  ",
    });
    expect(validateSync(instance)).toHaveLength(0);
    expect(instance.display_name).toBe("학생 이름");
    expect(profileErrorsFor({ display_name: "😀".repeat(20) })).toBe(0);
  });

  it("rejects invalid length, HTML elements, line breaks, and control characters", () => {
    for (const displayName of [
      "가",
      "😀".repeat(21),
      "<b>학생</b>",
      "학생\n이름",
      "학생\u0000이름",
    ]) {
      expect(profileErrorsFor({ display_name: displayName })).toBeGreaterThan(0);
    }
    expect(profileErrorsFor({ display_name: 1234 })).toBeGreaterThan(0);
  });
});
