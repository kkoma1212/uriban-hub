import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../../api/auth";
import * as api from "../../api/push-subscriptions";
import * as browser from "../../lib/push-notifications";
import { PushNotificationPanel } from "./push-notification-panel";

vi.mock("../../api/push-subscriptions", () => ({
  getPushConfig: vi.fn(),
  removePushSubscription: vi.fn(),
  savePushSubscription: vi.fn(),
  sendTestPush: vi.fn(),
}));
vi.mock("../../lib/push-notifications", () => ({
  currentBrowserSubscription: vi.fn(),
  detectPushSupport: vi.fn(),
  hasServiceWorker: vi.fn(),
  notificationPermission: vi.fn(),
  subscribeBrowser: vi.fn(),
}));

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/qa",
  keys: { auth: "a".repeat(22), p256dh: "b".repeat(87) },
};

beforeEach(() => {
  vi.mocked(api.getPushConfig).mockResolvedValue({ public_key: "k".repeat(87) });
  vi.mocked(browser.detectPushSupport).mockReturnValue("supported");
  vi.mocked(browser.hasServiceWorker).mockResolvedValue(true);
  vi.mocked(browser.notificationPermission).mockReturnValue("default");
  vi.mocked(browser.currentBrowserSubscription).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PushNotificationPanel", () => {
  it("서버에서 웹 푸시가 꺼져 있으면 아무것도 보여 주지 않는다", async () => {
    vi.mocked(api.getPushConfig).mockRejectedValue(new Error("404"));
    const { container } = render(<PushNotificationPanel />);
    await waitFor(() => expect(api.getPushConfig).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("홈 화면에 추가하지 않은 아이폰에는 설치 방법만 안내한다", async () => {
    vi.mocked(browser.detectPushSupport).mockReturnValue("ios-needs-install");
    render(<PushNotificationPanel />);
    expect(await screen.findByText(/홈 화면에 추가해야 알림을/u)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("서비스 워커가 없는 화면에서는 멈추지 않고 안내를 보여 준다", async () => {
    vi.mocked(browser.hasServiceWorker).mockResolvedValue(false);
    render(<PushNotificationPanel />);
    expect(await screen.findByText(/이 화면에서는 알림을 켤 수 없습니다/u)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("알림을 켜면 브라우저 구독을 서버에 저장한다", async () => {
    vi.mocked(browser.subscribeBrowser).mockResolvedValue(subscription);
    vi.mocked(api.savePushSubscription).mockResolvedValue();
    render(<PushNotificationPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /이 기기에서 알림 받기/u }));
    expect(await screen.findByRole("status")).toHaveTextContent("이 기기에서 알림을 받습니다.");
    expect(browser.subscribeBrowser).toHaveBeenCalledWith("k".repeat(87));
    expect(api.savePushSubscription).toHaveBeenCalledWith(subscription);
    expect(screen.getByRole("button", { name: /테스트 알림 보내기/u })).toBeInTheDocument();
  });

  it("권한을 거부하면 서버에 저장하지 않고 이유를 알린다", async () => {
    vi.mocked(browser.subscribeBrowser).mockResolvedValue(null);
    render(<PushNotificationPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /이 기기에서 알림 받기/u }));
    expect(await screen.findByRole("status")).toHaveTextContent("알림이 허용되지 않았습니다");
    expect(api.savePushSubscription).not.toHaveBeenCalled();
  });

  it("차단된 브라우저에는 켜기 버튼 대신 설정 방법을 안내한다", async () => {
    vi.mocked(browser.notificationPermission).mockReturnValue("denied");
    render(<PushNotificationPanel />);
    expect(await screen.findByText(/알림이 차단되어 있습니다/u)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("구독 중이면 테스트 알림과 끄기를 제공하고, 끄면 서버와 브라우저 구독을 모두 지운다", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const browserSubscription = {
      endpoint: subscription.endpoint,
      unsubscribe,
    } as unknown as PushSubscription;
    vi.mocked(browser.currentBrowserSubscription).mockResolvedValue(browserSubscription);
    vi.mocked(api.sendTestPush).mockResolvedValue({ sent: 1 });
    vi.mocked(api.removePushSubscription).mockResolvedValue();
    render(<PushNotificationPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /테스트 알림 보내기/u }));
    expect(await screen.findByRole("status")).toHaveTextContent("테스트 알림을 보냈습니다.");

    fireEvent.click(screen.getByRole("button", { name: /알림 끄기/u }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("이 기기의 알림을 껐습니다."),
    );
    expect(api.removePushSubscription).toHaveBeenCalledWith(subscription.endpoint);
    expect(unsubscribe).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /이 기기에서 알림 받기/u })).toBeInTheDocument();
  });

  it("테스트 알림 제한에 걸리면 기다릴 이유를 알린다", async () => {
    vi.mocked(browser.currentBrowserSubscription).mockResolvedValue({
      endpoint: subscription.endpoint,
    } as unknown as PushSubscription);
    vi.mocked(api.sendTestPush).mockRejectedValue(new ApiRequestError("RATE_LIMITED", "제한", 429));
    render(<PushNotificationPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /테스트 알림 보내기/u }));
    expect(await screen.findByRole("status")).toHaveTextContent("10분에 세 번까지");
  });
});
