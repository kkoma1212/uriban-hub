import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AuthenticatedCsrfGuard } from "../auth/authenticated-csrf.guard.js";
import {
  getAuthenticatedSession,
  type AuthenticatedFastifyRequest,
} from "../auth/authenticated-request.js";
import { AuthenticatedSessionGuard } from "../auth/authenticated-session.guard.js";
import { AUTH_RATE_LIMITER } from "../auth/auth.tokens.js";
import { RateLimitedException } from "../common/rate-limit/rate-limit.errors.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { RemovePushSubscriptionDto, SavePushSubscriptionDto } from "./push-subscriptions.dto.js";
import { PushSubscriptionsService } from "./push-subscriptions.service.js";
import { WebPushSender } from "./web-push-sender.js";

// 테스트 알림은 본인 기기 확인용이다. 푸시 서비스에 부담을 주지 않도록 10분에 3번까지만 허용한다.
const TEST_PUSH_LIMIT = 3;
const TEST_PUSH_WINDOW_SECONDS = 10 * 60;

@ApiTags("push-subscriptions")
@Controller("push-subscriptions")
export class PushSubscriptionsController {
  constructor(
    private readonly service: PushSubscriptionsService,
    private readonly sender: WebPushSender,
    @Inject(AUTH_RATE_LIMITER) private readonly rateLimiter: RedisRateLimiter,
  ) {}

  @Get("config")
  @UseGuards(AuthenticatedSessionGuard)
  config() {
    return this.service.config();
  }

  @Put()
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  async save(
    @Body() body: SavePushSubscriptionDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.service.save({
      auth: body.keys.auth,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      userId: getAuthenticatedSession(request).userId,
    });
  }

  @Post("test")
  @UseGuards(AuthenticatedCsrfGuard)
  async test(@Req() request: AuthenticatedFastifyRequest): Promise<{ sent: number }> {
    const { userId } = getAuthenticatedSession(request);
    const limit = await this.rateLimiter.consume({
      key: `push-test:user:${userId}`,
      limit: TEST_PUSH_LIMIT,
      windowSeconds: TEST_PUSH_WINDOW_SECONDS,
    });
    if (!limit.allowed) throw new RateLimitedException(limit.retryAfterSeconds, limit);
    const result = await this.sender.sendToUser(userId, {
      body: "이 기기에서 우리반 허브 알림을 받을 수 있습니다.",
      path: "/settings",
      tag: "push-test",
      title: "알림 확인",
    });
    return { sent: result.accepted };
  }

  @Delete()
  @HttpCode(204)
  @UseGuards(AuthenticatedCsrfGuard)
  async remove(
    @Body() body: RemovePushSubscriptionDto,
    @Req() request: AuthenticatedFastifyRequest,
  ): Promise<void> {
    await this.service.remove(getAuthenticatedSession(request).userId, body.endpoint);
  }
}
