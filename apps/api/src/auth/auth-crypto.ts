import { createHash, createHmac, randomBytes } from "node:crypto";

export interface VerificationToken {
  hash: Buffer;
  raw: string;
}

export function issueVerificationToken(): VerificationToken {
  const raw = randomBytes(32).toString("base64url");
  return { hash: hashVerificationToken(raw), raw };
}

export function hashVerificationToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

export function createPrivacySafeSubject(
  key: string,
  keyVersion: string,
  namespace: string,
  value: string,
): string {
  return `${keyVersion}:${createPrivacySafeDigest(key, namespace, value)}`;
}

export function createPrivacySafeDigest(key: string, namespace: string, value: string): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([namespace, value]), "utf8")
    .digest("base64url");
}
