import { describe, expect, it } from "vitest";

import { decodePollListCursor, encodePollListCursor } from "./polls.cursor.js";
import { InvalidPollCursorException } from "./polls.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("poll list cursors", () => {
  it("round-trips cursors and binds them to the requested scope", () => {
    const encoded = encodePollListCursor({
      closesAt: "2026-07-14T03:00:00.123456Z",
      id: "9223372036854775807",
      scope: "closed",
    });
    expect(decodePollListCursor(encoded, "closed")).toEqual({
      closesAt: "2026-07-14T03:00:00.123456Z",
      id: "9223372036854775807",
      scope: "closed",
    });
    // open과 closed는 정렬 방향이 반대라 커서를 넘겨쓰면 항목을 건너뛴다.
    expect(() => decodePollListCursor(encoded, "open")).toThrow(InvalidPollCursorException);
  });

  it("keeps microsecond precision so same-millisecond polls are not skipped", () => {
    const encoded = encodePollListCursor({
      closesAt: "2026-07-14T03:00:00.123456Z",
      id: "1",
      scope: "open",
    });
    expect(decodePollListCursor(encoded, "open").closesAt).toBe("2026-07-14T03:00:00.123456Z");
  });

  it("rejects malformed, extra-key, invalid timestamp, and invalid id cursors", () => {
    const base = {
      closes_at: "2026-07-14T03:00:00.123456Z",
      id: "1",
      kind: "polls",
      scope: "open",
      v: 1,
    };
    for (const cursor of [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, id: "0" }),
      rawCursor({ ...base, id: "9223372036854775808" }),
      rawCursor({ ...base, closes_at: "2026-07-14" }),
      rawCursor({ ...base, closes_at: "2026-07-14T03:00:00.123Z" }),
      rawCursor({ ...base, closes_at: "2026-02-30T03:00:00.123456Z" }),
      rawCursor({ ...base, kind: "notices" }),
      rawCursor({ ...base, v: 2 }),
    ]) {
      expect(() => decodePollListCursor(cursor, "open")).toThrow(InvalidPollCursorException);
    }
  });
});
