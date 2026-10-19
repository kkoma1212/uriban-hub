import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class HomeNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "현재 참여 중인 반을 찾지 못했습니다." });
  }
}

export class HomeClassSuspendedException extends HttpException {
  constructor() {
    super(
      {
        code: ERROR_CODES.CLASS_SUSPENDED,
        message: "일시 중지된 반에서는 홈을 이용할 수 없습니다.",
      },
      HttpStatus.LOCKED,
    );
  }
}

export class HomeRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "현재 계정 상태에서는 반 홈을 이용할 수 없습니다.",
    });
  }
}

export class HomeUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.HOME_UNAVAILABLE,
      message: "반 홈을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
  }
}
