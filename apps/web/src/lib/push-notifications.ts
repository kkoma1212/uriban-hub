/*
 * 브라우저 웹 푸시 구독 도우미. 서버 저장은 api/push-subscriptions.ts가 맡는다.
 * iOS는 홈 화면에 추가한 웹앱에서만 푸시를 받을 수 있다(iOS 16.4+).
 */

export type PushSupport = "supported" | "ios-needs-install" | "unsupported" | "no-service-worker";

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isIos(navigatorLike: Navigator): boolean {
  // iPadOS는 데스크톱 Safari로 자신을 알리므로 터치 지점 수로 구분한다.
  return (
    /iPad|iPhone|iPod/u.test(navigatorLike.userAgent) ||
    (navigatorLike.platform === "MacIntel" && navigatorLike.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as NavigatorWithStandalone).standalone === true
  );
}

export function detectPushSupport(): PushSupport {
  const apisPresent =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos(navigator) && !isStandalone()) return "ios-needs-install";
  return apisPresent ? "supported" : "unsupported";
}

export function notificationPermission(): NotificationPermission {
  return "Notification" in window ? Notification.permission : "denied";
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/*
 * serviceWorker.ready는 서비스 워커가 없으면 끝나지 않는다(예: 로컬 개발 서버).
 * 그래서 현재 등록을 바로 조회하고, 없으면 기다리지 않고 알린다.
 */
export async function hasServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  return (await navigator.serviceWorker.getRegistration()) !== undefined;
}

async function pushManager(): Promise<PushManager> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) throw new Error("서비스 워커가 등록되지 않았습니다.");
  return registration.pushManager;
}

export async function currentBrowserSubscription(): Promise<PushSubscription | null> {
  if (detectPushSupport() !== "supported" || !(await hasServiceWorker())) return null;
  return (await pushManager()).getSubscription();
}

export interface BrowserSubscriptionJson {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

/** 알림 권한을 묻고 이 브라우저를 구독한다. 권한 거부 시 null. */
export async function subscribeBrowser(publicKey: string): Promise<BrowserSubscriptionJson | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;
  const manager = await pushManager();
  const subscription =
    (await manager.getSubscription()) ??
    (await manager.subscribe({
      applicationServerKey: applicationServerKey(publicKey),
      userVisibleOnly: true,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh) {
    throw new Error("브라우저가 알림 구독 정보를 주지 않았습니다.");
  }
  return { endpoint: json.endpoint, keys: { auth: json.keys.auth, p256dh: json.keys.p256dh } };
}

/**
 * 로그아웃 때 이 브라우저의 구독을 끊는다. 공용 기기에서 다음 사람에게
 * 이전 학생의 알림이 가지 않게 하려는 것이며, 실패해도 로그아웃은 막지 않는다.
 */
export async function unsubscribeBrowserQuietly(timeoutMs = 1500): Promise<void> {
  try {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
    const attempt = (async () => {
      const subscription = await (await pushManager()).getSubscription();
      await subscription?.unsubscribe();
    })();
    await Promise.race([attempt, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  } catch {
    // 구독 해제 실패는 로그아웃을 막을 이유가 아니다. 서버는 사라진 구독을 발송 때 지운다.
  }
}
