import { InvalidAuditLogCursorException } from "./audit-logs.errors.js";
import {
  CLASS_AUDIT_ACTION_SET,
  type AuditLogDays,
  type ClassAuditAction,
} from "./audit-logs.types.js";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CURSOR_LENGTH = 2048;
const MAX_DATABASE_ID = 9_223_372_036_854_775_807n;
const PRECISE_ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AuditLogCursor {
  action: ClassAuditAction | null;
  classId: string;
  createdAt: string;
  days: AuditLogDays;
  id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveBigint(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_DATABASE_ID;
  } catch {
    return false;
  }
}

export function isCanonicalAuditTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PRECISE_ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const millisecondTimestamp = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondTimestamp);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecondTimestamp;
}

function decode(value: string): Record<string, unknown> {
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
      throw new Error("invalid cursor alphabet");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(parsed)) throw new Error("cursor is not an object");
    return parsed;
  } catch {
    throw new InvalidAuditLogCursorException();
  }
}

export function encodeAuditLogCursor(cursor: AuditLogCursor): string {
  return Buffer.from(
    JSON.stringify({
      action: cursor.action,
      class_id: cursor.classId,
      created_at: cursor.createdAt,
      days: cursor.days,
      id: cursor.id,
      kind: "audit_logs",
      v: 2,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeAuditLogCursor(
  value: string,
  binding: { action: ClassAuditAction | null; classId: string; days: AuditLogDays },
): AuditLogCursor {
  const parsed = decode(value);
  if (
    !hasExactKeys(parsed, ["action", "class_id", "created_at", "days", "id", "kind", "v"]) ||
    parsed.kind !== "audit_logs" ||
    parsed.v !== 2 ||
    parsed.class_id !== binding.classId ||
    parsed.action !== binding.action ||
    parsed.days !== binding.days ||
    (parsed.action !== null &&
      (typeof parsed.action !== "string" || !CLASS_AUDIT_ACTION_SET.has(parsed.action))) ||
    !isPositiveBigint(parsed.class_id) ||
    !isPositiveBigint(parsed.id) ||
    !isCanonicalAuditTimestamp(parsed.created_at)
  ) {
    throw new InvalidAuditLogCursorException();
  }
  return {
    action: binding.action,
    classId: binding.classId,
    createdAt: parsed.created_at,
    days: binding.days,
    id: parsed.id,
  };
}
