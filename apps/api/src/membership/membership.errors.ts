import { BadRequestException, ConflictException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export { EmailNotVerifiedException } from "../auth/auth.errors.js";

export class InvalidInviteCodeException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.INVITE_CODE_INVALID_OR_EXPIRED,
      message: "반 초대 코드가 올바르지 않거나 만료되었습니다.",
    });
  }
}

export class CurrentMembershipExistsException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.CURRENT_MEMBERSHIP_EXISTS,
      message: "이미 처리 중이거나 참여 중인 반이 있습니다.",
    });
  }
}

export class MembershipRequestNotAllowedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.MEMBERSHIP_REQUEST_NOT_ALLOWED,
      message: "현재 계정 상태에서는 반 참여 요청을 보낼 수 없습니다.",
    });
  }
}

export class RejoinNotAllowedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.REJOIN_NOT_ALLOWED,
      message: "담임 선생님이 다시 참여를 허용한 뒤 요청할 수 있습니다.",
    });
  }
}

export class MembershipStatusChangedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.MEMBERSHIP_STATUS_CHANGED,
      message: "멤버십 상태가 변경되었습니다. 새로고침 후 다시 확인해 주세요.",
    });
  }
}
