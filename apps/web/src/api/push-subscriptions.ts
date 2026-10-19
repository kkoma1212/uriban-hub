import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

/*
 * 통합순7 웹 푸시. 서버에는 브라우저가 준 구독(주소·키)만 보낸다.
 * 알림을 허용하지 않아도 앱 안 안내는 그대로 쓸 수 있다.
 */

export interface PushConfigResponse {
  public_key: string;
}

export interface SavedPushSubscription {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function getPushConfig(): Promise<PushConfigResponse> {
  const response = await apiFetch("/api/v1/push-subscriptions/config", {
    credentials: "include",
  });
  return parseResponse<PushConfigResponse>(response);
}

export async function savePushSubscription(subscription: SavedPushSubscription): Promise<void> {
  const body = JSON.stringify(subscription);
  await withCsrfRecovery<void>(
    ({ apiFetch: send, csrfToken }) =>
      send("/api/v1/push-subscriptions", {
        body,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        method: "PUT",
      }),
    parseEmptyResponse,
  );
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const body = JSON.stringify({ endpoint });
  await withCsrfRecovery<void>(
    ({ apiFetch: send, csrfToken }) =>
      send("/api/v1/push-subscriptions", {
        body,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        method: "DELETE",
      }),
    parseEmptyResponse,
  );
}

export async function sendTestPush(): Promise<{ sent: number }> {
  return withCsrfRecovery<{ sent: number }>(({ apiFetch: send, csrfToken }) =>
    send("/api/v1/push-subscriptions/test", {
      body: "{}",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      method: "POST",
    }),
  );
}
