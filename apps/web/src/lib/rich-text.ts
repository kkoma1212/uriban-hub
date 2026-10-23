/*
 * 공지 본문 서식(T-RICHTEXT, 2026-10-23 사용자 결정 A): 본문 글자 안의 **굵게**·==형광펜== 표시.
 * 저장은 글자 그대로라 DB 구조는 바뀌지 않는다. 화면은 이 결과를 React 요소로만 그려 글자를 코드로 실행하지 않는다.
 * 규칙: 한 줄 안에서만, 겹쳐 쓰지 않음, 안쪽 글자가 비었거나 앞뒤가 공백이면 서식이 아니다('a == b == c'는 그대로).
 * 서버 apps/api/src/common/text/rich-text.ts가 같은 규칙으로 기호를 뺀다 — 바꾸면 둘 다(같은 시험 사례표).
 */
export type RichTextStyle = "bold" | "mark";

export interface RichTextSegment {
  text: string;
  style?: RichTextStyle;
}

const MARKERS: ReadonlyArray<readonly [string, RichTextStyle]> = [
  ["**", "bold"],
  ["==", "mark"],
];

function parseLine(line: string, segments: RichTextSegment[]): void {
  let plain = "";
  let index = 0;
  while (index < line.length) {
    const marker = MARKERS.find(([token]) => line.startsWith(token, index));
    if (marker !== undefined) {
      const [token, style] = marker;
      const close = line.indexOf(token, index + token.length);
      const inner = close === -1 ? "" : line.slice(index + token.length, close);
      if (inner !== "" && inner.trim() === inner) {
        if (plain !== "") segments.push({ text: plain });
        plain = "";
        segments.push({ style, text: inner });
        index = close + token.length;
        continue;
      }
    }
    plain += line[index];
    index += 1;
  }
  if (plain !== "") segments.push({ text: plain });
}

export function parseRichText(text: string): RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (lineIndex > 0) segments.push({ text: "\n" });
    parseLine(line, segments);
  }
  return segments;
}

export function hasRichText(text: string): boolean {
  return parseRichText(text).some((segment) => segment.style !== undefined);
}

/** 목록 발췌·CSV처럼 서식을 그리지 않는 곳에는 기호를 뺀 글자만 쓴다. */
export function stripRichText(text: string): string {
  return parseRichText(text)
    .map((segment) => segment.text)
    .join("");
}

/** 쓰기 칸의 고른 글자를 기호로 감싼다. 고른 글자가 없으면 기호 사이에 커서를 둔다. */
export function wrapSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  style: RichTextStyle,
): { value: string; selectionStart: number; selectionEnd: number } {
  const token = MARKERS.find(([, markerStyle]) => markerStyle === style)![0];
  const selected = value.slice(selectionStart, selectionEnd);
  // 앞뒤 공백까지 고르면 서식이 되지 않으므로(위 규칙) 공백은 기호 밖에 둔다.
  const leading = selected.length - selected.trimStart().length;
  const trailing = selected.length - selected.trimEnd().length;
  const start = selectionStart + leading;
  const end = Math.max(start, selectionEnd - trailing);
  const next = value.slice(0, start) + token + value.slice(start, end) + token + value.slice(end);
  return {
    selectionEnd: end + token.length,
    selectionStart: start + token.length,
    value: next,
  };
}
