import { buildMessage, ValidateBy, type ValidationOptions } from "class-validator";

const ALLOWED_DISPLAY_NAME = "allowedDisplayName";

/*
 * 학생이 스스로 정하는 이름(가입·기본 이름 변경)에 흔한 욕설이 들어오는 것만 가볍게 막는다.
 * 2026-09-28 공개 시연에서 욕설 이름 가입이 교사 승인을 그대로 통과한 일이 계기다(2026-09-29 사용자 결정).
 * 완전한 차단이 아니다 — 교사의 거절·반 표시 이름 변경이 최종 수단이다. 실제 이름이 막히지 않도록
 * 이름에 거의 나오지 않는 말만 넣는다(예: '시바'는 견종 이름이라 제외).
 * 화면(apps/web/src/lib/display-name-policy.ts)에 같은 목록이 있으며 display-name-policy.spec.ts가 일치를 확인한다.
 */
// 이름 어디에 끼어 있어도 막는 한국어 욕설.
export const BLOCKED_DISPLAY_NAME_WORDS = [
  "시발",
  "씨발",
  "씨빨",
  "씨팔",
  "시팔",
  "ㅅㅂ",
  "ㅆㅂ",
  "병신",
  "븅신",
  "ㅂㅅ",
  "좆",
  "존나",
  "ㅈㄴ",
  "개새",
  "새끼",
  "ㅅㄲ",
  "지랄",
  "ㅈㄹ",
  "니애미",
  "느금",
  "엠창",
  "섹스",
  "보지",
  "자지",
  "창녀",
] as const;
// 실제 이름 속에 섞일 수 있는 영어 욕설(Harshit·Pornchai, 2026-09-29 Codex 검증 R3)은 단어 전체가
// 같을 때만 막는다(사용자 결정). 이름 전체가 그 말인 경우("F U C K")도 막는다. 가벼운 속어 "졸라"는
// 실제 이름(에밀 졸라)과 단어 단위로도 구별되지 않아 목록에서 뺐다.
export const BLOCKED_DISPLAY_NAME_WHOLE_WORDS = ["fuck", "shit", "bitch", "porn"] as const;

// 띄어쓰기·숫자·기호를 끼워 넣는 흔한 우회("시 발", "시1발")를 잡기 위해 글자만 남긴다.
function lettersOnly(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
}

// NFKC는 자음 줄임말(ㅅㅂ)을 다른 코드로 바꾸므로 목록도 같은 방식으로 맞춰 비교한다.
const blockedLetters = BLOCKED_DISPLAY_NAME_WORDS.map(lettersOnly);
const blockedWholeWords = BLOCKED_DISPLAY_NAME_WHOLE_WORDS.map(lettersOnly);

export function containsBlockedDisplayNameWord(value: string): boolean {
  const letters = lettersOnly(value);
  if (blockedLetters.some((word) => letters.includes(word))) return true;
  const words = value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}]+/u);
  return blockedWholeWords.some((word) => letters === word || words.includes(word));
}

export function IsAllowedDisplayName(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: ALLOWED_DISPLAY_NAME,
      validator: {
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property contains a word that cannot be used in a name`,
          validationOptions,
        ),
        validate: (value: unknown) =>
          typeof value === "string" && !containsBlockedDisplayNameWord(value),
      },
    },
    validationOptions,
  );
}
