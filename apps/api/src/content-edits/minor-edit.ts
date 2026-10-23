import { stripRichText } from "../common/text/rich-text.js";

/*
 * 오타 수정 처리(2026-10-22 사용자 결정): 교사가 '오타·띄어쓰기만 고쳤어요'를 고르면 공지·준비물·숙제의
 * 판(content_revision)을 올리지 않아 학생에게 다시 확인을 요구하지 않는다.
 * 고른 변경이 정말 작은지는 서버만 판단한다. 화면은 기준을 안내만 하고 같은 규칙을 다시 만들지 않는다
 * (두 벌이 어긋나면 화면은 된다고 하고 서버는 거절하게 된다).
 *
 * 기준: 바뀐 글자(코드 포인트 기준 편집 거리)의 합이 상한 이하이고, 숫자 묶음이 그대로일 것.
 * 숫자는 날짜·시간·개수라 한 글자만 바뀌어도 뜻이 달라진다. '체육복→실내화' 같은 짧은 말 바꾸기는
 * 글자 수로 걸러지지 않으므로 교사 판단에 맡긴다.
 */
// 10자로 시작했으나 '내일은 체육복을→모레는 실내화와 물통을'(정확히 10자)처럼 뜻이 바뀌는 수정이 통과해
// 사용자 결정으로 5자로 낮췄다(2026-10-22). 한글 오타·띄어쓰기는 보통 1~3자다.
export const MINOR_EDIT_MAX_CHANGED_CHARACTERS = 5;

/**
 * [수정 전, 수정 후] 짝들이 모두 합쳐 오타 수정 범위인지 본다.
 * 굵게·형광펜 기호는 빼고 비교한다 — 서식만 바꾼 수정은 바뀐 글자 0자(2026-10-23 T-RICHTEXT).
 */
export function isMinorTextEdit(pairs: ReadonlyArray<readonly [string, string]>): boolean {
  let remaining = MINOR_EDIT_MAX_CHANGED_CHARACTERS;
  for (const [rawBefore, rawAfter] of pairs) {
    const before = stripRichText(rawBefore);
    const after = stripRichText(rawAfter);
    if (digitRuns(before) !== digitRuns(after)) return false;
    const distance = boundedEditDistance(Array.from(before), Array.from(after), remaining);
    if (distance > remaining) return false;
    remaining -= distance;
  }
  return true;
}

function digitRuns(text: string): string {
  return (text.match(/\p{Nd}+/gu) ?? []).join(" ");
}

/**
 * 편집 거리(넣기·빼기·바꾸기 한 글자씩)를 limit까지만 센다. 넘으면 limit + 1.
 * 본문은 최대 2,000자라 앞뒤 같은 부분을 먼저 잘라 내고, 대각선 띠(limit 폭) 안만 계산한다.
 */
function boundedEditDistance(before: string[], after: string[], limit: number): number {
  const over = limit + 1;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const a = before.slice(start, beforeEnd);
  const b = after.slice(start, afterEnd);
  if (Math.abs(a.length - b.length) > limit) return over;

  let previous = new Int32Array(b.length + 1).fill(over);
  let current = new Int32Array(b.length + 1);
  for (let column = 0; column <= Math.min(b.length, limit); column += 1) previous[column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    current.fill(over);
    if (row <= limit) current[0] = row;
    let rowMinimum = current[0]!;
    const first = Math.max(1, row - limit);
    const last = Math.min(b.length, row + limit);
    for (let column = first; column <= last; column += 1) {
      const replace = previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1);
      const value = Math.min(over, replace, previous[column]! + 1, current[column - 1]! + 1);
      current[column] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > limit) return over;
    [previous, current] = [current, previous];
  }
  return Math.min(previous[b.length]!, over);
}
