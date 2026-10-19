import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppEnvironment } from "../config/environment.js";
import { PushOutbox } from "./push-outbox.js";

// 보류 시간이 끝난 알림을 1분 안에 보낸다. 1인 운영의 단일 API 안에서 돌고, DB 잠금으로 중복을 막는다.
const PUSH_OUTBOX_INTERVAL_MS = 60_000;

@Injectable()
export class PushDeliveryScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("PushDeliveryScheduler");
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly enabled: boolean;

  constructor(
    private readonly outbox: PushOutbox,
    config: ConfigService<AppEnvironment, true>,
  ) {
    // 테스트에서는 타이머를 띄우지 않는다(각 테스트가 processDue를 직접 부른다).
    this.enabled = config.get("NODE_ENV", { infer: true }) !== "test";
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), PUSH_OUTBOX_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.outbox.processDue();
    } catch {
      // 대기열 오류가 API를 멈추지 않게 한다. 다음 주기에 다시 시도한다.
      this.logger.warn({ failure_code: "push_outbox_failed" });
    } finally {
      this.running = false;
    }
  }
}
