import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class LayoutDraftNotFoundException extends NotFoundException {
  constructor(message = "임시저장한 내용이 없습니다.") {
    super({ code: ERROR_CODES.NOT_FOUND, message });
  }
}

export class LayoutDraftRoleInsufficientException extends ForbiddenException {
  constructor(message = "이 반의 선생님만 자리표·모둠표를 만들 수 있어요.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class LayoutDraftClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class LayoutDraftInvalidException extends BadRequestException {
  constructor(message: string) {
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}
