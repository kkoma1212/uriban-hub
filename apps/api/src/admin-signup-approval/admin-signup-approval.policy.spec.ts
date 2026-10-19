import { describe, expect, it } from "vitest";

import {
  approvalCodeDigest,
  isApprovalCodeExpired,
  issueAdminSignupApprovalCode,
  matchesApprovalCode,
  normalizeApprovalEmail,
} from "./admin-signup-approval.policy.js";

describe("admin signup approval policy", () => {
  it("binds the code to account identity and purpose across same-email re-registration", () => {
    const digest = approvalCodeDigest(
      "test-secret",
      "a@example.invalid",
      "teacher",
      "123456",
      "1",
      "email",
    );
    expect(digest).not.toEqual(
      approvalCodeDigest("test-secret", "a@example.invalid", "teacher", "123456", "2", "email"),
    );
    expect(digest).not.toEqual(
      approvalCodeDigest("test-secret", "a@example.invalid", "teacher", "123456", "1", "approval"),
    );
  });
  it("issues a six digit code including leading zeroes", () => {
    expect(issueAdminSignupApprovalCode(() => 7)).toBe("000007");
  });

  it("rejects an invalid random source", () => {
    expect(() => issueAdminSignupApprovalCode(() => 1_000_000)).toThrow();
  });

  it("normalizes email before keyed digesting", () => {
    expect(normalizeApprovalEmail("  ADMIN@EXAMPLE.COM ")).toBe("admin@example.com");
    expect(
      approvalCodeDigest(
        "test-secret",
        " ADMIN@example.com ",
        "teacher",
        "000007",
        "account-1",
        "email",
      ),
    ).toEqual(
      approvalCodeDigest(
        "test-secret",
        "admin@example.com",
        "teacher",
        "000007",
        "account-1",
        "email",
      ),
    );
  });

  it("compares digests safely and keeps the original code expiry", () => {
    const digest = approvalCodeDigest(
      "test-secret",
      "a@example.com",
      "student",
      "123456",
      "account-1",
      "email",
    );
    expect(matchesApprovalCode(digest, Buffer.from(digest))).toBe(true);
    expect(
      matchesApprovalCode(
        digest,
        approvalCodeDigest(
          "test-secret",
          "a@example.com",
          "student",
          "123457",
          "account-1",
          "email",
        ),
      ),
    ).toBe(false);
    const future = new Date("2030-01-01T00:10:00Z");
    const now = new Date("2030-01-01T00:00:00Z");
    expect(isApprovalCodeExpired(future, now)).toBe(false);
    expect(isApprovalCodeExpired(now, now)).toBe(true);
  });
});
