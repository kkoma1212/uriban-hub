import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class MealNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "현재 참여 중인 반을 찾지 못했습니다." });
  }
}

export class MealRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "현재 계정 상태에서는 급식을 조회할 수 없습니다.",
    });
  }
}

export class MealClassSuspendedException extends HttpException {
  constructor() {
    super(
      {
        code: ERROR_CODES.CLASS_SUSPENDED,
        message: "일시 중지된 반에서는 급식을 조회할 수 없습니다.",
      },
      HttpStatus.LOCKED,
    );
  }
}
