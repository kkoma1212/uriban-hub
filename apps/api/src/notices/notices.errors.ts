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

export class NoticeNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "공지사항을 찾을 수 없습니다." });
  }
}

export class NoticeRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 작업을 수행할 권한이 없습니다.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class NoticeClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class InvalidNoticeCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "목록 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}

export class NoticeContentRevisionChangedException extends ConflictException {
  constructor(currentRevision: string) {
    super({
      code: ERROR_CODES.CONTENT_REVISION_CHANGED,
      details: { current_revision: currentRevision },
      message: "공지 내용이 수정되었습니다. 최신 내용을 다시 확인해 주세요.",
    });
  }
}

export function mapNoticeIdempotencyError(error: unknown): never {
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
