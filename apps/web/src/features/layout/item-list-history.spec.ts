import { describe, expect, it } from "vitest";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";

import {
  ITEM_LIST_HISTORY_LIMIT,
  itemListEntryKey,
  itemListHistoryEntry,
  itemListOriginState,
  rememberItemListPosition,
} from "./item-list-history";

describe("item list history", () => {
  it("distinguishes mixed feed item kinds and clears positions with authenticated state", () => {
    rememberItemListPosition("updates", "mixed-entry", "notice:17", 100);
    const state = itemListOriginState("updates", "mixed-entry");
    expect(itemListEntryKey(state, "updates", "notice:17")).toBe("mixed-entry");
    expect(itemListEntryKey(state, "updates", "supply:17")).toBeUndefined();
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    expect(itemListHistoryEntry("updates", "mixed-entry")).toBeUndefined();
  });
  it("accepts only the matching surface, entry, and item", () => {
    rememberItemListPosition("supplies", "supply-entry", "17", 320);
    const state = itemListOriginState("supplies", "supply-entry");

    expect(itemListEntryKey(state, "supplies", "17")).toBe("supply-entry");
    expect(itemListEntryKey(state, "supplies", "18")).toBeUndefined();
    expect(itemListEntryKey(state, "schedules", "17")).toBeUndefined();
    expect(itemListHistoryEntry("supplies", "supply-entry")).toEqual({
      itemId: "17",
      scrollY: 320,
    });
  });

  it("ignores malformed entries and evicts the oldest bounded entry", () => {
    rememberItemListPosition("schedules", "", "17", 10);
    rememberItemListPosition("schedules", "invalid-scroll", "17", -1);
    expect(itemListHistoryEntry("schedules", "invalid-scroll")).toBeUndefined();

    for (let index = 0; index <= ITEM_LIST_HISTORY_LIMIT; index += 1) {
      rememberItemListPosition("schedules", `entry-${index}`, `item-${index}`, index);
    }

    expect(itemListHistoryEntry("schedules", "entry-0")).toBeUndefined();
    expect(itemListHistoryEntry("schedules", `entry-${ITEM_LIST_HISTORY_LIMIT}`)).toEqual({
      itemId: `item-${ITEM_LIST_HISTORY_LIMIT}`,
      scrollY: ITEM_LIST_HISTORY_LIMIT,
    });
    expect(itemListEntryKey({ itemListOrigin: null }, "schedules", "17")).toBeUndefined();
  });
});
