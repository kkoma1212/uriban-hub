import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const MODAL_BASE_Z_INDEX = 1_000;

interface ModalLayer {
  dialogRef: RefObject<HTMLElement | null>;
  fallbackFocusTo: HTMLElement | null;
  host: HTMLElement | null;
  hostStackIndex: string | null;
  hostZIndex: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusTo: HTMLElement | null;
}

interface SuppressedNodeState {
  ariaHidden: string | null;
  count: number;
  inert: string | null;
  inertPresent: boolean;
}

interface ModalEnvironment {
  baseFallbackFocus: HTMLElement | null;
  baseReturnFocus: HTMLElement | null;
  focusRedirecting: boolean;
  observer: MutationObserver | null;
  previousBodyOverflow: string;
  stack: ModalLayer[];
  suppressedNodes: Map<HTMLElement, SuppressedNodeState>;
}

const environments = new WeakMap<Document, ModalEnvironment>();

function environmentFor(document: Document): ModalEnvironment {
  const existing = environments.get(document);
  if (existing !== undefined) return existing;

  const created: ModalEnvironment = {
    baseFallbackFocus: null,
    baseReturnFocus: null,
    focusRedirecting: false,
    observer: null,
    previousBodyOverflow: "",
    stack: [],
    suppressedNodes: new Map(),
  };
  environments.set(document, created);
  return created;
}

function topLayer(environment: ModalEnvironment): ModalLayer | undefined {
  return environment.stack.at(-1);
}

function directBodyHost(document: Document, element: HTMLElement | null): HTMLElement | null {
  if (element === null) return null;
  let candidate = element;
  while (candidate.parentElement !== null && candidate.parentElement !== document.body) {
    candidate = candidate.parentElement;
  }
  return candidate.parentElement === document.body ? candidate : null;
}

function restoreLayerHost(layer: ModalLayer): void {
  if (layer.host === null) return;
  layer.host.style.zIndex = layer.hostZIndex;
  if (layer.hostStackIndex === null) layer.host.removeAttribute("data-modal-stack-index");
  else layer.host.setAttribute("data-modal-stack-index", layer.hostStackIndex);
  layer.host = null;
  layer.hostStackIndex = null;
  layer.hostZIndex = "";
}

function updateLayerHosts(document: Document, environment: ModalEnvironment): void {
  environment.stack.forEach((layer, index) => {
    const host = directBodyHost(document, layer.dialogRef.current);
    if (host !== layer.host) {
      restoreLayerHost(layer);
      layer.host = host;
      if (host !== null) {
        layer.hostZIndex = host.style.zIndex;
        layer.hostStackIndex = host.getAttribute("data-modal-stack-index");
      }
    }
    if (host !== null) {
      host.style.zIndex = String(MODAL_BASE_Z_INDEX + index);
      host.setAttribute("data-modal-stack-index", String(index));
    }
  });
}

function setSuppressionCount(
  environment: ModalEnvironment,
  element: HTMLElement,
  count: number,
): void {
  const existing = environment.suppressedNodes.get(element);
  if (count === 0) {
    if (existing === undefined) return;
    if (existing.inertPresent) element.setAttribute("inert", existing.inert ?? "");
    else element.removeAttribute("inert");
    if (existing.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", existing.ariaHidden);
    environment.suppressedNodes.delete(element);
    return;
  }

  const state =
    existing ??
    ({
      ariaHidden: element.getAttribute("aria-hidden"),
      count: 0,
      inert: element.getAttribute("inert"),
      inertPresent: element.hasAttribute("inert"),
    } satisfies SuppressedNodeState);
  state.count = count;
  environment.suppressedNodes.set(element, state);
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function synchronizeBodySiblings(document: Document, environment: ModalEnvironment): void {
  const topHost = topLayer(environment)?.host ?? null;
  const depth = environment.stack.length;
  const desired = new Set<HTMLElement>();
  if (depth > 0) {
    for (const child of document.body.children) {
      if (child instanceof HTMLElement && child !== topHost) desired.add(child);
    }
  }

  for (const element of desired) setSuppressionCount(environment, element, depth);
  for (const element of [...environment.suppressedNodes.keys()]) {
    if (!desired.has(element)) setSuppressionCount(environment, element, 0);
  }
}

function hasHiddenOrInertAncestor(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current !== null) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return true;
    }
    const view: Window | null = current.ownerDocument.defaultView;
    const style = view?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse" ||
      style?.contentVisibility === "hidden" ||
      style?.opacity === "0"
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function hasRenderedBox(element: HTMLElement): boolean {
  const document = element.ownerDocument;
  if (document.documentElement.getClientRects().length === 0) return true;
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function isEnabledFocusTarget(element: HTMLElement): boolean {
  if (element.getAttribute("aria-disabled") === "true") return false;
  if ("disabled" in element && Boolean((element as HTMLElement & { disabled: boolean }).disabled)) {
    return false;
  }
  try {
    if (element.matches(":disabled")) return false;
  } catch {
    return false;
  }
  return true;
}

function isEligibleFocusTarget(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    element.isConnected &&
    isEnabledFocusTarget(element) &&
    !hasHiddenOrInertAncestor(element) &&
    hasRenderedBox(element)
  );
}

function attemptFocus(
  environment: ModalEnvironment,
  element: HTMLElement | null,
  allowTemporaryTabIndex = false,
): boolean {
  if (!isEligibleFocusTarget(element)) return false;
  const activeElement = element.ownerDocument.activeElement;
  if (activeElement === element) return true;
  if (environment.focusRedirecting) return false;

  const needsTemporaryTabIndex = allowTemporaryTabIndex && !element.matches(FOCUSABLE_SELECTOR);
  const previousTabIndex = element.getAttribute("tabindex");
  if (needsTemporaryTabIndex) element.setAttribute("tabindex", "-1");
  environment.focusRedirecting = true;
  try {
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
  } catch {
    return false;
  } finally {
    environment.focusRedirecting = false;
    if (needsTemporaryTabIndex) {
      if (previousTabIndex === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", previousTabIndex);
    }
  }
  return element.ownerDocument.activeElement === element;
}

function focusableElements(layer: ModalLayer): HTMLElement[] {
  return Array.from(
    layer.dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
  ).filter(isEligibleFocusTarget);
}

function focusLayer(environment: ModalEnvironment, layer: ModalLayer): boolean {
  const dialog = layer.dialogRef.current;
  if (dialog === null) return false;

  if (attemptFocus(environment, layer.initialFocusRef.current)) return true;
  for (const candidate of focusableElements(layer)) {
    if (attemptFocus(environment, candidate)) return true;
  }
  return attemptFocus(environment, dialog, true);
}

function focusSafeApplicationFallback(document: Document, environment: ModalEnvironment): boolean {
  const appRoot = document.getElementById("root");
  const explicit = document.querySelector<HTMLElement>("[data-modal-fallback-focus]");
  if (attemptFocus(environment, explicit, true)) return true;

  if (appRoot !== null) {
    for (const candidate of appRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      if (attemptFocus(environment, candidate)) return true;
    }
  }

  const main =
    appRoot?.querySelector<HTMLElement>("main") ?? document.querySelector<HTMLElement>("main");
  if (attemptFocus(environment, main, true)) return true;
  if (attemptFocus(environment, appRoot, true)) return true;
  return attemptFocus(environment, document.body, true);
}

function restoreFocusAfterLastLayer(
  document: Document,
  environment: ModalEnvironment,
  layer: ModalLayer,
): void {
  for (const target of [
    layer.returnFocusTo,
    layer.fallbackFocusTo,
    environment.baseReturnFocus,
    environment.baseFallbackFocus,
  ]) {
    if (attemptFocus(environment, target, true)) return;
  }
  focusSafeApplicationFallback(document, environment);
}

export interface ModalIsolationOptions {
  dialogRef: RefObject<HTMLElement | null>;
  fallbackFocusTo?: HTMLElement | null | undefined;
  initialFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  open: boolean;
  returnFocusTo?: HTMLElement | null | undefined;
}

/**
 * Owns the document-wide modal stack. Only the last mounted modal remains exposed; every other
 * direct body child is ref-counted as inert and aria-hidden until it becomes top-most again.
 */
export function useModalIsolation({
  dialogRef,
  fallbackFocusTo,
  initialFocusRef,
  onDismiss,
  open,
  returnFocusTo,
}: ModalIsolationOptions): void {
  const fallbackFocusRef = useRef(fallbackFocusTo);
  const onDismissRef = useRef(onDismiss);
  const returnFocusRef = useRef(returnFocusTo);
  fallbackFocusRef.current = fallbackFocusTo;
  onDismissRef.current = onDismiss;
  returnFocusRef.current = returnFocusTo;

  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;

    const environment = environmentFor(document);
    const activeElement =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
        ? document.activeElement
        : null;
    const layer: ModalLayer = {
      dialogRef,
      fallbackFocusTo: fallbackFocusRef.current ?? null,
      host: null,
      hostStackIndex: null,
      hostZIndex: "",
      initialFocusRef,
      returnFocusTo: returnFocusRef.current ?? activeElement,
    };

    if (environment.stack.length === 0) {
      environment.baseReturnFocus = layer.returnFocusTo;
      environment.baseFallbackFocus = layer.fallbackFocusTo;
      environment.previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const Observer = document.defaultView?.MutationObserver;
      if (Observer !== undefined) {
        environment.observer = new Observer(() => {
          updateLayerHosts(document, environment);
          synchronizeBodySiblings(document, environment);
        });
        environment.observer.observe(document.body, { childList: true });
      }
    }

    environment.stack.push(layer);
    updateLayerHosts(document, environment);
    focusLayer(environment, layer);
    synchronizeBodySiblings(document, environment);

    function handleKeyDown(event: KeyboardEvent): void {
      if (topLayer(environment) !== layer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onDismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const candidates = focusableElements(layer);
      if (dialog === null || candidates.length === 0) {
        event.preventDefault();
        focusLayer(environment, layer);
        return;
      }

      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || !(active instanceof Node) || !dialog.contains(active))
      ) {
        event.preventDefault();
        attemptFocus(environment, last ?? null);
      } else if (
        !event.shiftKey &&
        (active === last || !(active instanceof Node) || !dialog.contains(active))
      ) {
        event.preventDefault();
        attemptFocus(environment, first ?? null);
      }
    }

    function keepFocusInside(event: FocusEvent): void {
      if (topLayer(environment) !== layer || environment.focusRedirecting) return;
      const dialog = dialogRef.current;
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) {
        focusLayer(environment, layer);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", keepFocusInside);

      const layerIndex = environment.stack.indexOf(layer);
      const wasTop = layerIndex === environment.stack.length - 1;
      if (layerIndex !== -1) environment.stack.splice(layerIndex, 1);
      restoreLayerHost(layer);
      updateLayerHosts(document, environment);
      synchronizeBodySiblings(document, environment);

      const nextLayer = topLayer(environment);
      if (nextLayer !== undefined) {
        if (wasTop) {
          const nextDialog = nextLayer.dialogRef.current;
          const nestedTargets = [layer.returnFocusTo, layer.fallbackFocusTo];
          const restoredNestedTarget = nestedTargets.some(
            (target) =>
              target !== null &&
              nextDialog?.contains(target) === true &&
              attemptFocus(environment, target, true),
          );
          if (!restoredNestedTarget) focusLayer(environment, nextLayer);
        }
        return;
      }

      environment.observer?.disconnect();
      environment.observer = null;
      document.body.style.overflow = environment.previousBodyOverflow;
      synchronizeBodySiblings(document, environment);
      restoreFocusAfterLastLayer(document, environment, layer);
      environment.baseReturnFocus = null;
      environment.baseFallbackFocus = null;
      environment.previousBodyOverflow = "";
      environment.focusRedirecting = false;
    };
  }, [dialogRef, initialFocusRef, open]);
}
