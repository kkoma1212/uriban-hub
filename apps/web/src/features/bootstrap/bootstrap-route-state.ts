export const HOME_AUTHORIZATION_RECHECK_REASON = "home-authorization-recheck";
export const HOME_AUTHORIZATION_RECHECK_TTL_MS = 5 * 60 * 1_000;

const HOME_AUTHORIZATION_RECHECK_LEDGER_KEY = "classhub:home-authorization-recheck-ledger:v2";
const HOME_AUTHORIZATION_RECHECK_LEDGER_LIMIT = 32;

export interface HomeAuthorizationRecheckRouteState {
  nonce: string;
  reason: typeof HOME_AUTHORIZATION_RECHECK_REASON;
}

export type HomeAuthorizationRecheckEntryDecision =
  | { status: "absent" }
  | { status: "invalid" }
  | {
      expiresAt: number;
      marker: HomeAuthorizationRecheckRouteState;
      status: "accepted";
    };

interface HomeAuthorizationRecheckLedgerEntry {
  boundLocationKey: string | null;
  issuedAt: number;
  sequence: number;
}

interface HomeAuthorizationRecheckLedger {
  entries: Record<string, HomeAuthorizationRecheckLedgerEntry>;
  nextSequence: number;
  version: 2;
}

function emptyLedger(): HomeAuthorizationRecheckLedger {
  return {
    entries: Object.create(null) as Record<string, HomeAuthorizationRecheckLedgerEntry>,
    nextSequence: 1,
    version: 2,
  };
}

function sessionLedgerStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function parseLedger(raw: string): HomeAuthorizationRecheckLedger | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Partial<HomeAuthorizationRecheckLedger>;
    if (
      candidate.version !== 2 ||
      !Number.isSafeInteger(candidate.nextSequence) ||
      (candidate.nextSequence as number) < 1 ||
      typeof candidate.entries !== "object" ||
      candidate.entries === null
    ) {
      return undefined;
    }

    const entries = Object.create(null) as Record<string, HomeAuthorizationRecheckLedgerEntry>;
    const seenSequences = new Set<number>();
    for (const [nonce, value] of Object.entries(candidate.entries)) {
      if (nonce.length === 0 || nonce.length > 128 || typeof value !== "object" || value === null) {
        return undefined;
      }
      const entry = value as Partial<HomeAuthorizationRecheckLedgerEntry>;
      if (
        !Number.isSafeInteger(entry.issuedAt) ||
        (entry.issuedAt as number) < 0 ||
        !Number.isSafeInteger(entry.sequence) ||
        (entry.sequence as number) < 1 ||
        (entry.sequence as number) >= (candidate.nextSequence as number) ||
        (entry.boundLocationKey !== null &&
          (typeof entry.boundLocationKey !== "string" ||
            entry.boundLocationKey.length === 0 ||
            entry.boundLocationKey.length > 128))
      ) {
        return undefined;
      }
      const sequence = entry.sequence as number;
      if (seenSequences.has(sequence)) return undefined;
      seenSequences.add(sequence);
      entries[nonce] = {
        boundLocationKey: entry.boundLocationKey,
        issuedAt: entry.issuedAt as number,
        sequence,
      };
    }
    return { entries, nextSequence: candidate.nextSequence as number, version: 2 };
  } catch {
    return undefined;
  }
}

function readLedger(storage: Storage): HomeAuthorizationRecheckLedger | undefined {
  try {
    const raw = storage.getItem(HOME_AUTHORIZATION_RECHECK_LEDGER_KEY);
    return raw === null ? emptyLedger() : parseLedger(raw);
  } catch {
    return undefined;
  }
}

function writeLedger(storage: Storage, ledger: HomeAuthorizationRecheckLedger): boolean {
  try {
    storage.setItem(HOME_AUTHORIZATION_RECHECK_LEDGER_KEY, JSON.stringify(ledger));
    return true;
  } catch {
    return false;
  }
}

function discardCorruptLedger(storage: Storage): void {
  try {
    storage.removeItem(HOME_AUTHORIZATION_RECHECK_LEDGER_KEY);
  } catch {
    // A blocked storage backend remains fail-closed for marked entries.
  }
}

function pruneLedger(
  ledger: HomeAuthorizationRecheckLedger,
  now: number,
  limit: number,
): { changed: boolean; ledger: HomeAuthorizationRecheckLedger } {
  const retained = Object.entries(ledger.entries)
    .filter(([, entry]) => {
      const age = now - entry.issuedAt;
      return age >= 0 && age <= HOME_AUTHORIZATION_RECHECK_TTL_MS;
    })
    .sort(([, left], [, right]) => right.issuedAt - left.issuedAt || right.sequence - left.sequence)
    .slice(0, limit);
  const entries = Object.create(null) as Record<string, HomeAuthorizationRecheckLedgerEntry>;
  for (const [nonce, entry] of retained) entries[nonce] = entry;
  return {
    changed: retained.length !== Object.keys(ledger.entries).length,
    ledger: { entries, nextSequence: ledger.nextSequence, version: 2 },
  };
}

function parseRouteState(state: unknown): {
  marker?: HomeAuthorizationRecheckRouteState;
  marked: boolean;
} {
  if (typeof state !== "object" || state === null) return { marked: false };
  try {
    const candidate = state as Partial<HomeAuthorizationRecheckRouteState>;
    if (candidate.reason !== HOME_AUTHORIZATION_RECHECK_REASON) return { marked: false };
    if (
      typeof candidate.nonce !== "string" ||
      candidate.nonce.length === 0 ||
      candidate.nonce.length > 128
    ) {
      return { marked: true };
    }
    return {
      marked: true,
      marker: { nonce: candidate.nonce, reason: HOME_AUTHORIZATION_RECHECK_REASON },
    };
  } catch {
    return { marked: true };
  }
}

export function createHomeAuthorizationRecheckRouteState(): HomeAuthorizationRecheckRouteState {
  const marker: HomeAuthorizationRecheckRouteState = {
    nonce: globalThis.crypto.randomUUID(),
    reason: HOME_AUTHORIZATION_RECHECK_REASON,
  };
  const storage = sessionLedgerStorage();
  if (storage === undefined) return marker;

  const now = Date.now();
  const storedLedger = readLedger(storage);
  if (storedLedger === undefined) discardCorruptLedger(storage);
  let { ledger } = pruneLedger(
    storedLedger ?? emptyLedger(),
    now,
    HOME_AUTHORIZATION_RECHECK_LEDGER_LIMIT - 1,
  );
  if (ledger.nextSequence >= Number.MAX_SAFE_INTEGER) ledger = emptyLedger();
  const sequence = ledger.nextSequence;
  ledger.nextSequence += 1;
  ledger.entries[marker.nonce] = { boundLocationKey: null, issuedAt: now, sequence };
  void writeLedger(storage, ledger);
  return marker;
}

export function consumeHomeAuthorizationRecheckRouteState(
  state: unknown,
  locationKey: string,
): HomeAuthorizationRecheckEntryDecision {
  const routeState = parseRouteState(state);
  const storage = sessionLedgerStorage();

  if (!routeState.marked) {
    if (storage !== undefined) {
      const storedLedger = readLedger(storage);
      if (storedLedger === undefined) discardCorruptLedger(storage);
      else {
        const pruned = pruneLedger(
          storedLedger,
          Date.now(),
          HOME_AUTHORIZATION_RECHECK_LEDGER_LIMIT,
        );
        if (pruned.changed) void writeLedger(storage, pruned.ledger);
      }
    }
    return { status: "absent" };
  }
  if (
    routeState.marker === undefined ||
    locationKey.length === 0 ||
    locationKey.length > 128 ||
    storage === undefined
  ) {
    return { status: "invalid" };
  }

  const now = Date.now();
  const storedLedger = readLedger(storage);
  if (storedLedger === undefined) {
    discardCorruptLedger(storage);
    return { status: "invalid" };
  }
  const pruned = pruneLedger(storedLedger, now, HOME_AUTHORIZATION_RECHECK_LEDGER_LIMIT);
  if (pruned.changed && !writeLedger(storage, pruned.ledger)) return { status: "invalid" };

  const entry = pruned.ledger.entries[routeState.marker.nonce];
  if (entry === undefined) return { status: "invalid" };
  if (entry.boundLocationKey === null) {
    entry.boundLocationKey = locationKey;
    if (!writeLedger(storage, pruned.ledger)) return { status: "invalid" };
  } else if (entry.boundLocationKey !== locationKey) {
    return { status: "invalid" };
  }

  return {
    expiresAt: entry.issuedAt + HOME_AUTHORIZATION_RECHECK_TTL_MS,
    marker: routeState.marker,
    status: "accepted",
  };
}
