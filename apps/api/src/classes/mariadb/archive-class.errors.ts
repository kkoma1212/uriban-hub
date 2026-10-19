import { types } from "node:util";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  ClassArchiveConflictException,
  ClassNameConfirmationMismatchException,
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
} from "../classes.errors.js";

export function invalidArchiveClassInput(): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "반 운영 종료 요청 정보를 확인해 주세요.",
  });
}
export function archiveClassInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "반 운영 종료 결과를 확인할 수 없습니다. 현재 반 상태를 확인해 주세요.",
  });
}

/** Exact archive_class SIGNAL contract. Native diagnostics and SQL text are never public. */
export function mapMariaDbArchiveClassError(error: unknown): HttpException {
  if (typeof error !== "object" || error === null || types.isProxy(error))
    return archiveClassInternalError();
  const state: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
  const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
  if (state === "45000" && typeof errno === "number") {
    if (errno === 30002) return new CurrentClassNotFoundException();
    if ([30109, 30114, 30115, 30116].includes(errno)) return new ClassArchiveConflictException();
    if (errno === 30110) return new ClassNameConfirmationMismatchException();
    if (errno === 30111) return new UnauthenticatedException();
    if (errno === 30112 || errno === 30113) return new ClassRoleInsufficientException();
    if (errno === 30126) return new CurrentClassSuspendedException();
  }
  return archiveClassInternalError();
}
