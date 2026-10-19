/*
 * 검색어가 글 안 어디에 있는지 형광펜처럼 칠한다.
 *
 * 목록에서 제목만 보면 왜 걸렸는지 모를 때가 있다 — 본문에서 걸렸기 때문이다.
 * 칠해 주면 "아 여기 있었구나"가 한눈에 보인다.
 *
 * ⚠️ 검색어를 정규식으로 만들 때 반드시 이스케이프한다. 사용자가 `(` 하나만 넣어도
 * 정규식이 깨져 화면이 통째로 죽는다.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/*
 * 본문은 목록에서 세 줄만 보인다. 검색어가 그 아래에 있으면 칠해도 안 보인다 —
 * 그래서 걸린 자리 주변을 잘라 온다. 앞이 잘렸으면 …를 붙여 잘렸다고 알린다.
 */
const EXCERPT_LEAD = 40;
const EXCERPT_LENGTH = 220;

export function searchExcerpt(
  text: string,
  term: string | undefined,
  contextBefore = EXCERPT_LEAD,
): string {
  const trimmed = term?.trim() ?? "";
  if (trimmed.length === 0) return text;

  const at = text.toLowerCase().indexOf(trimmed.toLowerCase());
  if (at < 0 || at <= contextBefore) return text;

  const from = at - contextBefore;
  const to = from + EXCERPT_LENGTH;
  return `…${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

export function HighlightMatch({
  term,
  text,
}: {
  term: string | undefined;
  text: string;
}): React.JSX.Element {
  const trimmed = term?.trim() ?? "";
  if (trimmed.length === 0) return <>{text}</>;

  const pattern = new RegExp(`(${escapeForRegExp(trimmed)})`, "giu");
  const pieces = text.split(pattern);
  if (pieces.length === 1) return <>{text}</>;

  return (
    <>
      {pieces.map((piece, index) =>
        /* split 은 걸린 조각을 홀수 자리에 둔다. 같은 글자가 반복돼도 자리로 가른다. */
        index % 2 === 1 ? (
          <mark
            className="rounded bg-warning-surface px-0.5 text-warning-text"
            key={`${String(index)}-${piece}`}
          >
            {piece}
          </mark>
        ) : (
          <span key={`${String(index)}-${piece}`}>{piece}</span>
        ),
      )}
    </>
  );
}
