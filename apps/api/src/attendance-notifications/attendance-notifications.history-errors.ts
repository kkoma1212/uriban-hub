import { BadRequestException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InvalidAttendanceHistoryRangeException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "출결 조회 기간은 오늘까지 최대 366일이어야 합니다.",
    });
  }
}
