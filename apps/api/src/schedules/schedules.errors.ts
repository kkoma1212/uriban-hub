import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
} from "@classhub/db";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class ScheduleNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "일정을 찾을 수 없습니다." });
  }
}

export class ScheduleRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 작업을 수행할 권한이 없습니다.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class ScheduleLinkTargetNotFoundException extends HttpException {
  constructor() {
    super(
      {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: "연결할 공지나 준비물을 찾을 수 없어요. 목록을 새로고침한 뒤 다시 골라 주세요.",
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ScheduleClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class InvalidScheduleCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "목록 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}

export class InvalidScheduleCalendarRangeException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "일정 조회 기간은 올바른 날짜 순서로 최대 42일까지 선택해 주세요.",
    });
  }
}

export function mapScheduleIdempotencyError(error: unknown): never {
  if (error instanceof IdempotencyKeyRequiredError) {
    throw new BadRequestException({
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      message: "Idempotency-Key 헤더가 필요합니다.",
    });
  }
  if (error instanceof InvalidIdempotencyKeyError) {
    throw new BadRequestException({
      code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY,
      message: "Idempotency-Key는 UUID 형식이어야 합니다.",
    });
  }
  if (error instanceof IdempotencyKeyReusedError) {
    throw new ConflictException({
      code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      message: "같은 Idempotency-Key가 다른 요청에 이미 사용되었습니다.",
    });
  }
  throw error;
}
