import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export interface PwaStatusSnapshot {
  online: boolean;
  recovered: boolean;
  registrationError: boolean;
  updateAvailable: boolean;
  updateDismissed: boolean;
  /** 옛 버전이 화면을 쥔 채 새 버전을 받는 중 — 끝나면 저절로 한 번 새로고침된다. */
  updateDownloading: boolean;
  updateError: boolean;
  updating: boolean;
}

export type PwaRuntimeEvent = "offline" | "online" | "focus" | "visibilitychange";

export interface PwaRuntime {
  addEventListener(type: PwaRuntimeEvent, listener: EventListener): void;
  clearTimeout(handle: number): void;
  getOnline(): boolean;
  getVisible(): boolean;
  /** 이미 설치된 서비스 워커가 이 화면을 관리하는지(처음 설치에는 바꿔 낄 옛 버전이 없다). */
  hasController?(): boolean;
  reload(): void;
  removeEventListener(type: PwaRuntimeEvent, listener: EventListener): void;
  setTimeout(callback: () => void, delay: number): number;
}

export type RegisterServiceWorker = (
  options?: RegisterSWOptions,
) => (reloadPage?: boolean) => Promise<void>;

const RECOVERY_MESSAGE_DURATION_MS = 5_000;
const UPDATE_WATCHDOG_DURATION_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;
/** 받는 중 안내가 새로고침 없이 남지 않게 하는 상한(느린 망에서도 1.7MB 안팎이면 충분). */
const UPDATE_DOWNLOAD_NOTICE_MAX_MS = 90_000;

const initialSnapshot: PwaStatusSnapshot = {
  online: true,
  recovered: false,
  registrationError: false,
  updateAvailable: false,
  updateDismissed: false,
  updateDownloading: false,
  updateError: false,
  updating: false,
};

function browserRuntime(): PwaRuntime {
  return {
    addEventListener: (type, listener) =>
      (type === "visibilitychange" ? document : window).addEventListener(type, listener),
    clearTimeout: (handle) => window.clearTimeout(handle),
    getOnline: () => navigator.onLine,
    getVisible: () => document.visibilityState === "visible",
    hasController: () => navigator.serviceWorker?.controller != null,
    reload: () => window.location.reload(),
    removeEventListener: (type, listener) =>
      (type === "visibilitychange" ? document : window).removeEventListener(type, listener),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  };
}

export class PwaStatusController {
  private listeners = new Set<() => void>();
  private recoveryTimer: number | null = null;
  private reloadRequested = false;
  private runtime: PwaRuntime | null = null;
  private snapshot: PwaStatusSnapshot = initialSnapshot;
  private started = false;
  private updateServiceWorker: (() => Promise<void>) | null = null;
  private updateWatchdog: number | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private checkingForUpdate = false;
  private updateCheckTimer: number | null = null;
  private lifecycle = 0;

  getSnapshot = (): PwaStatusSnapshot => this.snapshot;

  getServerSnapshot = (): PwaStatusSnapshot => initialSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(registerServiceWorker: RegisterServiceWorker, runtime = browserRuntime()): void {
    if (this.started) return;

    this.started = true;
    const lifecycle = ++this.lifecycle;
    this.runtime = runtime;
    this.setSnapshot({ online: runtime.getOnline() });
    runtime.addEventListener("offline", this.handleOffline);
    runtime.addEventListener("online", this.handleOnline);
    runtime.addEventListener("focus", this.handleForeground);
    runtime.addEventListener("visibilitychange", this.handleForeground);

    try {
      this.updateServiceWorker = registerServiceWorker({
        immediate: true,
        onNeedRefresh: this.markUpdateAvailable,
        onNeedReload: this.reloadPageOnce,
        onRegisterError: this.markRegistrationError,
        onRegisteredSW: (_url, registration) => {
          if (!this.started || this.lifecycle !== lifecycle) return;
          this.registration = registration ?? null;
          if (registration !== undefined && runtime.hasController?.() === true)
            this.watchUpdateDownload(registration, lifecycle);
          this.scheduleUpdateCheck();
        },
      });
    } catch {
      this.markRegistrationError();
    }
  }

  markUpdateAvailable = (): void => {
    if (this.snapshot.updateAvailable || this.snapshot.updateDismissed) return;

    this.setSnapshot({
      updateAvailable: true,
      updateError: false,
      updating: false,
    });
  };

  dismissUpdate = (): void => {
    if (this.snapshot.updating) return;
    this.setSnapshot({ updateAvailable: false, updateDismissed: true, updateError: false });
  };

  dismissRegistrationError = (): void => {
    this.setSnapshot({ registrationError: false });
  };

  applyUpdate = async (): Promise<void> => {
    if (!this.snapshot.updateAvailable || this.snapshot.updating) return;

    const updateServiceWorker = this.updateServiceWorker;
    if (updateServiceWorker === null) {
      this.setSnapshot({ updateError: true });
      return;
    }

    this.setSnapshot({ updateError: false, updating: true });
    this.startUpdateWatchdog();

    try {
      await updateServiceWorker();
    } catch {
      this.clearUpdateWatchdog();
      this.setSnapshot({ updateError: true, updating: false });
    }
  };

  destroy(): void {
    if (this.runtime !== null) {
      this.runtime.removeEventListener("offline", this.handleOffline);
      this.runtime.removeEventListener("online", this.handleOnline);
      this.runtime.removeEventListener("focus", this.handleForeground);
      this.runtime.removeEventListener("visibilitychange", this.handleForeground);
    }
    this.clearRecoveryTimer();
    this.clearUpdateWatchdog();
    this.clearUpdateCheck();
    this.listeners.clear();
    this.reloadRequested = false;
    this.runtime = null;
    this.snapshot = initialSnapshot;
    this.started = false;
    this.updateServiceWorker = null;
    this.registration = null;
    this.checkingForUpdate = false;
    this.lifecycle++;
  }

  private readonly handleOffline: EventListener = () => {
    this.clearRecoveryTimer();
    this.clearUpdateCheck();
    this.setSnapshot({ online: false, recovered: false });
  };

  private readonly handleOnline: EventListener = () => {
    const recovered = !this.snapshot.online;
    this.setSnapshot({ online: true, recovered });
    void this.checkForUpdate();
    if (!recovered || this.runtime === null) return;

    this.clearRecoveryTimer();
    this.recoveryTimer = this.runtime.setTimeout(() => {
      this.recoveryTimer = null;
      this.setSnapshot({ recovered: false });
    }, RECOVERY_MESSAGE_DURATION_MS);
  };

  private readonly handleForeground: EventListener = () => {
    void this.checkForUpdate();
  };

  private async checkForUpdate(): Promise<void> {
    this.clearUpdateCheck();
    const registration = this.registration;
    const runtime = this.runtime;
    if (
      registration === null ||
      runtime === null ||
      !runtime.getOnline() ||
      !runtime.getVisible() ||
      this.checkingForUpdate ||
      this.reloadRequested
    )
      return;
    const lifecycle = this.lifecycle;
    this.checkingForUpdate = true;
    try {
      await registration.update();
    } catch {
      // A failed background check leaves the installed app usable; retry on the next interval.
    } finally {
      if (this.lifecycle === lifecycle) {
        this.checkingForUpdate = false;
        this.scheduleUpdateCheck();
      }
    }
  }

  private scheduleUpdateCheck(): void {
    this.clearUpdateCheck();
    if (
      this.registration === null ||
      this.runtime === null ||
      this.checkingForUpdate ||
      this.reloadRequested ||
      !this.runtime.getOnline() ||
      !this.runtime.getVisible()
    )
      return;
    this.updateCheckTimer = this.runtime.setTimeout(() => {
      this.updateCheckTimer = null;
      void this.checkForUpdate();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  private clearUpdateCheck(): void {
    if (this.updateCheckTimer === null || this.runtime === null) return;
    this.runtime.clearTimeout(this.updateCheckTimer);
    this.updateCheckTimer = null;
  }

  /**
   * 새 버전을 받는 동안 옛 화면을 그대로 쓰다가 갑자기 새로고침되던 것을 알린다(2026-10-05 실기기
   * 검수, 사용자 선택 C). 받기에 실패하면(redundant) 안내를 거두고, 상한이 지나도 거둔다.
   */
  private watchUpdateDownload(registration: ServiceWorkerRegistration, lifecycle: number): void {
    const track = (): void => {
      const worker = registration.installing;
      if (worker === null || this.lifecycle !== lifecycle || this.runtime === null) return;
      this.setSnapshot({ updateDownloading: true });
      const clear = (): void => {
        if (this.lifecycle === lifecycle) this.setSnapshot({ updateDownloading: false });
      };
      worker.addEventListener("statechange", () => {
        if (worker.state === "redundant") clear();
      });
      this.runtime.setTimeout(clear, UPDATE_DOWNLOAD_NOTICE_MAX_MS);
    };
    registration.addEventListener("updatefound", track);
    track();
  }

  private readonly markRegistrationError = (_error?: unknown): void => {
    this.setSnapshot({ registrationError: true });
  };

  private readonly reloadPageOnce = (): void => {
    if (this.reloadRequested || this.runtime === null) return;

    this.reloadRequested = true;
    this.clearUpdateWatchdog();
    this.clearUpdateCheck();
    this.runtime.reload();
  };

  private setSnapshot(patch: Partial<PwaStatusSnapshot>): void {
    const nextSnapshot = { ...this.snapshot, ...patch };
    const changed = Object.entries(patch).some(
      ([key, value]) => this.snapshot[key as keyof PwaStatusSnapshot] !== value,
    );
    if (!changed) return;

    this.snapshot = nextSnapshot;
    this.listeners.forEach((listener) => listener());
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null || this.runtime === null) return;
    this.runtime.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private clearUpdateWatchdog(): void {
    if (this.updateWatchdog === null || this.runtime === null) return;
    this.runtime.clearTimeout(this.updateWatchdog);
    this.updateWatchdog = null;
  }

  private startUpdateWatchdog(): void {
    if (this.runtime === null) return;
    this.clearUpdateWatchdog();
    this.updateWatchdog = this.runtime.setTimeout(() => {
      this.updateWatchdog = null;
      if (!this.snapshot.updating || this.reloadRequested) return;
      this.setSnapshot({ updateError: true, updating: false });
    }, UPDATE_WATCHDOG_DURATION_MS);
  }
}

export const pwaStatusController = new PwaStatusController();
