import { describe, expect, it } from "vitest";

import {
  decodeNoticeConfirmationsCursor,
  decodeNoticeListCursor,
  encodeNoticeConfirmationsCursor,
  encodeNoticeListCursor,
} from "./notices.cursor.js";
import { InvalidNoticeCursorException } from "./notices.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("notice cursors", () => {
  it("round-trips list cursors and binds them to the importance filter", () => {
    const encoded = encodeNoticeListCursor({
      id: "9223372036854775807",
      importance: "important",
      isImportant: true,
      publishedAt: "2026-07-14T03:00:00.123456Z",
    });
    expect(decodeNoticeListCursor(encoded, "important")).toEqual({
      id: "9223372036854775807",
      importance: "important",
      isImportant: true,
      publishedAt: "2026-07-14T03:00:00.123456Z",
    });
    expect(() => decodeNoticeListCursor(encoded, "regular")).toThrow(InvalidNoticeCursorException);
  });

  it("rejects malformed, extra-key, invalid timestamp, and invalid id cursors", () => {
    const base = {
      id: "1",
      importance: "all",
      is_important: true,
      kind: "notices",
      published_at: "2026-07-14T03:00:00.123456Z",
      v: 3,
    };
    for (const cursor of [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, id: "0" }),
      rawCursor({ ...base, published_at: "2026-07-14" }),
      rawCursor({ ...base, published_at: "2026-07-14T03:00:00.12345Z" }),
      rawCursor({ ...base, published_at: "2026-02-30T03:00:00.123456Z" }),
      rawCursor({ ...base, is_important: "true" }),
      rawCursor({ ...base, v: 2 }),
    ]) {
      expect(() => decodeNoticeListCursor(cursor, "all")).toThrow(InvalidNoticeCursorException);
    }
  });

  it("round-trips confirmation cursors and binds them to notice and state", () => {
    const encoded = encodeNoticeConfirmationsCursor({
      displayName: "김학생",
      memberId: "10",
      noticeId: "20",
      state: "modified_unconfirmed",
      studentNumber: null,
    });
    expect(decodeNoticeConfirmationsCursor(encoded, "20", "modified_unconfirmed")).toEqual({
      displayName: "김학생",
      memberId: "10",
      noticeId: "20",
      state: "modified_unconfirmed",
      studentNumber: null,
    });
    expect(() => decodeNoticeConfirmationsCursor(encoded, "21", "modified_unconfirmed")).toThrow(
      InvalidNoticeCursorException,
    );
    expect(() => decodeNoticeConfirmationsCursor(encoded, "20", "confirmed")).toThrow(
      InvalidNoticeCursorException,
    );
  });

  it("rejects invalid confirmation sort values", () => {
    const base = {
      display_name: "김학생",
      kind: "notice_confirmations",
      member_id: "10",
      notice_id: "20",
      state: "unread",
      student_number: 1,
      v: 1,
    };
    for (const value of [
      { ...base, extra: true },
      { ...base, display_name: "한" },
      { ...base, display_name: "앞\u0000뒤" },
      { ...base, member_id: "0" },
      { ...base, student_number: 0 },
      { ...base, student_number: 100 },
      { ...base, notice_id: "9223372036854775808" },
    ]) {
      expect(() => decodeNoticeConfirmationsCursor(rawCursor(value), "20", "unread")).toThrow(
        InvalidNoticeCursorException,
      );
    }
  });
});
