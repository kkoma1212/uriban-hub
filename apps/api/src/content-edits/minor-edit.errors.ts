import { BadRequestException } from "@nestjs/common";

import { ERROR_CODES } from "../common/errors/error-codes.js";
import { MINOR_EDIT_MAX_CHANGED_CHARACTERS } from "./minor-edit.js";

const TURN_OFF_HINT = "'오타만 고쳤어요'를 끄고 저장하면 학생들이 다시 확인해요.";

export class MinorEditNotAllowedException extends BadRequestException {
  /** reason: 'text' = 글자가 많이 바뀌었거나 숫자가 바뀜, 'schedule' = 준비물·숙제의 날짜·종류가 바뀜 */
  constructor(reason: "schedule" | "text") {
    super({
      code: ERROR_CODES.MINOR_EDIT_NOT_ALLOWED,
      message:
        reason === "schedule"
          ? `날짜나 종류를 바꾸면 학생들이 다시 확인해야 해서 오타 수정으로 저장할 수 없어요. ${TURN_OFF_HINT}`
          : `바뀐 글자가 ${MINOR_EDIT_MAX_CHANGED_CHARACTERS}자를 넘거나 숫자(날짜·시간·개수)가 바뀌어 오타 수정으로 저장할 수 없어요. ${TURN_OFF_HINT}`,
    });
  }
}
