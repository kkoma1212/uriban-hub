import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { PushSubscriptionsController } from "./push-subscriptions.controller.js";
import { PushSubscriptionsService } from "./push-subscriptions.service.js";
import { PushDeliveryScheduler } from "./push-delivery-scheduler.js";
import { PushOutbox } from "./push-outbox.js";
import { WebPushSender } from "./web-push-sender.js";

// 전역: 재알림·일정 서비스가 선택 주입으로 대기열을 쓴다(웹 푸시가 꺼지면 모듈 자체가 없다).
@Global()
@Module({
  imports: [AuthModule],
  controllers: [PushSubscriptionsController],
  providers: [PushSubscriptionsService, WebPushSender, PushOutbox, PushDeliveryScheduler],
  exports: [PushSubscriptionsService, WebPushSender, PushOutbox],
})
export class PushSubscriptionsModule {}
