import { afterEach, describe, expect, it, vi } from "vitest";

import { detectPushSupport, unsubscribeBrowserQuietly } from "./push-notifications";

function stubBrowser({
  userAgent,
  platform = "Win32",
  maxTouchPoints = 0,
  standalone = false,
  pushApis = true,
}: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  pushApis?: boolean;
}) {
  vi.stubGlobal("navigator", {
    userAgent,
    platform,
    maxTouchPoints,
    standalone,
    ...(pushApis ? { serviceWorker: {} } : {}),
  });
  vi.stubGlobal("matchMedia", () => ({ matches: standalone }));
  if (pushApis) {
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", class {});
  } else {
    vi.stubGlobal("PushManager", undefined);
    Reflect.deleteProperty(window, "PushManager");
    Reflect.deleteProperty(window, "Notification");
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPushSupport", () => {
  it("홈 화면에 추가하지 않은 아이폰·아이패드는 설치 안내 대상이다", () => {
    stubBrowser({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" });
    expect(detectPushSupport()).toBe("ios-needs-install");
    stubBrowser({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 });
    expect(detectPushSupport()).toBe("ios-needs-install");
  });

  it("홈 화면 웹앱으로 연 아이폰과 데스크톱 브라우저는 지원한다", () => {
    stubBrowser({ userAgent: "Mozilla/5.0 (iPhone)", standalone: true });
    expect(detectPushSupport()).toBe("supported");
    stubBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140" });
    expect(detectPushSupport()).toBe("supported");
  });

  it("푸시 API가 없는 브라우저는 지원하지 않는다", () => {
    stubBrowser({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", pushApis: false });
    expect(detectPushSupport()).toBe("unsupported");
  });
});

describe("unsubscribeBrowserQuietly", () => {
  it("현재 브라우저 구독을 해제한다", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {},
        getRegistration: () =>
          Promise.resolve({
            pushManager: { getSubscription: () => Promise.resolve({ unsubscribe }) },
          }),
      },
    });
    await unsubscribeBrowserQuietly();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("해제가 실패하거나 멈춰도 로그아웃을 막지 않는다", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {}, getRegistration: () => Promise.reject(new Error("broken")) },
    });
    await expect(unsubscribeBrowserQuietly()).resolves.toBeUndefined();
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: {}, getRegistration: () => new Promise(() => undefined) },
    });
    await expect(unsubscribeBrowserQuietly(20)).resolves.toBeUndefined();
    vi.stubGlobal("navigator", {});
    await expect(unsubscribeBrowserQuietly()).resolves.toBeUndefined();
  });
});
