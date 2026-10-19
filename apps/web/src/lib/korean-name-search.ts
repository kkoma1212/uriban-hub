/*
 * 학생 명단을 한국어 감각대로 정렬하고 찾는다(2026-08-25 Round 5 승인 시안 §2).
 *
 * 왜 브라우저에서 하는가: 한 반은 수십 명이라 전부 이미 받아 온 상태이고, 서버 쿼리에
 * `ORDER BY`가 없다. 목록 API·권한 계약을 건드리지 않고 화면에서 끝내는 편이 안전하다.
 * 반이 수백 명 규모가 되면 그때 서버 정렬로 옮긴다.
 */

/** 호환 자모 영역의 초성 19개. **문자열에서의 위치가 곧 초성 인덱스**다. */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;

/** 한 초성이 거느리는 음절 수 = 중성 21 × 종성 28. */
const CHOSEONG_SPAN = 588;

/**
 * 가나다순 비교기. `numeric`은 "학생10"처럼 이름에 숫자가 섞였을 때 10이 2 앞으로
 * 가지 않게 한다. `sensitivity: "base"`는 대소문자·악센트 차이를 같은 것으로 본다.
 */
export const koreanNameCollator = new Intl.Collator("ko-KR", {
  numeric: true,
  sensitivity: "base",
});

export interface StudentSearchTarget {
  displayName: string;
  studentNumber: number | null;
}

/** 이름을 초성열로 바꾼다. 한글 음절이 아닌 글자는 그대로 남긴다. */
export function leadingConsonants(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < HANGUL_SYLLABLE_START || code > HANGUL_SYLLABLE_END) {
      result += character;
      continue;
    }
    result += CHOSEONG[Math.floor((code - HANGUL_SYLLABLE_START) / CHOSEONG_SPAN)];
  }
  return result;
}

/** 입력이 통째로 초성으로만 이뤄졌는가. `ㄱ`, `ㄱㅁ`처럼. */
export function isConsonantQuery(value: string): boolean {
  return value.length > 0 && [...value].every((character) => CHOSEONG.includes(character));
}

function withoutSpaces(value: string): string {
  return value.replace(/\s+/gu, "");
}

/**
 * 검색창 하나로 세 가지를 받는다: 이름 일부 · 학생 번호 · **이름 시작** 초성열.
 *
 * 셋을 화면에서 나누지 않는 이유는 선생님이 무엇으로 찾을지 미리 고르게 만들지
 * 않기 위해서다. 대신 입력 모양으로 갈래를 정한다 — 숫자만이면 번호, 초성만이면
 * 초성열, 그 밖은 이름이다. 초성열만 "시작"으로 맞추는 것은 `ㄱ`이 `박기준`까지
 * 끌고 오면 성으로 훑는 쓰임이 무너지기 때문이다.
 */
export function matchesStudentSearch(target: StudentSearchTarget, query: string): boolean {
  const normalized = query.trim();
  if (normalized === "") return true;

  if (/^\d+$/u.test(normalized)) {
    return target.studentNumber !== null && String(target.studentNumber).startsWith(normalized);
  }

  if (isConsonantQuery(normalized)) {
    return leadingConsonants(target.displayName).startsWith(normalized);
  }

  return withoutSpaces(target.displayName).includes(withoutSpaces(normalized));
}

/** 이름 오름차순, 같은 이름이면 번호 오름차순. 번호가 없는 학생은 뒤로 보낸다. */
export function compareStudentsByName(
  left: StudentSearchTarget,
  right: StudentSearchTarget,
): number {
  const byName = koreanNameCollator.compare(left.displayName, right.displayName);
  if (byName !== 0) return byName;
  return (
    (left.studentNumber ?? Number.MAX_SAFE_INTEGER) -
    (right.studentNumber ?? Number.MAX_SAFE_INTEGER)
  );
}
