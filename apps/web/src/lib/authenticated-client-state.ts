import { clearNavigationCapabilities } from "./navigation-capabilities";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";

const IDEMPOTENT_CREATE_STORAGE_PREFIX = "classhub:idempotent-create:";
const REUSE_DRAFT_STORAGE_PREFIX = "classhub:content-reuse:";
const CHANGE_REVIEW_STORAGE_PREFIX = "classhub:change-review:";
export const AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL =
  "classhub:authenticated-client-state-clear-signal";
export const AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT =
  "classhub:authenticated-client-state-cleared";

function clearStoredIdempotentCreateAttempts(): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(IDEMPOTENT_CREATE_STORAGE_PREFIX) ||
        key?.startsWith(REUSE_DRAFT_STORAGE_PREFIX) ||
        key?.startsWith(CHANGE_REVIEW_STORAGE_PREFIX)
      )
        keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Navigation capabilities still clear when browser storage is unavailable.
  }
}

export function clearCurrentTabAuthenticatedClientState(): void {
  window.dispatchEvent(new Event(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT));
  clearNavigationCapabilities();
  clearStoredIdempotentCreateAttempts();
}

export function handleAuthenticatedClientStateStorage(
  event: Pick<StorageEvent, "key" | "newValue">,
  hardReplace: (path: string) => void = (path) => window.location.replace(path),
): void {
  if (event.key !== AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL || event.newValue === null) return;
  concealAuthenticatedDocument();
  try {
    clearCurrentTabAuthenticatedClientState();
  } finally {
    hardReplace("/bootstrap");
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleAuthenticatedClientStateStorage);
}

export function clearAuthenticatedClientState(): void {
  clearCurrentTabAuthenticatedClientState();
  try {
    window.localStorage.setItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL, crypto.randomUUID());
  } catch {
    // The initiating tab is already clear even when cross-tab signaling is unavailable.
  }
}
