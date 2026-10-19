import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
} from "@classhub/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class ElectionNotFoundException extends NotFoundException {
  constructor(message = "선거를 찾을 수 없습니다.") {
    super({ code: ERROR_CODES.NOT_FOUND, message });
  }
}

export class ElectionRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 선거 작업을 수행할 권한이 없습니다.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class ElectionClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class ElectionInvalidException extends BadRequestException {
  constructor(message: string) {
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}

export class ElectionStatusConflictException extends ConflictException {
  constructor(message = "준비 중인 선거에만 후보를 등록할 수 있습니다.") {
    super({ code: ERROR_CODES.CONFLICT, message });
  }
}

export class ElectionCandidateAlreadyRegisteredException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CONFLICT,
      message: "이미 후보로 등록된 학생입니다.",
    });
  }
}

export class ElectionNotOpenException extends ConflictException {
  constructor(message = "지금은 투표할 수 있는 선거가 아닙니다.") {
    super({ code: ERROR_CODES.CONFLICT, message });
  }
}

/*
 * 이미 투표한 사람에게는 "했다"고만 알린다. 무엇을 골랐는지는 서버도 모르므로
 * 알려줄 수도 없다 — 그게 이 기능의 설계 그대로다.
 */
export class ElectionAlreadyVotedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CONFLICT,
      message: "이미 투표했어요. 한 사람이 한 번만 투표할 수 있습니다.",
    });
  }
}

/*
 * 동점인데 재투표 방식이면 개표로 끝낼 수 없다. 여기서 억지로 한 명을 고르면
 * 선거 만들 때 정한 규칙을 개표하면서 뒤집는 셈이다.
 */
export class ElectionRevoteRequiredException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CONFLICT,
      message: "동점이라 재투표가 필요합니다. 새 선거를 만들어 다시 투표해 주세요.",
    });
  }
}

export class ElectionTieBreakRequiredException extends BadRequestException {
  constructor(message = "동점입니다. 당선자를 한 명 골라 주세요.") {
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}

export function mapElectionIdempotencyError(error: unknown): never {
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
