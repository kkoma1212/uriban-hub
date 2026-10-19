import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const ADMIN_SIGNUP_APPROVAL_CODE_DIGITS = 6;
export const ADMIN_SIGNUP_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS = 5;

export type AdminSignupApprovalRole = "teacher" | "student";

export function issueAdminSignupApprovalCode(
  random: () => number = () => randomInt(0, 1_000_000),
): string {
  const value = random();
  if (!Number.isInteger(value) || value < 0 || value >= 1_000_000) {
    throw new Error("approval code random source must produce an integer in [0, 1000000)");
  }
  return value.toString().padStart(ADMIN_SIGNUP_APPROVAL_CODE_DIGITS, "0");
}

export function normalizeApprovalEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

export function approvalCodeDigest(
  secret: string,
  email: string,
  role: AdminSignupApprovalRole,
  code: string,
  accountId: string,
  purpose: "email" | "approval",
): Buffer {
  return createHmac("sha256", secret)
    .update(
      `signup-v2\0${accountId}\0${purpose}\0${normalizeApprovalEmail(email)}\0${role}\0${code}`,
      "utf8",
    )
    .digest();
}

export function matchesApprovalCode(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isApprovalCodeExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
