import { BadRequestException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InvalidUpdatesCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "통합 알림 목록 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}

export class StudentUpdatesFilterRequiredException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "안 한 것 필터는 학생만 사용할 수 있습니다.",
    });
  }
}
