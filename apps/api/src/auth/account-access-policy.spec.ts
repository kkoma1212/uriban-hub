import { describe, expect, it } from "vitest";

import { hasApprovedAccountAccess } from "./account-access-policy.js";

describe("approved account access", () => {
  it("requires separate teacher approval even after email verification", () => {
    expect(
      hasApprovedAccountAccess({
        signup_role: "teacher",
        email_verified_at: new Date(),
        signup_approved_at: null,
      }),
    ).toBe(false);
    expect(
      hasApprovedAccountAccess({
        signup_role: "teacher",
        email_verified_at: new Date(),
        signup_approved_at: new Date(),
      }),
    ).toBe(true);
  });
  it.each([
    [true, { email_verified_at: new Date(), signup_approved_at: null }],
    [true, { email_verified_at: null, signup_approved_at: new Date() }],
    [false, { email_verified_at: null, signup_approved_at: null }],
  ] as const)("returns %s for independent email and signup approval states", (expected, state) => {
    expect(hasApprovedAccountAccess(state)).toBe(expected);
  });
});
