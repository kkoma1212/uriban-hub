import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { rememberBadgeCount, rememberedBadgeCount } from "./badge-count-cache";

function useSession(value: string): void {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(`__Host-classhub_csrf=${value}`);
}

describe("remembered menu badge counts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reuses a count for 15 seconds within the same session", () => {
    vi.useFakeTimers();
    useSession("a");
    rememberBadgeCount("help", 4);
    expect(rememberedBadgeCount("help")).toEqual({ fresh: true, value: 4 });
    vi.advanceTimersByTime(15_001);
    expect(rememberedBadgeCount("help")).toEqual({ fresh: false, value: 4 });
  });

  it("never shows another session's count, and forgets on sign-out", () => {
    useSession("a");
    rememberBadgeCount("help", 4);
    vi.restoreAllMocks();
    useSession("b");
    expect(rememberedBadgeCount("help")).toEqual({ fresh: false, value: undefined });
    vi.restoreAllMocks();
    useSession("a");
    window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
    expect(rememberedBadgeCount("help")).toEqual({ fresh: false, value: undefined });
  });
});
