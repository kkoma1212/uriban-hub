import { describe, expect, it } from "vitest";

import {
  NOTICE_LIST_HISTORY_LIMIT,
  noticeListEntryKey,
  noticeListHistoryEntry,
  rememberNoticeListPosition,
} from "./notice-list-history";

describe("notice list history", () => {
  it("accepts an origin only when its stored notice matches the detail route", () => {
    rememberNoticeListPosition("matching-origin", "17", 300);

    expect(noticeListEntryKey({ noticeListEntryKey: "matching-origin" }, "18")).toBeUndefined();
    expect(noticeListEntryKey({ noticeListEntryKey: "matching-origin" }, "17")).toBe(
      "matching-origin",
    );
    expect(noticeListEntryKey({ noticeListEntryKey: "missing-origin" }, "17")).toBeUndefined();
  });

  it("keeps a small deterministic least-recently-used history", () => {
    for (let index = 0; index < NOTICE_LIST_HISTORY_LIMIT; index += 1) {
      rememberNoticeListPosition(`bounded-${index}`, `${index}`, index);
    }

    expect(noticeListHistoryEntry("bounded-0")).toEqual({ noticeId: "0", scrollY: 0 });
    rememberNoticeListPosition("bounded-newest", "newest", 999);

    expect(noticeListHistoryEntry("bounded-1")).toBeUndefined();
    expect(noticeListHistoryEntry("bounded-0")).toEqual({ noticeId: "0", scrollY: 0 });
    expect(noticeListHistoryEntry("bounded-newest")).toEqual({
      noticeId: "newest",
      scrollY: 999,
    });
  });
});
