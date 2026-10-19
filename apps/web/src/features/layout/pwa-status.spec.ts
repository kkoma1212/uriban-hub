import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { describe, expect, it, vi } from "vitest";

import {
  PwaStatusController,
  type PwaRuntime,
  type PwaRuntimeEvent,
  type RegisterServiceWorker,
} from "./pwa-status";

class FakePwaRuntime implements PwaRuntime {
  readonly reload = vi.fn();
  private readonly events = new EventTarget();
  private nextTimer = 1;
  private readonly timers = new Map<number, { callback: () => void; delay: number }>();
  visible = true;

  constructor(public online = true) {}

  addEventListener(type: PwaRuntimeEvent, listener: EventListener): void {
    this.events.addEventListener(type, listener);
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  getOnline(): boolean {
    return this.online;
  }

  getVisible(): boolean {
    return this.visible;
  }

  getTimerDelays(): number[] {
    return [...this.timers.values()].map(({ delay }) => delay);
  }

  removeEventListener(type: PwaRuntimeEvent, listener: EventListener): void {
    this.events.removeEventListener(type, listener);
  }

  setTimeout(callback: () => void, delay: number): number {
    const handle = this.nextTimer++;
    this.timers.set(handle, { callback, delay });
    return handle;
  }

  emit(type: PwaRuntimeEvent): void {
    if (type === "online" || type === "offline") this.online = type === "online";
    this.events.dispatchEvent(new Event(type));
  }

  runTimers(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    callbacks.forEach(({ callback }) => callback());
  }
}

function registrationHarness(update: () => Promise<void> = vi.fn(async () => undefined)): {
  getOptions: () => RegisterSWOptions;
  register: RegisterServiceWorker;
} {
  let options: RegisterSWOptions | undefined;
  const register = vi.fn((received?: RegisterSWOptions) => {
    options = received;
    return update;
  });

  return {
    getOptions: () => {
      if (options === undefined) throw new Error("Service worker was not registered");
      return options;
    },
    register,
  };
}

describe("PwaStatusController", () => {
  it("checks every minute while visible and checks immediately on focus/online return", async () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    const update = vi.fn(async () => undefined);
    controller.start(harness.register, runtime);
    harness
      .getOptions()
      .onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    expect(runtime.getTimerDelays()).toEqual([60_000]);
    runtime.runTimers();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(runtime.getTimerDelays()).toEqual([60_000]);
    runtime.emit("focus");
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    runtime.visible = false;
    runtime.emit("visibilitychange");
    expect(runtime.getTimerDelays()).toEqual([]);
    runtime.emit("focus");
    runtime.runTimers();
    expect(update).toHaveBeenCalledTimes(2);
    runtime.visible = true;
    runtime.emit("visibilitychange");
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(3);
    runtime.emit("offline");
    expect(runtime.getTimerDelays()).toEqual([]);
    runtime.emit("online");
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(4);
    expect(runtime.getTimerDelays()).toEqual([5_000, 60_000]);
    controller.destroy();
    expect(runtime.getTimerDelays()).toEqual([]);
    runtime.emit("focus");
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent checks and never resurrects timers after destroy", async () => {
    let finish: (() => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    controller.start(harness.register, runtime);
    harness
      .getOptions()
      .onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    runtime.emit("focus");
    runtime.emit("focus");
    runtime.emit("online");
    expect(update).toHaveBeenCalledOnce();
    expect(runtime.getTimerDelays()).toEqual([]);
    controller.destroy();
    finish?.();
    await Promise.resolve();
    harness
      .getOptions()
      .onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    expect(runtime.getTimerDelays()).toEqual([]);
    const restarted = registrationHarness();
    controller.start(restarted.register, runtime);
    harness
      .getOptions()
      .onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    expect(runtime.getTimerDelays()).toEqual([]);
    controller.destroy();
  });

  it("retries a failed check quietly and stops checks when a new worker requests one reload", async () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    const update = vi.fn(async () => {
      throw new Error("synthetic network interruption");
    });
    controller.start(harness.register, runtime);
    harness
      .getOptions()
      .onRegisteredSW?.("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    runtime.runTimers();
    await Promise.resolve();
    expect(runtime.getTimerDelays()).toEqual([60_000]);
    expect(controller.getSnapshot()).toMatchObject({
      registrationError: false,
      updateError: false,
    });
    harness.getOptions().onNeedReload?.();
    harness.getOptions().onNeedReload?.();
    expect(runtime.reload).toHaveBeenCalledOnce();
    expect(runtime.getTimerDelays()).toEqual([]);
    runtime.emit("focus");
    expect(update).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it("does not poll without a registration or while first registered in a hidden tab", () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    controller.start(harness.register, runtime);
    harness.getOptions().onRegisteredSW?.("/sw.js", undefined);
    expect(runtime.getTimerDelays()).toEqual([]);
    runtime.visible = false;
    harness.getOptions().onRegisteredSW?.("/sw.js", {
      update: vi.fn(async () => undefined),
    } as unknown as ServiceWorkerRegistration);
    expect(runtime.getTimerDelays()).toEqual([]);
    controller.destroy();
  });

  it("registers once and does not reopen a dismissed duplicate update prompt", () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();

    controller.start(harness.register, runtime);
    controller.start(harness.register, runtime);

    expect(harness.register).toHaveBeenCalledOnce();
    expect(harness.getOptions().immediate).toBe(true);

    harness.getOptions().onNeedRefresh?.();
    harness.getOptions().onNeedRefresh?.();
    expect(controller.getSnapshot().updateAvailable).toBe(true);

    controller.dismissUpdate();
    harness.getOptions().onNeedRefresh?.();
    expect(controller.getSnapshot()).toMatchObject({
      updateAvailable: false,
      updateDismissed: true,
    });

    controller.destroy();
  });

  it("guards duplicate update clicks and duplicate reload callbacks", async () => {
    let finishUpdate: (() => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        }),
    );
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness(update);
    controller.start(harness.register, runtime);
    harness.getOptions().onNeedRefresh?.();

    const firstApply = controller.applyUpdate();
    const secondApply = controller.applyUpdate();
    expect(update).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().updating).toBe(true);

    harness.getOptions().onNeedReload?.();
    harness.getOptions().onNeedReload?.();
    expect(runtime.reload).toHaveBeenCalledOnce();

    finishUpdate?.();
    await Promise.all([firstApply, secondApply]);
    controller.destroy();
  });

  it("shows an honest offline state and a temporary recovered state", () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    controller.start(harness.register, runtime);

    runtime.emit("offline");
    expect(controller.getSnapshot()).toMatchObject({ online: false, recovered: false });

    runtime.emit("online");
    expect(controller.getSnapshot()).toMatchObject({ online: true, recovered: true });

    runtime.runTimers();
    expect(controller.getSnapshot().recovered).toBe(false);
    controller.destroy();
  });

  it("says a new version is downloading only when it will replace a running one", () => {
    // 가짜 서비스 워커 등록: updatefound를 쏘고 받는 중인 워커(installing)를 바꿔 낄 수 있다.
    function fakeRegistration() {
      const events = new EventTarget();
      const worker = Object.assign(new EventTarget(), { state: "installing" });
      const registration = Object.assign(events, {
        installing: null as typeof worker | null,
        update: vi.fn(async () => undefined),
      });
      return {
        registration: registration as unknown as ServiceWorkerRegistration,
        startDownload: () => {
          registration.installing = worker;
          events.dispatchEvent(new Event("updatefound"));
        },
        fail: () => {
          worker.state = "redundant";
          worker.dispatchEvent(new Event("statechange"));
        },
      };
    }

    // 처음 설치(관리 중인 옛 버전 없음)에는 띄우지 않는다.
    const first = new PwaStatusController();
    const firstRuntime = Object.assign(new FakePwaRuntime(), { hasController: () => false });
    const firstHarness = registrationHarness();
    first.start(firstHarness.register, firstRuntime);
    const firstSw = fakeRegistration();
    firstHarness.getOptions().onRegisteredSW?.("/sw.js", firstSw.registration);
    firstSw.startDownload();
    expect(first.getSnapshot().updateDownloading).toBe(false);
    first.destroy();

    const controller = new PwaStatusController();
    const runtime = Object.assign(new FakePwaRuntime(), { hasController: () => true });
    const harness = registrationHarness();
    controller.start(harness.register, runtime);
    const sw = fakeRegistration();
    harness.getOptions().onRegisteredSW?.("/sw.js", sw.registration);
    expect(controller.getSnapshot().updateDownloading).toBe(false);
    sw.startDownload();
    expect(controller.getSnapshot().updateDownloading).toBe(true);
    // 받기에 실패하면 안내를 거둔다.
    sw.fail();
    expect(controller.getSnapshot().updateDownloading).toBe(false);
    // 다시 받기 시작했다가 새로고침 없이 오래 걸리면 상한에서 거둔다.
    sw.startDownload();
    expect(controller.getSnapshot().updateDownloading).toBe(true);
    expect(runtime.getTimerDelays()).toContain(90_000);
    runtime.runTimers();
    expect(controller.getSnapshot().updateDownloading).toBe(false);
    controller.destroy();
  });

  it("offers a retry if an update does not take control before the watchdog", async () => {
    const controller = new PwaStatusController();
    const runtime = new FakePwaRuntime();
    const harness = registrationHarness();
    controller.start(harness.register, runtime);
    harness.getOptions().onNeedRefresh?.();

    await controller.applyUpdate();
    runtime.runTimers();

    expect(controller.getSnapshot()).toMatchObject({
      updateAvailable: true,
      updateError: true,
      updating: false,
    });
    controller.destroy();
  });
});
