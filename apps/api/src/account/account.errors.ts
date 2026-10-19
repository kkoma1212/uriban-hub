import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InvalidCurrentPasswordException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: "현재 비밀번호가 올바르지 않습니다.",
    });
  }
}

export class InvalidAccountDisplayNameException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "기본 이름은 앞뒤 공백을 제외하고 2~20자의 일반 텍스트여야 합니다.",
    });
  }
}

export class AccountProfileBlockedException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "계정 안내의 필수 단계를 먼저 완료해 주세요.",
    });
  }
}

export class InvalidAccountDeletionConfirmationException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "확인 문구로 '탈퇴'를 정확히 입력해 주세요.",
    });
  }
}

export class AccountDeletionBlockedByClassException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CONFLICT,
      message: "담당 중인 반 운영을 먼저 종료하거나 관리자에게 이관해 주세요.",
    });
  }
}
