import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class ClassChatNotFoundException extends NotFoundException {
  constructor(message = "반 대화나 메시지를 찾을 수 없어요.") {
    super({ code: ERROR_CODES.NOT_FOUND, message });
  }
}

export class ClassChatRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 반의 선생님만 할 수 있어요.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

/** 방이 닫혔거나 밤 시간이거나 말하기 제한 중일 때. */
export class ClassChatSendBlockedException extends ForbiddenException {
  constructor(message: string) {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class ClassChatConflictException extends ConflictException {
  constructor(message: string) {
    super({ code: ERROR_CODES.CONFLICT, message });
  }
}

export class ClassChatRateLimitedException extends HttpException {
  constructor(message: string) {
    super({ code: ERROR_CODES.RATE_LIMITED, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class ClassChatClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}
