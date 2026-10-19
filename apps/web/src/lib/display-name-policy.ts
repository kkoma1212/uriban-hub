/*
 * 학생이 스스로 정하는 이름에 흔한 욕설이 들어오는 것을 미리 알려 준다. 최종 판정은 서버
 * (apps/api/src/common/validation/display-name-policy.ts)가 하며, 두 목록은 API 검사가 일치를 확인한다.
 */
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
// 실제 이름 속에 섞일 수 있는 말은 단어 전체가 같을 때만 막는다(서버와 같은 규칙).
export const BLOCKED_DISPLAY_NAME_WHOLE_WORDS = ["fuck", "shit", "bitch", "porn"] as const;

export const BLOCKED_DISPLAY_NAME_MESSAGE =
  "이름에 쓸 수 없는 말이 들어 있어요. 다른 이름을 써 주세요.";

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
