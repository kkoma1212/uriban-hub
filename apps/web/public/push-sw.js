// 웹 푸시 수신 처리. vite-plugin-pwa가 만드는 sw.js가 importScripts로 불러온다.
// 알림 내용은 서버가 보낸 값만 쓰고, 누르면 이 앱 안의 경로로만 이동한다.
/* global self, clients, URL */
"use strict";

const DEFAULT_TITLE = "우리반 허브";
const DEFAULT_BODY = "새 안내가 있습니다.";
const DEFAULT_PATH = "/updates";
const ICON = "/icons/icon-192.png";

// 외부 사이트로 이동시키는 알림을 막는다. "/"로 시작하되 "//"(다른 호스트)는 거부한다.
function safeAppPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_PATH;
  }
  if (value.includes("\\")) return DEFAULT_PATH;
  return value;
}

function textOr(value, fallback, maxLength) {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, maxLength) : fallback;
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function notificationFromPayload(payload) {
  return {
    title: textOr(payload.title, DEFAULT_TITLE, 80),
    options: {
      body: textOr(payload.body, DEFAULT_BODY, 200),
      icon: ICON,
      badge: ICON,
      // 같은 tag의 알림은 새것이 옛것을 대체해 알림이 쌓이지 않게 한다.
      tag: textOr(payload.tag, undefined, 64),
      data: { path: safeAppPath(payload.path) },
    },
  };
}

async function openAppPath(path) {
  const url = new URL(path, self.location.origin).href;
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.focus();
    return client.navigate(url);
  }
  return clients.openWindow(url);
}

self.addEventListener("push", (event) => {
  const { title, options } = notificationFromPayload(readPayload(event));
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openAppPath(safeAppPath(event.notification.data?.path)));
});
