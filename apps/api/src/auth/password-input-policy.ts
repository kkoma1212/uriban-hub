import {
  LEGACY_PASSWORD_INPUT_VERSION,
  NFC_PASSWORD_INPUT_VERSION,
  passwordForVerification,
} from "@classhub/db";

import { PASSWORD_BLOCKLIST_V1 } from "./password-blocklist-v1.js";
import { PASSWORD_BLOCKLIST_V2 } from "./password-blocklist-v2.js";

export { LEGACY_PASSWORD_INPUT_VERSION, NFC_PASSWORD_INPUT_VERSION, passwordForVerification };
export const NEW_PASSWORD_MIN_CODE_POINTS = 6;
/** 2026-10-02 사용자 결정: 관리자는 권한이 커서 새로 정하는 비밀번호를 12자 이상으로 한다(기존 비밀번호는 그대로). */
export const ADMIN_PASSWORD_MIN_CODE_POINTS = 12;

export type NewPasswordRejectionReason =
  "blocked" | "disallowed_character" | "length" | "composition";

export type NewPasswordEvaluation =
  { normalizedPassword: string; ok: true } | { ok: false; reason: NewPasswordRejectionReason };

export interface NewPasswordContext {
  accountType?: "administrator";
  displayName?: string;
  email?: string;
}

const DISALLOWED_PASSWORD_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const PRODUCT_DERIVED_PASSWORDS = new Set([
  "classhubclasshub",
  "classhub-password",
  "우리반 허브 우리반 허브",
  "우리반허브1234567890",
  "우리반허브우리반허브우리반허브",
]);

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function addDerivedVariants(target: Set<string>, rawSeed: string | undefined): void {
  if (rawSeed === undefined) return;
  const seed = rawSeed.normalize("NFC").trim();
  if (seed === "") return;

  const variants = new Set([seed, seed.toLowerCase(), seed.toUpperCase()]);
  for (const variant of variants) {
    target.add(variant);
    target.add(`${variant}${variant}`);
    target.add(`${variant}1234567890`);
  }
}

function derivedPasswordBlocklist(context: NewPasswordContext): Set<string> {
  const values = new Set(PRODUCT_DERIVED_PASSWORDS);
  addDerivedVariants(values, context.displayName);
  addDerivedVariants(values, context.email);
  addDerivedVariants(values, context.email?.split("@", 1)[0]);
  return values;
}

export function evaluateNewPassword(
  rawPassword: string,
  context: NewPasswordContext = {},
): NewPasswordEvaluation {
  const normalizedPassword = rawPassword.normalize("NFC");
  const length = codePointLength(normalizedPassword);

  const minimum =
    context.accountType === "administrator"
      ? ADMIN_PASSWORD_MIN_CODE_POINTS
      : NEW_PASSWORD_MIN_CODE_POINTS;
  if (length < minimum) {
    return { ok: false, reason: "length" };
  }
  if (DISALLOWED_PASSWORD_CHARACTER.test(normalizedPassword)) {
    return { ok: false, reason: "disallowed_character" };
  }
  if (
    PASSWORD_BLOCKLIST_V2.has(normalizedPassword) ||
    PASSWORD_BLOCKLIST_V1.has(normalizedPassword) ||
    derivedPasswordBlocklist(context).has(normalizedPassword)
  ) {
    return { ok: false, reason: "blocked" };
  }
  if (!/\p{L}/u.test(normalizedPassword) || !/\p{N}/u.test(normalizedPassword)) {
    return { ok: false, reason: "composition" };
  }

  return { normalizedPassword, ok: true };
}
