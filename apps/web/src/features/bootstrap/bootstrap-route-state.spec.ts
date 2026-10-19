import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeHomeAuthorizationRecheckRouteState,
  createHomeAuthorizationRecheckRouteState,
  HOME_AUTHORIZATION_RECHECK_REASON,
  HOME_AUTHORIZATION_RECHECK_TTL_MS,
} from "./bootstrap-route-state";

interface StoredLedgerFixture {
  entries: Record<string, { boundLocationKey: string | null; issuedAt: number; sequence: number }>;
  nextSequence: number;
  version: 2;
}

function readStoredLedger(): { key: string; ledger: StoredLedgerFixture } {
  const key = sessionStorage.key(0);
  if (key === null) throw new Error("Expected the route-state ledger to exist");
  const raw = sessionStorage.getItem(key);
  if (raw === null) throw new Error("Expected the route-state ledger value to exist");
  return { key, ledger: JSON.parse(raw) as StoredLedgerFixture };
}

function requireStoredLedgerEntry(
  ledger: StoredLedgerFixture,
  nonce: string,
): StoredLedgerFixture["entries"][string] {
  const entry = ledger.entries[nonce];
  if (entry === undefined) throw new Error("Expected the marker to have a ledger entry");
  return entry;
}

describe("Home authorization recheck route state", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("binds an issued marker once and only accepts the same history entry", () => {
    const marker = createHomeAuthorizationRecheckRouteState();

    expect(consumeHomeAuthorizationRecheckRouteState(marker, "entry-a").status).toBe("accepted");
    expect(consumeHomeAuthorizationRecheckRouteState(marker, "entry-a").status).toBe("accepted");
    expect(
      consumeHomeAuthorizationRecheckRouteState(structuredClone(marker), "entry-b").status,
    ).toBe("invalid");
    expect(consumeHomeAuthorizationRecheckRouteState({ ...marker }, "entry-c").status).toBe(
      "invalid",
    );
  });

  it("rejects forged, malformed, expired, and future-dated markers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const expired = createHomeAuthorizationRecheckRouteState();
    vi.advanceTimersByTime(HOME_AUTHORIZATION_RECHECK_TTL_MS + 1);

    expect(consumeHomeAuthorizationRecheckRouteState(expired, "expired-entry").status).toBe(
      "invalid",
    );
    expect(
      consumeHomeAuthorizationRecheckRouteState(
        { nonce: "caller-controlled", reason: HOME_AUTHORIZATION_RECHECK_REASON },
        "forged-entry",
      ).status,
    ).toBe("invalid");
    expect(
      consumeHomeAuthorizationRecheckRouteState(
        { nonce: "", reason: HOME_AUTHORIZATION_RECHECK_REASON },
        "malformed-entry",
      ).status,
    ).toBe("invalid");

    vi.setSystemTime(new Date("2026-09-01T00:10:00.000Z"));
    const futureDated = createHomeAuthorizationRecheckRouteState();
    vi.setSystemTime(new Date("2026-09-01T00:09:59.999Z"));
    expect(consumeHomeAuthorizationRecheckRouteState(futureDated, "future-entry").status).toBe(
      "invalid",
    );
  });

  it("prunes the ledger to the latest 32 markers issued in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const markers = Array.from({ length: 33 }, () => createHomeAuthorizationRecheckRouteState());

    expect(consumeHomeAuthorizationRecheckRouteState(markers[0], "oldest-entry").status).toBe(
      "invalid",
    );
    for (const [index, marker] of markers.slice(1).entries()) {
      expect(
        consumeHomeAuthorizationRecheckRouteState(marker, `retained-entry-${index}`).status,
      ).toBe("accepted");
    }
  });

  it("fails closed when two marker entries share a sequence", () => {
    const [first, second] = [
      createHomeAuthorizationRecheckRouteState(),
      createHomeAuthorizationRecheckRouteState(),
    ];
    const { key, ledger } = readStoredLedger();
    requireStoredLedgerEntry(ledger, second.nonce).sequence = requireStoredLedgerEntry(
      ledger,
      first.nonce,
    ).sequence;
    sessionStorage.setItem(key, JSON.stringify(ledger));

    expect(consumeHomeAuthorizationRecheckRouteState(second, "duplicate-entry").status).toBe(
      "invalid",
    );
  });

  it("fails closed when an expired entry duplicates a retained sequence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const [expired, retained] = [
      createHomeAuthorizationRecheckRouteState(),
      createHomeAuthorizationRecheckRouteState(),
    ];
    const { key, ledger } = readStoredLedger();
    const expiredEntry = requireStoredLedgerEntry(ledger, expired.nonce);
    expiredEntry.issuedAt = Date.now() - HOME_AUTHORIZATION_RECHECK_TTL_MS - 1;
    expiredEntry.sequence = requireStoredLedgerEntry(ledger, retained.nonce).sequence;
    sessionStorage.setItem(key, JSON.stringify(ledger));

    expect(
      consumeHomeAuthorizationRecheckRouteState(retained, "duplicate-expired-entry").status,
    ).toBe("invalid");
  });

  it("fails closed when a duplicate sequence is hidden beyond the 32-entry cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const markers = Array.from({ length: 32 }, () => createHomeAuthorizationRecheckRouteState());
    const retained = markers.at(-1);
    if (retained === undefined) throw new Error("Expected a retained marker");
    const { key, ledger } = readStoredLedger();
    ledger.entries["outside-cap"] = {
      boundLocationKey: null,
      issuedAt: Date.now() - 1,
      sequence: requireStoredLedgerEntry(ledger, retained.nonce).sequence,
    };
    sessionStorage.setItem(key, JSON.stringify(ledger));

    expect(consumeHomeAuthorizationRecheckRouteState(retained, "cap-entry").status).toBe("invalid");
  });

  it("fails closed for unavailable or corrupt storage without blocking an unmarked entry", () => {
    const marker = createHomeAuthorizationRecheckRouteState();
    const ledgerKey = sessionStorage.key(0);
    expect(ledgerKey).not.toBeNull();
    sessionStorage.setItem(ledgerKey as string, "{corrupt");

    expect(consumeHomeAuthorizationRecheckRouteState(marker, "corrupt-entry").status).toBe(
      "invalid",
    );
    expect(consumeHomeAuthorizationRecheckRouteState(null, "direct-entry").status).toBe("absent");

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const unavailableMarker = createHomeAuthorizationRecheckRouteState();
    expect(
      consumeHomeAuthorizationRecheckRouteState(unavailableMarker, "unavailable-entry").status,
    ).toBe("invalid");
    expect(consumeHomeAuthorizationRecheckRouteState(null, "clean-entry").status).toBe("absent");
    getItem.mockRestore();
  });

  it("fails closed for the previous ledger schema instead of guessing issuance order", () => {
    const marker = createHomeAuthorizationRecheckRouteState();
    const ledgerKey = sessionStorage.key(0);
    expect(ledgerKey).not.toBeNull();
    sessionStorage.setItem(
      ledgerKey as string,
      JSON.stringify({
        entries: {
          [marker.nonce]: { boundLocationKey: null, issuedAt: Date.now() },
        },
        version: 1,
      }),
    );

    expect(consumeHomeAuthorizationRecheckRouteState(marker, "legacy-entry").status).toBe(
      "invalid",
    );
  });
});
