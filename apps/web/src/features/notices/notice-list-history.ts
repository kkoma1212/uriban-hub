import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import type { ItemListView } from "../layout/item-list-history";

interface NoticeListLocationState {
  noticeListEntryKey?: unknown;
}

export interface NoticeListHistoryEntry {
  noticeId: string;
  scrollY: number;
  view?: ItemListView;
}

export const NOTICE_LIST_HISTORY_LIMIT = 20;

const historyEntries = new Map<string, NoticeListHistoryEntry>();

if (typeof window !== "undefined") {
  window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, () => historyEntries.clear());
}

function storedHistoryEntry(entryKey: string): NoticeListHistoryEntry | undefined {
  const entry = historyEntries.get(entryKey);
  if (entry === undefined) return undefined;
  historyEntries.delete(entryKey);
  historyEntries.set(entryKey, entry);
  return entry;
}

export function noticeListEntryKey(
  value: unknown,
  noticeId: string | undefined,
): string | undefined {
  if (noticeId === undefined) return undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const entryKey = (value as NoticeListLocationState).noticeListEntryKey;
  if (typeof entryKey !== "string" || entryKey === "") return undefined;
  return storedHistoryEntry(entryKey)?.noticeId === noticeId ? entryKey : undefined;
}

export function rememberNoticeListPosition(
  entryKey: string,
  noticeId: string,
  scrollY: number,
  view?: ItemListView,
): void {
  if (entryKey === "" || noticeId === "" || !Number.isFinite(scrollY) || scrollY < 0) return;
  historyEntries.delete(entryKey);
  historyEntries.set(entryKey, { noticeId, scrollY, ...(view === undefined ? {} : { view }) });
  while (historyEntries.size > NOTICE_LIST_HISTORY_LIMIT) {
    const oldestEntryKey = historyEntries.keys().next().value;
    if (oldestEntryKey === undefined) break;
    historyEntries.delete(oldestEntryKey);
  }
}

export function noticeListHistoryEntry(entryKey: string): NoticeListHistoryEntry | undefined {
  return storedHistoryEntry(entryKey);
}
