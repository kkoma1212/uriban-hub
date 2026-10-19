import { HttpException, HttpStatus, ServiceUnavailableException } from "@nestjs/common";

import { ERROR_CODES } from "../errors/error-codes.js";
import type { RateLimitResult } from "./redis-rate-limiter.js";

export class RateLimitServiceUnavailableException extends ServiceUnavailableException {
  constructor(cause?: unknown) {
    super(
      {
        code: ERROR_CODES.RATE_LIMIT_SERVICE_UNAVAILABLE,
        message: "요청 제한 서비스를 사용할 수 없습니다.",
      },
      cause === undefined ? undefined : { cause },
    );
  }
}

export class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number, limit?: RateLimitResult) {
    super(
      {
        code: ERROR_CODES.RATE_LIMITED,
        message: `요청 횟수에 도달했어요. ${Math.ceil(retryAfterSeconds)}초 뒤 다시 시도해 주세요.`,
        retry_after_seconds: retryAfterSeconds,
        details:
          limit === undefined
            ? {}
            : {
                attempts: Math.min(limit.count, limit.limit),
                max_attempts: limit.limit,
                remaining_attempts: limit.remaining,
              },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
