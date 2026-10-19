import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../database/database.module.js";
import { parseAllowedPushEndpoint } from "./push-endpoint-policy.js";
import {
  decodeBase64Url,
  encryptPushPayload,
  parseVapidKeys,
  vapidAuthorization,
  type VapidKeys,
} from "./web-push-crypto.js";

export interface PushMessage {
  title: string;
  body: string;
  /** 앱 내부 경로. 서비스 워커가 한 번 더 내부 경로인지 확인한다. */
  path: string;
  /** 같은 tag의 알림은 기기에서 서로 대체된다. */
  tag?: string;
}

// 푸시 서비스가 전달 결과를 접수했다는 뜻이지, 학생이 봤다는 뜻이 아니다(공통 계약 1).
export interface PushDeliveryResult {
  accepted: number;
  removed: number;
  failed: number;
}

/** 테스트에서 푸시 서비스 대신 가짜 전송 함수를 넣는 주입 토큰. */
export const PUSH_FETCH = Symbol("PUSH_FETCH");

const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
// 404·410: 브라우저 구독이 사라졌다(RFC 8030 §7.3). 저장된 구독을 지운다.
const GONE_STATUSES = new Set([404, 410]);

@Injectable()
export class WebPushSender {
  private readonly logger = new Logger("WebPushSender");
  private readonly keys: VapidKeys;
  private readonly subject: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    @Inject(DATABASE) private readonly database: ClassHubDatabase,
    config: ConfigService<AppEnvironment, true>,
    @Optional() @Inject(PUSH_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    const publicKey = config.get("WEB_PUSH_VAPID_PUBLIC_KEY", { infer: true });
    const privateKey = config.get("WEB_PUSH_VAPID_PRIVATE_KEY", { infer: true });
    const subject = config.get("WEB_PUSH_SUBJECT", { infer: true });
    if (!publicKey || !privateKey || !subject) throw new Error("Web push is not configured.");
    this.keys = parseVapidKeys(publicKey, privateKey);
    this.subject = subject;
  }

  async sendToUser(userId: string, message: PushMessage): Promise<PushDeliveryResult> {
    const subscriptions = await this.database
      .selectFrom("push_subscriptions")
      .select(["id", "endpoint", "p256dh", "auth_secret"])
      .where("user_id", "=", userId)
      .execute();
    const plaintext = Buffer.from(JSON.stringify(message));
    const result: PushDeliveryResult = { accepted: 0, removed: 0, failed: 0 };
    for (const subscription of subscriptions) {
      const outcome = await this.deliver(subscription, plaintext);
      if (outcome === "gone") {
        await this.database
          .deleteFrom("push_subscriptions")
          .where("id", "=", subscription.id)
          .where("endpoint", "=", subscription.endpoint)
          .execute();
        result.removed += 1;
      } else {
        result[outcome] += 1;
      }
    }
    return result;
  }

  private async deliver(
    subscription: { endpoint: string; p256dh: string; auth_secret: string },
    plaintext: Buffer,
  ): Promise<"accepted" | "gone" | "failed"> {
    // 저장 뒤 허용 목록이 바뀌었을 수 있으므로 보내기 직전에 다시 확인한다.
    const endpoint = parseAllowedPushEndpoint(subscription.endpoint);
    if (endpoint === null) return "gone";
    try {
      const body = encryptPushPayload({
        plaintext,
        userAgentPublicKey: decodeBase64Url(subscription.p256dh),
        authSecret: decodeBase64Url(subscription.auth_secret),
      });
      const response = await this.fetchImpl(endpoint, {
        body,
        headers: {
          Authorization: vapidAuthorization(
            endpoint,
            this.subject,
            this.keys,
            Math.floor(Date.now() / 1000),
          ),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(PUSH_TTL_SECONDS),
          Urgency: "normal",
        },
        method: "POST",
        // 허용된 푸시 서비스 밖으로 끌려가지 않도록 리디렉션을 따르지 않는다.
        redirect: "manual",
        signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) return "accepted";
      if (GONE_STATUSES.has(response.status)) return "gone";
      // 구독 주소는 사용자 식별자에 가까우므로 로그에 남기지 않는다.
      this.logger.warn({ failure_code: "push_rejected", status: response.status });
      return "failed";
    } catch {
      this.logger.warn({ failure_code: "push_request_failed" });
      return "failed";
    }
  }
}
