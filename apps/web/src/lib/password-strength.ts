import { newPasswordSchema, normalizeNewPassword } from "./password-policy";
import { codePointLength } from "./text";

export type PasswordStrength = "safe" | "moderate" | "weak";

export const PASSWORD_STRENGTH_GUIDE =
  "문자와 숫자를 포함해 6자 이상 입력해 주세요. 길이 상한은 없어요. 단순·반복 패턴은 위험으로 표시해요. " +
  "등급은 입력 조합을 비교하는 참고용이며 보안을 보증하지 않아요. 공백·기호도 사용할 수 있어요.";

const sequenceSources = [
  "0123456789",
  "9876543210",
  "abcdefghijklmnopqrstuvwxyz",
  "zyxwvutsrqponmlkjihgfedcba",
  "qwertyuiopasdfghjklzxcvbnm",
];

function isSimplePattern(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const characters = Array.from(compact || value);
  if (new Set(characters).size <= 2) return true;
  // Prefix lengths find a repeating pattern in linear time even for long passphrases.
  const prefixes = new Array<number>(characters.length).fill(0);
  for (let index = 1; index < characters.length; index += 1) {
    let matched = prefixes[index - 1]!;
    while (matched > 0 && characters[index] !== characters[matched])
      matched = prefixes[matched - 1]!;
    if (characters[index] === characters[matched]) matched += 1;
    prefixes[index] = matched;
  }
  if (characters.length - prefixes[characters.length - 1]! <= Math.floor(characters.length / 2))
    return true;
  if (/^(?:password|passw0rd|qwerty|asdf|zxcv|letmein|admin|welcome|비밀번호)\d*$/u.test(compact))
    return true;
  const runs = compact.match(/[a-z]+|[0-9]+|[^a-z0-9]+/gu);
  return (
    runs !== null &&
    runs.every((run) =>
      sequenceSources.some((source) =>
        source.repeat(Math.ceil(run.length / source.length) + 1).includes(run),
      ),
    )
  );
}

/** Advisory only: no persistence, network calls or additional acceptance requirements. */
export function getPasswordStrength(value: string): PasswordStrength | null {
  const normalized = normalizeNewPassword(value);
  if (normalized.length === 0) return null;
  if (!newPasswordSchema.safeParse(normalized).success || isSimplePattern(normalized))
    return "weak";
  const length = codePointLength(normalized);
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[\p{Lo}\p{Lm}\p{Lt}]/u, /[^\p{L}\p{N}]/u].filter(
    (pattern) => pattern.test(normalized),
  ).length;
  return length >= 8 && kinds >= 3 ? "safe" : "moderate";
}
