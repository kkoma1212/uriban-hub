import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";

import { ConfirmPasswordResetRequestDto, PasswordResetRequestDto } from "./password-reset.dto.js";

describe("password reset DTOs", () => {
  it("normalizes a valid request email", () => {
    const instance = plainToInstance(PasswordResetRequestDto, {
      email: " Student@Example.COM ",
    });
    expect(validateSync(instance)).toHaveLength(0);
    expect(instance.email).toBe("student@example.com");
  });

  it.each(["missing-at-sign", "", 42])("rejects invalid request email %j", (email) => {
    expect(
      validateSync(plainToInstance(PasswordResetRequestDto, { email })).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a 32-byte base64url token and the shared password policy", () => {
    const instance = plainToInstance(ConfirmPasswordResetRequestDto, {
      new_password: "Reset123",
      token: "A".repeat(43),
    });
    expect(validateSync(instance)).toHaveLength(0);
  });

  it.each([
    [5, `A1${"😀".repeat(3)}`, false],
    [6, `A1${"😀".repeat(4)}`, true],
    [8, `A1${"😀".repeat(6)}`, true],
    [9, `A1${"😀".repeat(7)}`, true],
    [1026, `A1${"😀".repeat(1024)}`, true],
  ] as const)(
    "counts a %i-character password by Unicode code point",
    (_length, password, valid) => {
      const errors = validateSync(
        plainToInstance(ConfirmPasswordResetRequestDto, {
          new_password: password,
          token: "A".repeat(43),
        }),
      );
      expect(errors.length === 0).toBe(valid);
    },
  );

  it.each([
    { new_password: "Safe1", token: "A".repeat(43) },
    { new_password: "contains-newline\n123", token: "A".repeat(43) },
    { new_password: "x".repeat(73), token: "A".repeat(43) },
    { new_password: "Reset123", token: "A".repeat(42) },
    { new_password: "Reset123", token: `${"A".repeat(42)}!` },
  ])("rejects an invalid confirmation payload", (payload) => {
    expect(
      validateSync(plainToInstance(ConfirmPasswordResetRequestDto, payload)).length,
    ).toBeGreaterThan(0);
  });
});
