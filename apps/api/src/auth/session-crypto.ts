import { createHash, randomBytes } from "node:crypto";

const RAW_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface SessionSecrets {
  csrfToken: string;
  csrfTokenHash: Buffer;
  sessionToken: string;
  sessionTokenHash: Buffer;
}

function issueSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionSecret(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isSessionSecret(raw: string | undefined): raw is string {
  return raw !== undefined && RAW_SECRET_PATTERN.test(raw);
}

export function issueSessionSecrets(): SessionSecrets {
  const sessionToken = issueSecret();
  const csrfToken = issueSecret();

  return {
    csrfToken,
    csrfTokenHash: hashSessionSecret(csrfToken),
    sessionToken,
    sessionTokenHash: hashSessionSecret(sessionToken),
  };
}

export function issueCsrfToken(): { raw: string; hash: Buffer } {
  const raw = issueSecret();
  return { raw, hash: hashSessionSecret(raw) };
}
