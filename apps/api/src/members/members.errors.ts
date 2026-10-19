import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class MemberNotFoundException extends NotFoundException {
  constructor() {
    super({
      code: ERROR_CODES.MEMBER_NOT_FOUND,
      message: "해당 반에서 처리할 수 있는 구성원을 찾지 못했습니다.",
    });
  }
}

export class RoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "이 반의 선생님만 이 작업을 할 수 있어요.",
    });
  }
}

export class ClassSuspendedException extends HttpException {
  constructor() {
    super(
      {
        code: ERROR_CODES.CLASS_SUSPENDED,
        message: "일시 중지된 반에서는 구성원을 관리할 수 없습니다.",
      },
      HttpStatus.LOCKED,
    );
  }
}

export class MemberAccountInactiveException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.MEMBER_ACCOUNT_INACTIVE,
      message: "비활성화되거나 삭제된 계정은 승인할 수 없습니다.",
    });
  }
}

export class MemberStatusChangedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.MEMBER_STATUS_CHANGED,
      message: "반 참여 요청 상태가 이미 변경되었습니다. 목록을 새로고침해 주세요.",
    });
  }
}

export class StudentNumberAlreadyInUseException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.STUDENT_NUMBER_ALREADY_IN_USE,
      message: "이미 사용 중인 학생 번호입니다.",
    });
  }
}
