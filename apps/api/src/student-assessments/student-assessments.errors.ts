import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
} from "@classhub/db";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class StudentAssessmentNotFoundException extends NotFoundException {
  constructor() {
    super({
      code: ERROR_CODES.NOT_FOUND,
      message: "평가 기록을 찾을 수 없어요.",
    });
  }
}

export class StudentAssessmentRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "나의 평가 기록은 승인된 학생 본인만 사용할 수 있어요.",
    });
  }
}

export class StudentAssessmentIncompleteException extends BadRequestException {
  constructor(message: string) {
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}

export function mapStudentAssessmentIdempotencyError(error: unknown): never {
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
