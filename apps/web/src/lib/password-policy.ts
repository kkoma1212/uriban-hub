import { z } from "zod";

import { codePointLength } from "./text";

export const NEW_PASSWORD_MIN_CODE_POINTS = 6;

const FORBIDDEN_PASSWORD_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function normalizeNewPassword(value: string): string {
  return value.normalize("NFC");
}

// 가입·비밀번호 변경·재설정 화면이 함께 쓰므로 문구에 "새"를 넣지 않는다(총검수 B3-10).
export const newPasswordSchema = z
  .string()
  .transform(normalizeNewPassword)
  .refine(
    (value) => codePointLength(value) >= NEW_PASSWORD_MIN_CODE_POINTS,
    "비밀번호는 6자 이상이어야 해요.",
  )
  .refine(
    (value) => !FORBIDDEN_PASSWORD_CHARACTER.test(value),
    "제어문자·보이지 않는 문자·줄바꿈은 사용할 수 없어요.",
  )
  .refine(
    (value) => /\p{L}/u.test(value) && /\p{N}/u.test(value),
    "비밀번호에 문자와 숫자를 모두 넣어 주세요.",
  );

export const passwordConfirmationSchema = z
  .string()
  .transform(normalizeNewPassword)
  .refine((value) => value.length > 0, "비밀번호를 한 번 더 입력해 주세요.");
