import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const pushWorkerSource = readFileSync(resolve(process.cwd(), "public/push-sw.js"), "utf8");
const ORIGIN = "https://class.example";

type Listener = (event: Record<string, unknown>) => void;

function loadPushWorker(windowClients: { url: string }[] = []) {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn(() => Promise.resolve());
  const navigate = vi.fn((url: string) => Promise.resolve(url));
  const focus = vi.fn(() => Promise.resolve());
  const openWindow = vi.fn((url: string) => Promise.resolve(url));
  const self = {
    location: { origin: ORIGIN },
    registration: { showNotification },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  const clients = {
    matchAll: () =>
      Promise.resolve(windowClients.map((client) => ({ ...client, navigate, focus }))),
    openWindow,
  };
  new Function("self", "clients", pushWorkerSource)(self, clients);
  return { listeners, showNotification, navigate, focus, openWindow };
}

async function dispatchPush(payload: unknown, windowClients?: { url: string }[]) {
  const worker = loadPushWorker(windowClients);
  let pending: Promise<unknown> = Promise.resolve();
  worker.listeners.get("push")?.({
    data:
      payload === undefined
        ? null
        : {
            json: () => {
              if (payload instanceof Error) throw payload;
              return payload;
            },
          },
    waitUntil: (promise: Promise<unknown>) => (pending = promise),
  });
  await pending;
  return worker;
}

async function clickNotification(path: unknown, windowClients?: { url: string }[]) {
  const worker = loadPushWorker(windowClients);
  const close = vi.fn();
  let pending: Promise<unknown> = Promise.resolve();
  worker.listeners.get("notificationclick")?.({
    notification: { close, data: { path } },
    waitUntil: (promise: Promise<unknown>) => (pending = promise),
  });
  await pending;
  return { ...worker, close };
}

describe("push-sw 웹 푸시 수신", () => {
  it("서버가 보낸 제목·본문·경로로 알림을 띄운다", async () => {
    const { showNotification } = await dispatchPush({
      title: "수행평가 일정 변경",
      body: "국어 발표가 금요일로 바뀌었습니다.",
      path: "/schedules/42",
      tag: "schedule-42",
    });
    expect(showNotification).toHaveBeenCalledWith("수행평가 일정 변경", {
      body: "국어 발표가 금요일로 바뀌었습니다.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "schedule-42",
      data: { path: "/schedules/42" },
    });
  });

  it("내용이 없거나 JSON이 아니면 기본 문구로 알림을 띄운다", async () => {
    for (const payload of [undefined, new Error("not json"), null, "text"]) {
      const { showNotification } = await dispatchPush(payload);
      expect(showNotification).toHaveBeenCalledWith(
        "우리반 허브",
        expect.objectContaining({ body: "새 안내가 있습니다.", data: { path: "/updates" } }),
      );
    }
  });

  it("다른 사이트로 가는 경로는 기본 경로로 바꾼다", async () => {
    for (const path of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "updates",
      7,
    ]) {
      const { showNotification } = await dispatchPush({ title: "t", body: "b", path });
      expect(showNotification).toHaveBeenCalledWith(
        "t",
        expect.objectContaining({ data: { path: "/updates" } }),
      );
    }
  });

  it("긴 제목과 본문은 잘라서 표시한다", async () => {
    const { showNotification } = await dispatchPush({
      title: "가".repeat(200),
      body: "나".repeat(500),
    });
    const [title, options] = showNotification.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(title).toHaveLength(80);
    expect(options.body).toHaveLength(200);
  });
});

describe("push-sw 알림 클릭", () => {
  it("열린 앱 창이 있으면 그 창을 앞으로 가져와 해당 경로로 이동한다", async () => {
    const { close, focus, navigate, openWindow } = await clickNotification("/supplies/3", [
      { url: `${ORIGIN}/home` },
    ]);
    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/supplies/3`);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("앱 창이 없거나 다른 사이트 창뿐이면 새 창을 연다", async () => {
    const { navigate, openWindow } = await clickNotification("/supplies/3", [
      { url: "https://other.example/" },
    ]);
    expect(navigate).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/supplies/3`);
  });

  it("클릭 경로가 외부 주소면 기본 경로로 연다", async () => {
    const { openWindow } = await clickNotification("https://evil.example/");
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/updates`);
  });
});
