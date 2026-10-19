import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from "@nestjs/common";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
  matchesDatabaseConstraint,
} from "@classhub/db";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export function isClassIdentityViolation(error: unknown): boolean {
  return matchesDatabaseConstraint(error, {
    kind: "unique_violation",
    objectName: "classes_active_identity_unique",
  });
}

export class CurrentClassNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "현재 참여 중인 반을 찾을 수 없습니다." });
  }
}

export class ClassRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({ code: ERROR_CODES.ROLE_INSUFFICIENT, message: "이 반의 선생님만 사용할 수 있어요." });
  }
}

export class CurrentClassSuspendedException extends HttpException {
  constructor() {
    super(
      { code: ERROR_CODES.CLASS_SUSPENDED, message: "현재 반은 일시 중지 상태입니다." },
      HttpStatus.LOCKED,
    );
  }
}

export class CurrentInviteCodeNotFoundException extends NotFoundException {
  constructor() {
    super({
      code: ERROR_CODES.INVITE_CODE_NOT_FOUND,
      message: "현재 반 초대 코드를 찾을 수 없습니다.",
    });
  }
}

export class InviteCodeGenerationFailedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.INVITE_CODE_GENERATION_FAILED,
      message: "새 반 초대 코드를 만들지 못했습니다. 다시 시도해 주세요.",
    });
  }
}

export class SchoolNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.SCHOOL_NOT_FOUND, message: "선택한 학교를 찾을 수 없습니다." });
  }
}

export class GradeNotAllowedException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.GRADE_NOT_ALLOWED,
      message: "선택한 학교급에서 사용할 수 없는 학년입니다.",
    });
  }
}

/*
 * 만 14세 미만은 법정대리인 동의와 그 확인이 필요한데(개인정보 보호법 제22조의2)
 * 그 절차가 구현돼 있지 않다. 초등 학급을 열어두면 학생이 나이 확인란에 거짓으로
 * 체크해야만 가입할 수 있게 되고, 그건 동의 요건을 우회하도록 유도하는 셈이 된다.
 * 그래서 학급 생성 단계에서 막는다 — 학급이 없으면 초대 코드도 없고 학생도 못 들어온다.
 * (2026-08-05 사용자 결정: 중·고만 받는다. 감사 P1-06의 선택지 A.)
 */
export class SchoolKindNotSupportedException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.SCHOOL_KIND_NOT_SUPPORTED,
      message: "지금은 중학교와 고등학교만 이용할 수 있습니다.",
    });
  }
}

export class ClassAlreadyExistsException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CLASS_ALREADY_EXISTS,
      message: "같은 학교·학년도·학년·반 이름의 운영 중인 반이 이미 있습니다.",
    });
  }
}

export class ClassArchiveConflictException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CLASS_ARCHIVE_CONFLICT,
      message: "반 상태가 변경되어 운영을 종료할 수 없습니다. 최신 상태를 확인해 주세요.",
    });
  }
}

export class ClassNameConfirmationMismatchException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CLASS_NAME_CONFIRMATION_MISMATCH,
      message: "현재 반 이름을 정확히 입력해 주세요.",
    });
  }
}

export class ClassCreationNotAllowedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CLASS_CREATION_NOT_ALLOWED,
      message: "현재 계정 상태에서는 새 반을 만들 수 없습니다.",
    });
  }
}

export function mapIdempotencyError(error: unknown): never {
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
