import { types } from "node:util";
import {
  BadRequestException,
  type HttpException,
  InternalServerErrorException,
} from "@nestjs/common";
import { ERROR_CODES } from "../../common/errors/error-codes.js";
import {
  ClassSuspendedException,
  MemberAccountInactiveException,
  MemberNotFoundException,
  MemberStatusChangedException,
  RoleInsufficientException,
} from "../members.errors.js";

export type MemberManagementOperation = "approve" | "reject" | "remove" | "rejoin";
const contracts = {
  approve: {
    missing: [30002, 30301, 30302, 30326],
    role: [30303, 30304, 30305],
    changed: [30306, 30327],
    suspended: 30328,
  },
  reject: {
    missing: [30002, 30307, 30308, 30329, 30330],
    role: [30309, 30310, 30311],
    changed: [30312, 30331],
    suspended: 30332,
  },
  remove: {
    missing: [30002, 30313, 30314, 30333, 30334],
    role: [30315, 30316, 30317],
    changed: [30318, 30335],
    suspended: 30336,
  },
  rejoin: {
    missing: [30002, 30319, 30320, 30337, 30338],
    role: [30321, 30322, 30323],
    changed: [30324, 30339],
    suspended: 30340,
  },
};

export function invalidMemberManagementInput(): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_FAILED,
    message: "구성원 변경 요청 정보를 확인해 주세요.",
  });
}

export function memberManagementInternalError(): InternalServerErrorException {
  return new InternalServerErrorException({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: "구성원 변경 결과를 확인할 수 없습니다. 현재 구성원 상태를 확인해 주세요.",
  });
}

/** mysql2 does not supply structured constraint names. Never infer a 1062 from its message. */
export function mapMariaDbMemberManagementError(
  error: unknown,
  operation: MemberManagementOperation,
): HttpException {
  if (typeof error !== "object" || error === null || types.isProxy(error))
    return memberManagementInternalError();
  const state: unknown = Object.getOwnPropertyDescriptor(error, "sqlState")?.value;
  const errno: unknown = Object.getOwnPropertyDescriptor(error, "errno")?.value;
  if (state === "45000" && typeof errno === "number") {
    const contract = contracts[operation];
    if (operation === "approve" && errno === 30325) return new MemberAccountInactiveException();
    if (contract.missing.includes(errno)) return new MemberNotFoundException();
    if (contract.role.includes(errno)) return new RoleInsufficientException();
    if (contract.changed.includes(errno)) return new MemberStatusChangedException();
    if (contract.suspended === errno) return new ClassSuspendedException();
  }
  return memberManagementInternalError();
}
