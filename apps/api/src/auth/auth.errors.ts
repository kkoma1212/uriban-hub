import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import type { NewPasswordRejectionReason } from "./password-input-policy.js";

export class InvalidConsentsException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "필수 동의를 확인해 주세요.",
    });
  }
}

export class SignupApprovalInvalidException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.SIGNUP_APPROVAL_INVALID,
      message: "가입 승인번호를 확인할 수 없습니다. 관리자에게 새 번호를 요청해 주세요.",
    });
  }
}

export class NewPasswordRejectedException extends BadRequestException {
  constructor(reason: NewPasswordRejectionReason, minimumCodePoints: number = 6) {
    const message =
      reason === "blocked"
        ? "너무 흔하거나 유출된 비밀번호예요. 다른 비밀번호를 선택해 주세요."
        : reason === "length"
          ? `비밀번호는 NFC 정규화 뒤 ${minimumCodePoints}자 이상 입력해 주세요.`
          : reason === "composition"
            ? "비밀번호에 문자와 숫자를 모두 넣어 주세요."
            : "비밀번호에는 제어문자·보이지 않는 문자·줄바꿈을 사용할 수 없어요.";
    super({ code: ERROR_CODES.VALIDATION_FAILED, message });
  }
}

export class InvalidGuardianConsentException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "보호자 동의 정보를 확인해 주세요.",
    });
  }
}

export class EmailAlreadyRegisteredException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      message: "이미 가입된 이메일입니다.",
    });
  }
}

export class EmailAlreadyVerifiedException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.EMAIL_ALREADY_VERIFIED,
      message: "이미 인증된 이메일입니다.",
    });
  }
}

export class EmailNotVerifiedException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.EMAIL_NOT_VERIFIED,
      message: "이메일 확인을 먼저 완료해 주세요.",
    });
  }
}

export class TokenInvalidOrExpiredException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.TOKEN_INVALID_OR_EXPIRED,
      message: "인증 링크가 만료되었거나 이미 사용되었습니다.",
    });
  }
}

export class PasswordResetTokenInvalidOrExpiredException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.TOKEN_INVALID_OR_EXPIRED,
      message: "비밀번호 재설정 링크가 만료되었거나 이미 사용되었습니다.",
    });
  }
}

export class OriginNotAllowedException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.ORIGIN_NOT_ALLOWED,
      message: "허용되지 않은 요청 출처입니다.",
    });
  }
}

export class AccountUnavailableException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.ACCOUNT_UNAVAILABLE,
      message: "계정을 사용할 수 없습니다.",
    });
  }
}

export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: "이메일 또는 비밀번호가 올바르지 않습니다.",
    });
  }
}

export class UnauthenticatedException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.UNAUTHENTICATED,
      message: "로그인이 필요합니다.",
    });
  }
}

export class SessionServiceUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.SESSION_SERVICE_UNAVAILABLE,
      message: "로그인 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    });
  }
}

export class CsrfInvalidException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.CSRF_INVALID,
      message: "요청 보안 정보를 확인할 수 없습니다.",
    });
  }
}

export class AccountLockedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        code: ERROR_CODES.ACCOUNT_LOCKED,
        message: "로그인 시도가 잠시 제한되었습니다.",
        retry_after_seconds: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
