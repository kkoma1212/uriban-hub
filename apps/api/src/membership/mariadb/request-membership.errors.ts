import { types } from "node:util";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { UnauthenticatedException } from "../../auth/auth.errors.js";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  CurrentMembershipExistsException,
  EmailNotVerifiedException,
  InvalidInviteCodeException,
  MembershipRequestNotAllowedException,
  RejoinNotAllowedException,
} from "../membership.errors.js";

const signals = new Map<number, () => HttpException>([
  [30002, () => new InvalidInviteCodeException()],
  [30201, () => new InvalidInviteCodeException()],
  [30202, () => new UnauthenticatedException()],
  [30203, () => new CurrentMembershipExistsException()],
  [30204, () => new MembershipRequestNotAllowedException()],
  [30205, () => new InvalidInviteCodeException()],
  [30206, () => new MembershipRequestNotAllowedException()],
  [30216, () => new RejoinNotAllowedException()],
  [30217, () => new EmailNotVerifiedException()],
]);

export function invalidMembershipRequestInput(): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "반 참여 요청 정보를 확인해 주세요.",
  });
}

export function membershipRequestInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "반 참여 요청 결과를 확인할 수 없습니다. 현재 참여 상태를 확인해 주세요.",
  });
}

/** Only the request_class_membership contract; never parse native messages or causes. */
export function mapMariaDbMembershipRequestError(error: unknown): HttpException {
  try {
    if (types.isProxy(error)) return membershipRequestInternalError();
    if (typeof error === "object" && error !== null) {
      const state: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
      const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
      if (state === "45000" && typeof errno === "number") {
        const mapped = signals.get(errno);
        if (mapped) return mapped();
      }
    }
  } catch {
    /* Unknown or hostile error objects must not expose SQL, arguments or credentials. */
  }
  return membershipRequestInternalError();
}
