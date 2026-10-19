import { types } from "node:util";
import type { DatabaseErrorClassifier } from "@classhub/db";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import { MembershipStatusChangedException } from "../membership.errors.js";

export type OwnMembershipOperation = "cancel" | "leave";

function metadata(error: unknown): { errno: unknown; state: unknown } | undefined {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return undefined;
  return {
    errno: Object.getOwnPropertyDescriptor(error, "errno")?.value,
    state: Object.getOwnPropertyDescriptor(error, "sqlState")?.value,
  };
}

export function invalidOwnMembershipInput(): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "반 참여 변경 요청 정보를 확인해 주세요.",
  });
}

export function ownMembershipInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "반 참여 변경 결과를 확인할 수 없습니다. 현재 참여 상태를 확인해 주세요.",
  });
}

/** Do not retry application SIGNALs, lock timeouts or uncertain COMMIT acknowledgements. */
export const ownMembershipRetryClassifier: DatabaseErrorClassifier = {
  classify(error) {
    const native = metadata(error);
    return native?.errno === 1213 && native.state === "40001"
      ? { kind: "deadlock", vendorCode: "1213" }
      : { kind: "unknown" };
  },
};

/** Exact, operation-specific SIGNAL contract; never inspect SQL text, messages or causes. */
export function mapMariaDbOwnMembershipError(
  error: unknown,
  operation: OwnMembershipOperation,
): HttpException {
  const native = metadata(error);
  if (native?.state === "45000") {
    if (native.errno === (operation === "cancel" ? 30209 : 30213))
      return new UnauthenticatedException();
    const conflicts =
      operation === "cancel" ? [30002, 30208, 30210, 30211] : [30002, 30212, 30214, 30215];
    if (typeof native.errno === "number" && conflicts.includes(native.errno))
      return new MembershipStatusChangedException();
  }
  return ownMembershipInternalError();
}
