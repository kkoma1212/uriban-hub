import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class AuditLogsNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "현재 참여 중인 반을 찾을 수 없습니다." });
  }
}

export class AuditLogsRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ROLE_INSUFFICIENT,
      message: "이 반의 선생님만 반 관리 기록을 볼 수 있어요.",
    });
  }
}

export class AuditLogsClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class InvalidAuditLogCursorException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CURSOR,
      message: "감사 로그 커서를 해석할 수 없습니다. 처음부터 다시 조회해 주세요.",
    });
  }
}

export class AuditLogDataInvalidException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "감사 로그를 안전하게 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    });
  }
}
