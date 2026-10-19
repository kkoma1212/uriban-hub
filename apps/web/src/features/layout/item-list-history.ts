import type { BootstrapResponse } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import type { ContentPageSnapshot } from "./content-pagination";

export type ItemListSurface = "schedules" | "supplies" | "updates";

export interface ItemListView {
  owner: string;
  criteria: string;
  page: ContentPageSnapshot;
  search: string | undefined;
  listScrollTop?: number;
  filtersExpanded?: boolean;
}

export interface ItemListHistoryEntry {
  itemId: string;
  scrollY: number;
  view?: ItemListView;
}

interface ItemListOrigin {
  entryKey?: unknown;
  surface?: unknown;
}

interface ItemListLocationState {
  itemListOrigin?: unknown;
}

export const ITEM_LIST_HISTORY_LIMIT = 40;

const historyEntries = new Map<string, ItemListHistoryEntry>();

if (typeof window !== "undefined") {
  window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, () => historyEntries.clear());
}

export function itemListOwner(bootstrap: BootstrapResponse): string {
  return JSON.stringify([
    bootstrap.session_context ?? null,
    bootstrap.current_class?.id,
    bootstrap.current_membership?.id,
    bootstrap.current_membership?.role,
  ]);
}

export function restorableItemListView(
  surface: ItemListSurface,
  entryKey: string,
  bootstrap: BootstrapResponse,
  criteria: string,
): ItemListView | undefined {
  const view = storedHistoryEntry(surface, entryKey)?.view;
  return view?.owner === itemListOwner(bootstrap) && view.criteria === criteria ? view : undefined;
}

function historyKey(surface: ItemListSurface, entryKey: string): string {
  return `${surface}:${entryKey}`;
}

function storedHistoryEntry(
  surface: ItemListSurface,
  entryKey: string,
): ItemListHistoryEntry | undefined {
  const key = historyKey(surface, entryKey);
  const entry = historyEntries.get(key);
  if (entry === undefined) return undefined;
  historyEntries.delete(key);
  historyEntries.set(key, entry);
  return entry;
}

export function itemListEntryKey(
  value: unknown,
  surface: ItemListSurface,
  itemId: string | undefined,
): string | undefined {
  if (itemId === undefined || typeof value !== "object" || value === null) return undefined;
  const origin = (value as ItemListLocationState).itemListOrigin;
  if (typeof origin !== "object" || origin === null) return undefined;
  const { entryKey, surface: originSurface } = origin as ItemListOrigin;
  if (originSurface !== surface || typeof entryKey !== "string" || entryKey === "") {
    return undefined;
  }
  return storedHistoryEntry(surface, entryKey)?.itemId === itemId ? entryKey : undefined;
}

export function itemListHistoryEntry(
  surface: ItemListSurface,
  entryKey: string,
): ItemListHistoryEntry | undefined {
  return storedHistoryEntry(surface, entryKey);
}

export function itemListOriginState(
  surface: ItemListSurface,
  entryKey: string,
): ItemListLocationState {
  return { itemListOrigin: { entryKey, surface } };
}

export function rememberItemListPosition(
  surface: ItemListSurface,
  entryKey: string,
  itemId: string,
  scrollY: number,
  view?: ItemListView,
): void {
  if (entryKey === "" || itemId === "" || !Number.isFinite(scrollY) || scrollY < 0) return;
  const key = historyKey(surface, entryKey);
  historyEntries.delete(key);
  historyEntries.set(key, { itemId, scrollY, ...(view === undefined ? {} : { view }) });
  while (historyEntries.size > ITEM_LIST_HISTORY_LIMIT) {
    const oldestKey = historyEntries.keys().next().value;
    if (oldestKey === undefined) break;
    historyEntries.delete(oldestKey);
  }
}
