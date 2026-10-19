import { describe, expect, it } from "vitest";

import { decodeAuditLogCursor, encodeAuditLogCursor } from "./audit-logs.cursor.js";
import { InvalidAuditLogCursorException } from "./audit-logs.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("audit log cursor", () => {
  const binding = { action: null, classId: "41", days: 90 } as const;

  it("round-trips the class-and-filter-bound microsecond sort tuple", () => {
    const encoded = encodeAuditLogCursor({
      ...binding,
      createdAt: "2026-07-18T03:04:05.123456Z",
      id: "9223372036854775807",
    });
    expect(decodeAuditLogCursor(encoded, binding)).toEqual({
      ...binding,
      createdAt: "2026-07-18T03:04:05.123456Z",
      id: "9223372036854775807",
    });
    expect(() => decodeAuditLogCursor(encoded, { ...binding, classId: "42" })).toThrow(
      InvalidAuditLogCursorException,
    );
    expect(() => decodeAuditLogCursor(encoded, { ...binding, action: "class.updated" })).toThrow(
      InvalidAuditLogCursorException,
    );
    expect(() => decodeAuditLogCursor(encoded, { ...binding, days: 30 })).toThrow(
      InvalidAuditLogCursorException,
    );
  });

  it("fails closed for malformed, non-canonical, extra-key, timestamp, and id values", () => {
    const base = {
      action: null,
      class_id: "41",
      created_at: "2026-07-18T03:04:05.123456Z",
      days: 90,
      id: "10",
      kind: "audit_logs",
      v: 2,
    };
    for (const cursor of [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, action: "notice.unapproved" }),
      rawCursor({ ...base, class_id: "0" }),
      rawCursor({ ...base, days: 91 }),
      rawCursor({ ...base, id: "9223372036854775808" }),
      rawCursor({ ...base, created_at: "2026-07-18T03:04:05.123Z" }),
      rawCursor({ ...base, created_at: "2026-02-30T03:04:05.123456Z" }),
      rawCursor({ ...base, kind: "security_audit_logs" }),
      rawCursor({ ...base, v: 1 }),
    ]) {
      expect(() => decodeAuditLogCursor(cursor, binding)).toThrow(InvalidAuditLogCursorException);
    }
  });
});
