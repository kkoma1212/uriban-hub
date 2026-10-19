import { types } from "node:util";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
  MariaDbIdempotencyError,
} from "@classhub/db";
import { BadRequestException, HttpException, InternalServerErrorException } from "@nestjs/common";
import { EmailNotVerifiedException, UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  ClassAlreadyExistsException,
  ClassCreationNotAllowedException,
  ClassRoleInsufficientException,
  GradeNotAllowedException,
  InviteCodeGenerationFailedException,
  mapIdempotencyError,
  SchoolKindNotSupportedException,
  SchoolNotFoundException,
} from "../classes.errors.js";

const signals = new Map<number, () => HttpException>([
  [30102, () => new UnauthenticatedException()],
  [30103, () => new ClassCreationNotAllowedException()],
  [30104, () => new ClassRoleInsufficientException()],
  [30105, () => new SchoolNotFoundException()],
  [30106, () => new SchoolKindNotSupportedException()],
  [30107, () => new ClassAlreadyExistsException()],
  [30108, () => new InviteCodeGenerationFailedException()],
  [30124, () => new EmailNotVerifiedException()],
  [30125, () => new GradeNotAllowedException()],
]);

export function invalidCreateClassInput(): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "반 생성 요청 정보를 확인해 주세요.",
  });
}

export function createClassInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "반 생성 처리 결과를 확인할 수 없습니다. 같은 요청으로 처리 결과를 확인해 주세요.",
  });
}

/** Only for create_class_with_teacher_and_invite. Never parse driver messages or causes. */
export function mapMariaDbCreateClassError(error: unknown): HttpException {
  try {
    if (types.isProxy(error)) return createClassInternalError();
    if (
      error instanceof IdempotencyKeyRequiredError ||
      error instanceof InvalidIdempotencyKeyError ||
      error instanceof IdempotencyKeyReusedError
    ) {
      try {
        mapIdempotencyError(error);
      } catch (mapped) {
        return mapped as HttpException;
      }
    }
    if (error instanceof MariaDbIdempotencyError && error.code === "invalid_request")
      return invalidCreateClassInput();
    if (typeof error === "object" && error !== null) {
      const state: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
      const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
      if (state === "45000" && typeof errno === "number") {
        const mapped = signals.get(errno);
        if (mapped) return mapped();
      }
    }
  } catch {
    /* Unknown/accessor/proxy failures never carry private details to HTTP. */
  }
  return createClassInternalError();
}
