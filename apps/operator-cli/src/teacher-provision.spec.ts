import { describe, expect, it } from "vitest";

import {
  generateTemporaryPassword,
  normalizeTeacherDisplayName,
  normalizeTeacherEmail,
} from "./teacher-provision.js";

describe("teacher provisioning input", () => {
  it("normalizes email and plain display name", () => {
    expect(normalizeTeacherEmail(" Teacher@Example.COM ")).toBe("teacher@example.com");
    expect(normalizeTeacherDisplayName("  담임 선생님  ")).toBe("담임 선생님");
  });

  it.each(["teacher", "@example.com", "teacher @example.com"])(
    "rejects invalid email %s",
    (email) => {
      expect(() => normalizeTeacherEmail(email)).toThrow();
    },
  );

  it.each(["한", "가".repeat(21), "<b>담임</b>", "담임\n선생님"])(
    "rejects invalid display name %s",
    (displayName) => {
      expect(() => normalizeTeacherDisplayName(displayName)).toThrow();
    },
  );

  it("generates a policy-compliant, high-entropy one-time password", () => {
    const first = generateTemporaryPassword();
    const second = generateTemporaryPassword();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first.length).toBeLessThanOrEqual(72);
    expect(first).toMatch(/[A-Za-z]/u);
    expect(first).toMatch(/[0-9]/u);
  });
});
