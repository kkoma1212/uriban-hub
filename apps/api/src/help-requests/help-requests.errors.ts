import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class HelpRequestNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "도움 요청이나 안내를 찾을 수 없어요." });
  }
}

export class HelpRequestRoleInsufficientException extends ForbiddenException {
  constructor(message: string) {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

/** 같은 안내에 처리 중인 요청이 이미 있거나, 이미 처리·철회된 요청을 다시 닫으려 할 때. */
export class HelpRequestStateConflictException extends ConflictException {
  constructor(message: string) {
    super({ code: ERROR_CODES.CONFLICT, message });
  }
}

/** 학생이 짧은 시간에 너무 많이 보낼 때. 선생님께 알림이 쏟아지지 않게 막는다. */
export class HelpRequestRateLimitedException extends HttpException {
  constructor(message: string) {
    super({ code: ERROR_CODES.RATE_LIMITED, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class HelpRequestClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}
