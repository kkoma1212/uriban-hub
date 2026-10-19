import { describe, expect, it } from "vitest";

import { decodeUpdatesCursor, encodeUpdatesCursor } from "./updates.cursor.js";
import { InvalidUpdatesCursorException } from "./updates.errors.js";

function rawCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("updates cursor", () => {
  it("round-trips and binds the cursor to its filter", () => {
    const encoded = encodeUpdatesCursor({
      filter: "performance",
      id: "9223372036854775807",
      itemKind: "notice",
      publishedAt: "2026-07-26T04:05:06.123456Z",
    });

    expect(decodeUpdatesCursor(encoded, "performance")).toEqual({
      filter: "performance",
      id: "9223372036854775807",
      itemKind: "notice",
      publishedAt: "2026-07-26T04:05:06.123456Z",
    });
    expect(() => decodeUpdatesCursor(encoded, "all")).toThrow(InvalidUpdatesCursorException);
  });

  it("rejects malformed, non-canonical, extra-key, invalid id, kind, and timestamp values", () => {
    const base = {
      filter: "all",
      id: "1",
      item_kind: "supply",
      kind: "updates",
      published_at: "2026-07-26T04:05:06.123456Z",
      v: 1,
    };

    for (const value of [
      "%%%",
      `${rawCursor(base)}=`,
      rawCursor({ ...base, extra: true }),
      rawCursor({ ...base, id: "0" }),
      rawCursor({ ...base, id: "9223372036854775808" }),
      rawCursor({ ...base, item_kind: "schedule" }),
      rawCursor({ ...base, published_at: "2026-07-26T04:05:06.123Z" }),
      rawCursor({ ...base, published_at: "2026-02-30T04:05:06.123456Z" }),
      rawCursor({ ...base, v: 2 }),
    ]) {
      expect(() => decodeUpdatesCursor(value, "all")).toThrow(InvalidUpdatesCursorException);
    }
  });
});
