import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class LocalAdminInvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_ADMIN_INVALID_CREDENTIALS,
      message: "관리자 아이디 또는 비밀번호가 올바르지 않습니다.",
    });
  }
}

export class LocalAdminSessionRequiredException extends UnauthorizedException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_ADMIN_SESSION_REQUIRED,
      message: "로컬 테스트 관리자 로그인이 필요합니다.",
    });
  }
}

export class LocalAdminCsrfInvalidException extends ForbiddenException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_ADMIN_CSRF_INVALID,
      message: "관리자 요청 검증에 실패했습니다.",
    });
  }
}

export class LocalTestAccountNotFoundException extends NotFoundException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_TEST_ACCOUNT_NOT_FOUND,
      message: "삭제 가능한 로컬 테스트 계정을 찾을 수 없습니다.",
    });
  }
}

export class LocalTestAccountHasMembershipException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_TEST_ACCOUNT_HAS_MEMBERSHIP,
      message: "반 멤버십이 있는 테스트 계정은 이 화면에서 삭제할 수 없습니다.",
    });
  }
}

export class LocalTestAccountEmailRequiredException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_TEST_ACCOUNT_EMAIL_REQUIRED,
      message: "로컬 테스트 계정은 @example.com 이메일만 사용할 수 있습니다.",
    });
  }
}

export class LocalTestAccountAlreadyExistsException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.LOCAL_TEST_ACCOUNT_ALREADY_EXISTS,
      message: "이미 사용 중인 테스트 이메일입니다.",
    });
  }
}
