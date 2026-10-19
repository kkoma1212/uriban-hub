import { describe, expect, it } from "vitest";

import {
  createOtpAuthUri,
  decodeBase32,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  hotp,
  totpCodeAt,
  verifyTotp,
} from "./admin-auth.crypto.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("admin TOTP crypto", () => {
  it.each([
    [59_000, "94287082"],
    [1_111_111_109_000, "07081804"],
    [1_111_111_111_000, "14050471"],
    [1_234_567_890_000, "89005924"],
    [2_000_000_000_000, "69279037"],
    [20_000_000_000_000, "65353130"],
  ])("matches RFC 6238 SHA-1 vector at %i", (timestampMs, expected) => {
    expect(totpCodeAt(RFC_SECRET, timestampMs, 8)).toBe(expected);
  });

  it("uses a 30-second ±1 window and rejects a reused timestep", () => {
    const now = 1_800_000_000_000;
    const code = totpCodeAt(RFC_SECRET, now);
    const timestep = BigInt(Math.floor(now / 30_000));

    expect(verifyTotp(RFC_SECRET, code, now + 30_000, null)).toBe(timestep);
    expect(verifyTotp(RFC_SECRET, code, now, timestep)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now + 60_000, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345x", now, null)).toBeNull();
  });

  it("round-trips an account-bound AES-256-GCM secret", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const encrypted = encryptTotpSecret(RFC_SECRET, key, "test-1", "42");

    expect(decryptTotpSecret(encrypted, key, "test-1", "42")).toEqual(RFC_SECRET);
    expect(() => decryptTotpSecret(encrypted, key, "test-1", "43")).toThrow();
  });

  it("renders the RFC base32 secret and a local otpauth URI", () => {
    const base32 = encodeBase32(RFC_SECRET);
    const uri = createOtpAuthUri("admin@example.com", base32);

    expect(base32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(decodeBase32(base32)).toEqual(RFC_SECRET);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${base32}`);
    expect(hotp(RFC_SECRET, 1n, 8)).toBe("94287082");
  });
});
