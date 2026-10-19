import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class AdminInvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_INVALID_CREDENTIALS,
      message: "이메일 또는 비밀번호를 확인해 주세요.",
    });
  }
}

export class AdminAccountLockedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        code: ERROR_CODES.ADMIN_ACCOUNT_LOCKED,
        message: "관리자 로그인 시도가 잠시 제한됐습니다.",
        retry_after_seconds: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class AdminChallengeInvalidException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_CHALLENGE_INVALID,
      message: "인증 단계가 만료됐습니다. 처음부터 다시 로그인해 주세요.",
    });
  }
}

export class AdminMfaInvalidException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_MFA_INVALID,
      message: "인증번호를 확인해 주세요.",
    });
  }
}

export class AdminSessionRequiredException extends UnauthorizedException {
  constructor() {
    super({ code: ERROR_CODES.ADMIN_SESSION_REQUIRED, message: "관리자 로그인이 필요합니다." });
  }
}

export class AdminStepUpRequiredException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_STEP_UP_REQUIRED,
      message: "중요 작업을 계속하려면 비밀번호와 인증번호를 다시 확인해 주세요.",
    });
  }
}

export class AdminRoleInsufficientException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_ROLE_INSUFFICIENT,
      message: "이 관리자 역할로는 요청한 작업을 할 수 없습니다.",
    });
  }
}

export class AdminUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.ADMIN_UNAVAILABLE,
      message: "관리자 인증을 사용할 수 없습니다. 다른 관리자에게 문의해 주세요.",
    });
  }
}
