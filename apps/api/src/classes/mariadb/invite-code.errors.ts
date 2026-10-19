import { types } from "node:util";
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidIdempotencyKeyError,
  MariaDbIdempotencyError,
} from "@classhub/db";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  ClassRoleInsufficientException,
  CurrentClassNotFoundException,
  CurrentClassSuspendedException,
  CurrentInviteCodeNotFoundException,
  InviteCodeGenerationFailedException,
  mapIdempotencyError,
} from "../classes.errors.js";

export const inviteCodeInternalError = () =>
  new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "초대 코드 처리 결과를 확인할 수 없습니다. 같은 요청으로 처리 결과를 확인해 주세요.",
  });
export const invalidInviteCodeInput = () =>
  new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "초대 코드 요청 정보를 확인해 주세요.",
  });
const signals = new Map<number, () => HttpException>([
  [30117, () => new CurrentClassNotFoundException()],
  [30118, () => new UnauthenticatedException()],
  [30119, () => new ClassRoleInsufficientException()],
  [30120, () => new ClassRoleInsufficientException()],
  [30121, () => new CurrentInviteCodeNotFoundException()],
  [30123, () => new InviteCodeGenerationFailedException()],
  [30127, () => new CurrentClassSuspendedException()],
]);

/** Only call at the rotate_class_invite CALL boundary. Leave native 1213 intact for whole-transaction retry. */
export function mapInviteRotationSignal(error: unknown): HttpException | undefined {
  try {
    if (types.isProxy(error) || typeof error !== "object" || error === null) return undefined;
    const state: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
    const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
    return state === "45000" && typeof errno === "number" ? signals.get(errno)?.() : undefined;
  } catch {
    return undefined;
  }
}

export function mapInviteCodeBoundaryError(error: unknown): HttpException {
  try {
    if (types.isProxy(error)) return inviteCodeInternalError();
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
      return invalidInviteCodeInput();
  } catch {
    /* Unknown/accessor failures never escape with private values. */
  }
  return inviteCodeInternalError();
}
