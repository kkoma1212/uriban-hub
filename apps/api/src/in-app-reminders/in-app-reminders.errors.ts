import { ConflictException, HttpException, HttpStatus } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";

export class InAppReminderContentRevisionChangedException extends ConflictException {
  constructor(currentRevision: string) {
    super({
      code: ERROR_CODES.CONTENT_REVISION_CHANGED,
      details: { current_revision: currentRevision },
      message: "내용이 변경되었습니다. 최신 내용을 확인한 뒤 다시 재알림을 요청해 주세요.",
    });
  }
}

export class InAppReminderNoUnresolvedRecipientsException extends ConflictException {
  constructor() {
    super({
      code: ERROR_CODES.REMINDER_NO_UNRESOLVED_RECIPIENTS,
      message: "현재 재알림을 받을 미확인 학생이 없습니다.",
    });
  }
}

export class InAppReminderCooldownException extends HttpException {
  constructor(nextAvailableAt: string, retryAfterSeconds: number) {
    super(
      {
        code: ERROR_CODES.REMINDER_COOLDOWN_ACTIVE,
        details: { next_available_at: nextAvailableAt },
        message: "모든 미확인 학생이 재알림 대기 시간 안에 있습니다.",
        retry_after_seconds: retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
