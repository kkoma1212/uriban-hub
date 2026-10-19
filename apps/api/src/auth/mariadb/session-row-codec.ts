import type { KyselyPlugin } from "kysely";

import { SessionServiceUnavailableException } from "../auth.errors.js";

const nullableDates = new Set([
  "deleted_at",
  "email_verified_at",
  "locked_until",
  "revoked_at",
  "signup_approved_at",
  "temporary_password_expires_at",
]);
const identifiers = new Set(["id", "user_id", "current_class_id"]);
const booleans = new Set(["is_active", "temporary_password_must_change", "was_active"]);
const hashes = new Set(["csrf_token_hash", "session_hash"]);

function rejected(): never {
  throw new SessionServiceUnavailableException();
}

/** UTC is fixed on every MariaDB lease. Match PG's Date/millisecond read policy. */
export function parseMariaDbSessionDate(value: unknown): Date {
  if (typeof value !== "string") return rejected();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/u.exec(value);
  if (match === null) return rejected();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || year < 1000 || month === undefined || day === undefined) {
    return rejected();
  }
  const date = new Date(`${value.slice(0, 10)}T${value.slice(11, 19)}.${match[7]?.slice(0, 3)}Z`);
  // Date normalizes invalid dates (for example February 30); reject that normalization.
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return rejected();
  }
  return date;
}

function identifier(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n
  ) {
    return rejected();
  }
  return value;
}

/** This codec is attached only to SessionService's private Kysely handle. */
export function decodeMariaDbSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  const decoded = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (nullableDates.has(key) || key === "expires_at") {
      decoded[key] =
        value === null && nullableDates.has(key) ? null : parseMariaDbSessionDate(value);
    } else if (identifiers.has(key)) {
      decoded[key] = identifier(value, key === "current_class_id");
    } else if (booleans.has(key)) {
      if (value === null && key === "temporary_password_must_change") continue;
      if (value !== 0 && value !== 1) return rejected();
      decoded[key] = value === 1;
    } else if (hashes.has(key)) {
      if (!Buffer.isBuffer(value) || value.length !== 32) return rejected();
    } else if (key === "failed_login_attempts") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return rejected();
    }
  }
  return decoded;
}

export function createMariaDbSessionRowCodec(): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => ({
      ...result,
      rows: result.rows.map(decodeMariaDbSessionRow),
    }),
  };
}
