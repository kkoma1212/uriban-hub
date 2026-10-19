import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class AttendanceNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "현재 반을 찾을 수 없습니다." });
  }
}

export class AttendanceRoleInsufficientException extends ForbiddenException {
  constructor(message = "출결 연락을 조회할 권한이 없습니다.") {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message });
  }
}

export class AttendanceClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class InvalidAttendanceCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "목록 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}
