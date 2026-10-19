import { describe, expect, it } from "vitest";

import { newPasswordSchema, passwordConfirmationSchema } from "./password-policy";

describe("browser new-password policy", () => {
  it("normalizes NFC before applying the six-code-point minimum without a maximum", () => {
    expect(newPasswordSchema.parse("e\u0301".repeat(5) + "1")).toBe("é".repeat(5) + "1");
    expect(newPasswordSchema.safeParse("😀".repeat(3) + "a1").success).toBe(false);
    expect(newPasswordSchema.safeParse("😀".repeat(4) + "a1").success).toBe(true);
    expect(newPasswordSchema.safeParse("😀".repeat(6) + "a1").success).toBe(true);
    expect(newPasswordSchema.safeParse("😀".repeat(7) + "a1").success).toBe(true);
    const longPassword = "봄날의하늘7!".repeat(128);
    expect(newPasswordSchema.parse(longPassword)).toBe(longPassword);
    expect(passwordConfirmationSchema.parse(longPassword)).toBe(longPassword);
  });

  it("requires letters and numbers while allowing Korean passphrases", () => {
    expect(newPasswordSchema.safeParse("Cloud1").success).toBe(true);
    expect(newPasswordSchema.safeParse("abcdefghijklmno").success).toBe(false);
    expect(newPasswordSchema.safeParse("12345678!").success).toBe(false);
    expect(newPasswordSchema.safeParse("한글 쉼표1!").success).toBe(true);
  });

  it.each(["valid password\n", "valid password\u0000", "valid password\u200B"])(
    "rejects invisible or control input: %j",
    (candidate) => {
      expect(newPasswordSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it("normalizes the confirmation independently for equality checks", () => {
    expect(passwordConfirmationSchema.parse("e\u0301".repeat(5) + "1")).toBe("é".repeat(5) + "1");
  });
});
