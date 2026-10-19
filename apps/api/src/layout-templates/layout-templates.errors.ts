import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class LayoutTemplateNotFoundException extends NotFoundException {
  constructor(message = "저장된 교실 배치를 찾을 수 없습니다.") {
    super({ code: ERROR_CODES.NOT_FOUND, message });
  }
}

export class LayoutTemplateInvalidException extends BadRequestException {
  constructor(message: string) {
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}

export class LayoutTemplateLimitReachedException extends ConflictException {
  constructor(limit: number) {
    super({
      code: ERROR_CODES.CONFLICT,
      message: `저장할 수 있는 교실 배치는 ${limit}개까지입니다. 쓰지 않는 것을 지우고 다시 저장해 주세요.`,
    });
  }
}
