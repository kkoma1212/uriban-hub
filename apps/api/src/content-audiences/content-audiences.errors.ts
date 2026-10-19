import { BadRequestException, ConflictException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InvalidContentAudienceException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "게시 대상을 확인할 수 없습니다. 현재 반의 활성 승인 학생만 선택해 주세요.",
    });
  }
}

export class SelectedContentAudienceDisabledException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CONTENT_SELECTED_AUDIENCE_DISABLED,
      message: "지정 학생 게시 기능이 아직 활성화되지 않았습니다.",
    });
  }
}
