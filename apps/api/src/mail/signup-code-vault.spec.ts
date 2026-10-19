import { describe, expect, it } from "vitest";
import { decryptSignupCode, encryptSignupCode } from "./signup-code-vault.js";

describe("recoverable signup code", () => {
  it("recovers the exact mailed code only for its recipient, role and secret", () => {
    const encrypted = encryptSignupCode(
      "003821",
      "synthetic-vault-key",
      "member@example.com",
      "student",
    );
    expect(encrypted).not.toContain("003821");
    expect(
      decryptSignupCode(encrypted, "synthetic-vault-key", "member@example.com", "student"),
    ).toBe("003821");
    for (const [key, email, role] of [
      ["another-key", "member@example.com", "student"],
      ["synthetic-vault-key", "another@example.com", "student"],
      ["synthetic-vault-key", "member@example.com", "teacher"],
    ])
      expect(() => decryptSignupCode(encrypted, key!, email!, role!)).toThrow();
  });
});
