/*
 * 공지 본문 서식(T-RICHTEXT, 2026-10-23 사용자 결정 A)의 **굵게**·==형광펜== 기호를 빼고 글자만 남긴다.
 * 저장은 기호를 포함한 글자 그대로다. 서식을 그리지 않는 곳(반 기록 CSV)과 '오타 수정' 판정이 이 결과를 쓴다.
 * 규칙은 화면 apps/web/src/lib/rich-text.ts와 같다 — 한 줄 안에서만, 겹쳐 쓰지 않음, 안쪽 글자가 비었거나
 * 앞뒤가 공백이면 서식이 아니다. 바꾸면 둘 다(같은 시험 사례표).
 */
const MARKERS = ["**", "=="] as const;

function stripLine(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const token = MARKERS.find((marker) => line.startsWith(marker, index));
    if (token !== undefined) {
      const close = line.indexOf(token, index + token.length);
      const inner = close === -1 ? "" : line.slice(index + token.length, close);
      if (inner !== "" && inner.trim() === inner) {
        result += inner;
        index = close + token.length;
        continue;
      }
    }
    result += line[index];
    index += 1;
  }
  return result;
}

export function stripRichText(text: string): string {
  return text.split("\n").map(stripLine).join("\n");
}
