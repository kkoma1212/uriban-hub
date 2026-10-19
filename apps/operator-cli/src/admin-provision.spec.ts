import { describe, expect, it } from "vitest";

import {
  generateAdminInitialPassword,
  normalizeAdminDisplayName,
  normalizeAdminEmail,
  requireAdminRole,
} from "./admin-provision.js";

describe("admin provision input", () => {
  it("normalizes email and display name", () => {
    expect(normalizeAdminEmail(" ADMIN@Example.COM ")).toBe("admin@example.com");
    expect(normalizeAdminDisplayName("  서비스 관리자  ")).toBe("서비스 관리자");
  });

  it("rejects markup, control characters, and unknown roles", () => {
    expect(() => normalizeAdminDisplayName("<b>관리자</b>")).toThrow();
    expect(() => normalizeAdminDisplayName("관리\n자")).toThrow();
    expect(() => requireAdminRole("owner")).toThrow();
  });

  it("rejects addresses that exceed the login email length limits", () => {
    expect(normalizeAdminEmail(`${"a".repeat(64)}@example.invalid`)).toBe(
      `${"a".repeat(64)}@example.invalid`,
    );
    expect(() => normalizeAdminEmail(`${"a".repeat(65)}@example.invalid`)).toThrow();
    expect(normalizeAdminEmail(`${"가".repeat(21)}@example.invalid`)).toBe(
      `${"가".repeat(21)}@example.invalid`,
    );
    expect(() => normalizeAdminEmail(`${"가".repeat(22)}@example.invalid`)).toThrow();
    const domain = ["b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(normalizeAdminEmail(`${"a".repeat(64)}@${domain}`)).toHaveLength(254);
    expect(() => normalizeAdminEmail(`${"a".repeat(64)}@${domain}e`)).toThrow();
  });

  it("accepts only a fixed least-privilege role set", () => {
    expect(requireAdminRole("super_admin")).toBe("super_admin");
    expect(requireAdminRole("account_manager")).toBe("account_manager");
    expect(requireAdminRole("support")).toBe("support");
    expect(requireAdminRole("security_auditor")).toBe("security_auditor");
  });

  it("generates a high-entropy password accepted by the storage bounds", () => {
    const first = generateAdminInitialPassword();
    const second = generateAdminInitialPassword();

    expect(first).toMatch(/^A1-[A-Za-z0-9_-]{32}$/u);
    expect(second).not.toBe(first);
    expect(Array.from(first).length).toBeGreaterThanOrEqual(15);
    expect(Array.from(first).length).toBeLessThanOrEqual(72);
  });
});
