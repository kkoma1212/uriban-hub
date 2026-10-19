import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
} from "@classhub/db";
import { BadRequestException, ConflictException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

const SERVER_TODAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_BY_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isCalendarDate(value: string): boolean {
  const match = SERVER_TODAY_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_BY_MONTH[month - 1];
  return maxDay !== undefined && day >= 1 && day <= maxDay;
}

export function parseRequiredServerToday(value: string | string[] | undefined): string {
  if (value === undefined) {
    throw new BadRequestException({
      code: ERROR_CODES.SERVER_TODAY_REQUIRED,
      message: "X-Server-Today 헤더가 필요합니다. 오늘 출결 화면을 다시 불러와 주세요.",
    });
  }

  if (Array.isArray(value) || !isCalendarDate(value)) {
    throw new BadRequestException({
      code: ERROR_CODES.INVALID_SERVER_TODAY,
      message:
        "X-Server-Today 헤더가 올바른 날짜 형식이 아닙니다. 오늘 출결 화면을 다시 불러와 주세요.",
    });
  }

  return value;
}

export class AttendanceNotificationDateChangedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.ATTENDANCE_NOTIFICATION_DATE_CHANGED,
      message: "기준 날짜가 바뀌었습니다. 오늘 출결 화면을 다시 불러와 주세요.",
    });
  }
}

export class AttendanceNotificationAlreadyAcknowledgedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.ATTENDANCE_NOTIFICATION_ALREADY_ACKNOWLEDGED,
      message: "이미 선생님이 확인한 출결 연락입니다.",
    });
  }
}

export class AttendanceNotificationStateConflictException extends ConflictException {
  constructor(message: string) {
    super({ code: ERROR_CODES.CONFLICT, message });
  }
}

export function mapAttendanceIdempotencyError(error: unknown): never {
  if (error instanceof IdempotencyKeyRequiredError) {
    throw new BadRequestException({
      code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      message: "Idempotency-Key 헤더가 필요합니다.",
    });
  }
  if (error instanceof InvalidIdempotencyKeyError) {
    throw new BadRequestException({
      code: ERROR_CODES.INVALID_IDEMPOTENCY_KEY,
      message: "Idempotency-Key는 UUID 형식이어야 합니다.",
    });
  }
  if (error instanceof IdempotencyKeyReusedError) {
    throw new ConflictException({
      code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      message: "같은 Idempotency-Key가 다른 요청에 이미 사용되었습니다.",
    });
  }
  throw error;
}
