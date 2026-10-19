import { describe, expect, it } from "vitest";

import { sanitizeSecurityAuditUserAgent } from "./security-audit-metadata.js";

describe("sanitizeSecurityAuditUserAgent", () => {
  it.each([
    undefined,
    "",
    "a".repeat(43),
    `Mozilla/5.0 credential=${"b".repeat(43)}`,
    `prefix ${"c".repeat(64)} suffix`,
    "postgresql://user:password@db/private",
    "redis://:s3cr3t@cache:6379/0",
    "redis://s3cr3t@cache:6379/0",
    "rediss://default:s3cr3t@cache:6379/0",
    "mysql://root:s3cr3t@db/app",
    "mongodb://user:s3cr3t@mongo/app",
    "mongodb+srv://user:s3cr3t@cluster/app",
    "amqps://worker:s3cr3t@queue/vhost",
    "student@example.com",
    "Mozilla/5.0\nCookie: private",
    "ClassHubDesktop/1.0 ".repeat(80),
  ])("fails closed for sensitive, control, credential-shaped, or oversized UA", (value) => {
    expect(sanitizeSecurityAuditUserAgent(value)).toBeNull();
  });

  it("preserves bounded printable non-credential UA without rewriting it", () => {
    const value = "Mozilla/5.0 ClassHubDesktop/1.0 Chrome/126.0 Safari/537.36";

    expect(sanitizeSecurityAuditUserAgent(value)).toBe(value);
  });

  it("keeps the credential threshold and exact length boundary explicit", () => {
    const belowCredentialShape = "a".repeat(42);
    const exactBound = "A/".repeat(512);
    const overBound = `${exactBound}A`;

    expect(sanitizeSecurityAuditUserAgent(belowCredentialShape)).toBe(belowCredentialShape);
    expect(exactBound).toHaveLength(1_024);
    expect(sanitizeSecurityAuditUserAgent(exactBound)).toBe(exactBound);
    expect(overBound).toHaveLength(1_025);
    expect(sanitizeSecurityAuditUserAgent(overBound)).toBeNull();
  });
});
