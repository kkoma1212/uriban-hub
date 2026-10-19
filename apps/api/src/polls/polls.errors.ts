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

export class PollNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "투표를 찾을 수 없습니다." });
  }
}

export class PollRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 투표 작업을 수행할 권한이 없습니다.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class PollClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class PollDeadlineInvalidException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "투표 마감은 현재 시각 기준 5분 뒤부터 30일 이내로 설정해 주세요.",
    });
  }
}

export class PollOptionsDuplicateException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "같은 내용의 선택지는 한 번만 사용할 수 있습니다.",
    });
  }
}

export class InvalidPollCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "목록 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}

export class PollClosedException extends ConflictException {
  constructor() {
    super({ code: ERROR_CODES.POLL_CLOSED, message: "마감된 투표에는 참여할 수 없습니다." });
  }
}

// 진행 중 투표 수정(2026-10-04 사용자 결정, 제한형). 운영 DB에 원장 107·108이 깔리기 전에는 받지 않는다.
export class PollEditUnavailableException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.POLL_EDIT_UNAVAILABLE,
      message: "아직 투표를 고칠 수 없어요. 필요하면 투표를 마감하고 새로 만들어 주세요.",
    });
  }
}

/** 한 표라도 들어오면 선택지는 잠근다 — 이미 고른 표의 뜻이 바뀌지 않게. 제목·설명·마감은 고칠 수 있다. */
export class PollOptionsLockedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.POLL_OPTIONS_LOCKED,
      message:
        "이미 참여한 학생이 있어 선택지는 바꿀 수 없어요. 제목·설명·마감 시간만 고칠 수 있어요.",
    });
  }
}

export class PollAlreadyVotedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.POLL_ALREADY_VOTED,
      message: "이미 참여한 투표입니다. 제출한 선택은 변경할 수 없습니다.",
    });
  }
}

export function mapPollIdempotencyError(error: unknown): never {
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
