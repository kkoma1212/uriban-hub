import { describe, expect, it } from "vitest";

import {
  createPrivacySafeDigest,
  createPrivacySafeSubject,
  hashVerificationToken,
  issueVerificationToken,
} from "./auth-crypto.js";

describe("auth crypto", () => {
  it("issues a 32-byte opaque token and stores only its SHA-256 hash", () => {
    const token = issueVerificationToken();

    expect(token.raw).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token.hash).toHaveLength(32);
    expect(hashVerificationToken(token.raw)).toEqual(token.hash);
    expect(token.hash.toString("utf8")).not.toContain(token.raw);
  });

  it("creates a versioned deterministic subject without exposing the email", () => {
    const email = "student@example.com";
    const first = createPrivacySafeSubject("x".repeat(32), "v1", "signup_email", email);
    const second = createPrivacySafeSubject("x".repeat(32), "v1", "signup_email", email);

    expect(first).toBe(second);
    expect(first).toMatch(/^v1:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(email);
    expect(first).toBe(`v1:${createPrivacySafeDigest("x".repeat(32), "signup_email", email)}`);
  });
});
