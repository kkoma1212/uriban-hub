import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InvalidProfilePhotoException extends BadRequestException {
  constructor() {
    super({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "사진을 읽을 수 없습니다. 크기를 줄인 JPG·PNG·WebP 사진을 선택해 주세요.",
    });
  }
}
export class ProfilePhotoNotFoundException extends NotFoundException {
  constructor() {
    super({ code: ERROR_CODES.NOT_FOUND, message: "프로필 사진을 볼 수 없습니다." });
  }
}
export class ProfilePhotoBusyException extends ServiceUnavailableException {
  constructor() {
    super({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: "사진을 처리하고 있습니다. 잠시 뒤 다시 시도해 주세요.",
    });
  }
}
