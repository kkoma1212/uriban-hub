import {
  AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL,
  clearCurrentTabAuthenticatedClientState,
} from "./authenticated-client-state";
import { concealAuthenticatedDocument } from "./authenticated-document-privacy";

function readClearSignal(): string | null | undefined {
  try {
    return window.localStorage.getItem(AUTHENTICATED_CLIENT_STATE_CLEAR_SIGNAL);
  } catch {
    return undefined;
  }
}

export function installPageCachePrivacy(
  reload: () => void = () => window.location.reload(),
): () => void {
  let clearSignal = readClearSignal();

  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    clearSignal = readClearSignal();
    concealAuthenticatedDocument();
  };
  const handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    concealAuthenticatedDocument();
    const latestClearSignal = readClearSignal();
    try {
      // Frozen tabs may miss logout/membership invalidation events. Preserve
      // drafts and idempotency keys only when the signal is known unchanged.
      if (latestClearSignal === undefined || latestClearSignal !== clearSignal) {
        clearCurrentTabAuthenticatedClientState();
      }
    } finally {
      // Discard the old React state and rerun this route's user/admin auth.
      // Keep the document hidden even if the reload is slow or offline.
      reload();
    }
  };

  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
  };
}
