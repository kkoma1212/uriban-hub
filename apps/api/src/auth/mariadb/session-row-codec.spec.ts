import { describe, expect, it } from "vitest";

import { SessionServiceUnavailableException } from "../auth.errors.js";
import { decodeMariaDbSessionRow, parseMariaDbSessionDate } from "./session-row-codec.js";

describe("MariaDB session row codec", () => {
  it("validates UTC calendar dates and matches PG millisecond truncation", () => {
    expect(parseMariaDbSessionDate("2024-02-29 23:59:59.123999").toISOString()).toBe(
      "2024-02-29T23:59:59.123Z",
    );
    expect(parseMariaDbSessionDate("2026-09-07 00:00:00.000001").getTime()).toBe(
      Date.parse("2026-09-07T00:00:00.000Z"),
    );
    for (const invalid of [
      "2026-02-29 00:00:00.000000",
      "2026-04-31 00:00:00.000000",
      "2026-01-01 24:00:00.000000",
      "2026-01-01 00:00:60.000000",
      "0000-00-00 00:00:00.000000",
      "2026-01-01T00:00:00.000000Z",
      "2026-01-01 00:00:00.000000+09:00",
      "2026-01-01 00:00:00.1234567",
      "2026-01-01 00:00:00",
      new Date(),
      null,
    ]) {
      expect(() => parseMariaDbSessionDate(invalid)).toThrow(SessionServiceUnavailableException);
    }
  });

  it("preserves exact large IDs, Buffer hashes, nulls and unrelated values without mutation", () => {
    const row = {
      id: "9223372036854775807",
      user_id: "9007199254740993",
      current_class_id: null,
      is_active: 1,
      temporary_password_must_change: 0,
      was_active: 0,
      csrf_token_hash: Buffer.alloc(32, 7),
      deleted_at: null,
      expires_at: "2026-09-08 10:20:30.999999",
      failed_login_attempts: 4,
      password_hash: "private synthetic password hash",
    };
    const result = decodeMariaDbSessionRow(row);
    expect(result).toMatchObject({
      ...row,
      is_active: true,
      temporary_password_must_change: false,
      was_active: false,
      expires_at: new Date("2026-09-08T10:20:30.999Z"),
    });
    expect(result.csrf_token_hash).toBe(row.csrf_token_hash);
    expect(row.is_active).toBe(1);
    expect(typeof row.expires_at).toBe("string");
  });

  it("rejects coercible or malformed security fields with no private values in the error", () => {
    for (const row of [
      { id: 9007199254740992 },
      { id: "9223372036854775808" },
      { user_id: null },
      { current_class_id: "01" },
      { is_active: "0" },
      { is_active: null },
      { temporary_password_must_change: true },
      { csrf_token_hash: Buffer.alloc(31) },
      { csrf_token_hash: "private hash" },
      { expires_at: null },
      { failed_login_attempts: "4" },
    ]) {
      try {
        decodeMariaDbSessionRow({ ...row, password_hash: "private password" });
        throw new Error("codec should reject");
      } catch (error) {
        expect(error).toBeInstanceOf(SessionServiceUnavailableException);
        expect(String(error)).not.toContain("private");
        expect(JSON.stringify(error)).not.toContain("private");
      }
    }
    expect(decodeMariaDbSessionRow({ temporary_password_must_change: null })).toEqual({
      temporary_password_must_change: null,
    });
  });
});
