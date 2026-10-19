import { BadRequestException, ConflictException, HttpException, HttpStatus } from "@nestjs/common";

import { ERROR_CODES } from "../errors/error-codes.js";

const STRONG_ETAG_PATTERN = /^"([1-9][0-9]*)"$/u;

export function parseRequiredIfMatch(value: string | string[] | undefined): string {
  if (value === undefined) {
    throw new HttpException(
      {
        code: ERROR_CODES.IF_MATCH_REQUIRED,
        message: "If-Match 헤더가 필요합니다.",
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }

  if (Array.isArray(value)) {
    throw new BadRequestException({
      code: ERROR_CODES.INVALID_IF_MATCH,
      message: 'If-Match는 따옴표로 감싼 단일 버전이어야 합니다. 예: "1"',
    });
  }

  const match = STRONG_ETAG_PATTERN.exec(value);
  if (match === null) {
    throw new BadRequestException({
      code: ERROR_CODES.INVALID_IF_MATCH,
      message: 'If-Match는 따옴표로 감싼 단일 버전이어야 합니다. 예: "1"',
    });
  }

  return match[1]!;
}

export class ResourceVersionChangedException extends ConflictException {
  constructor(currentRowVersion: string) {
    super({
      code: ERROR_CODES.RESOURCE_VERSION_CHANGED,
      details: { current_row_version: currentRowVersion },
      message: "다른 요청에서 먼저 변경되었습니다. 최신 정보를 다시 확인해 주세요.",
    });
  }
}
