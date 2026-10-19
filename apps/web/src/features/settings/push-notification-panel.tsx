import { Bell, BellOff, LoaderCircle, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ApiRequestError } from "../../api/auth";
import {
  getPushConfig,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
} from "../../api/push-subscriptions";
import {
  currentBrowserSubscription,
  detectPushSupport,
  hasServiceWorker,
  notificationPermission,
  subscribeBrowser,
  type PushSupport,
} from "../../lib/push-notifications";

type PanelState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ready"; publicKey: string; support: PushSupport; subscribed: boolean };

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 429) {
    return "테스트 알림은 10분에 세 번까지 보낼 수 있습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  return "알림 설정을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
}

/** 서버에서 웹 푸시가 꺼져 있으면(설정 경로 404) 이 영역 전체를 보여 주지 않는다. */
export function PushNotificationPanel(): React.JSX.Element | null {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    try {
      const { public_key: publicKey } = await getPushConfig();
      const detected = detectPushSupport();
      const support: PushSupport =
        detected === "supported" && !(await hasServiceWorker()) ? "no-service-worker" : detected;
      const subscribed = (await currentBrowserSubscription()) !== null;
      setState({ kind: "ready", publicKey, support, subscribed });
    } catch {
      setState({ kind: "hidden" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "hidden" || state.kind === "loading") return null;

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setMessage(await action());
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      const subscription = await subscribeBrowser(state.publicKey);
      if (subscription === null) {
        return "알림이 허용되지 않았습니다. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.";
      }
      await savePushSubscription(subscription);
      setState({ ...state, subscribed: true });
      return "이 기기에서 알림을 받습니다.";
    });

  const disable = () =>
    run(async () => {
      const subscription = await currentBrowserSubscription();
      if (subscription !== null) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState({ ...state, subscribed: false });
      return "이 기기의 알림을 껐습니다.";
    });

  const test = () =>
    run(async () => {
      const { sent } = await sendTestPush();
      return sent > 0
        ? "테스트 알림을 보냈습니다. 몇 초 안에 도착하지 않으면 기기의 알림 설정을 확인해 주세요."
        : "보낼 수 있는 구독이 없습니다. 알림을 껐다가 다시 켜 주세요.";
    });

  const denied = notificationPermission() === "denied";

  return (
    <article
      className="rounded-card border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6"
      data-settings-section="push-notifications"
    >
      <h2 className="font-black text-app-text">알림</h2>
      <p className="mt-3 break-keep text-sm leading-6 text-app-muted">
        안내가 바뀌거나 확인하지 않은 안내가 있을 때 이 기기로 알려 드립니다. 알림을 받지 않아도 앱
        안의 안내는 그대로 볼 수 있습니다.
      </p>

      {state.support === "ios-needs-install" ? (
        <div className="mt-4 break-keep text-sm leading-6 text-app-text" data-push-guide="ios">
          <p className="font-bold">아이폰·아이패드는 홈 화면에 추가해야 알림을 받을 수 있습니다.</p>
          <ol className="mt-2 list-decimal pl-5">
            <li>Safari 아래쪽의 공유 버튼을 누릅니다.</li>
            <li>&lsquo;홈 화면에 추가&rsquo;를 누릅니다.</li>
            <li>홈 화면의 우리반 허브를 열고 이 화면에서 알림을 켭니다.</li>
          </ol>
        </div>
      ) : state.support === "unsupported" ? (
        <p
          className="mt-4 break-keep text-sm leading-6 text-app-text"
          data-push-guide="unsupported"
        >
          이 브라우저는 알림을 지원하지 않습니다. 최신 Chrome·Edge·Safari·Firefox를 사용해 주세요.
        </p>
      ) : state.support === "no-service-worker" ? (
        <p
          className="mt-4 break-keep text-sm leading-6 text-app-text"
          data-push-guide="no-service-worker"
        >
          이 화면에서는 알림을 켤 수 없습니다. 페이지를 새로고침하거나 설치한 앱에서 다시 열어
          주세요.
        </p>
      ) : denied && !state.subscribed ? (
        <p className="mt-4 break-keep text-sm leading-6 text-app-text" data-push-guide="denied">
          이 사이트의 알림이 차단되어 있습니다. 브라우저 주소창 옆의 사이트 설정에서 알림을 허용한
          뒤 다시 시도해 주세요.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-3">
          {state.subscribed ? (
            <>
              <button
                className="ui-button ui-button-secondary min-h-11 text-sm"
                disabled={busy}
                onClick={() => void test()}
                type="button"
              >
                <Send aria-hidden="true" size={17} /> 테스트 알림 보내기
              </button>
              <button
                className="ui-button ui-button-secondary min-h-11 text-sm"
                disabled={busy}
                onClick={() => void disable()}
                type="button"
              >
                <BellOff aria-hidden="true" size={17} /> 알림 끄기
              </button>
            </>
          ) : (
            <button
              className="ui-button ui-button-primary min-h-11 text-sm"
              disabled={busy}
              onClick={() => void enable()}
              type="button"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <Bell aria-hidden="true" size={17} />
              )}
              이 기기에서 알림 받기
            </button>
          )}
        </div>
      )}

      {message ? (
        <p aria-live="polite" className="mt-3 break-keep text-sm text-app-text" role="status">
          {message}
        </p>
      ) : null}
    </article>
  );
}
