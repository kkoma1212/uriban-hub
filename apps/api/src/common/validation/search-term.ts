/*
 * 목록 검색어를 다루는 공용 규칙.
 *
 * ⚠️ 이스케이프가 핵심이다. `ILIKE`에서 `%`와 `_`는 와일드카드라, 사용자가 `%`
 * 한 글자만 넣으면 **전부**가 걸린다. `_`는 아무 글자 하나와 맞는다. 검색어는
 * 사용자가 넣은 글자 그대로 찾아야 하므로 셋(`\` `%` `_`)을 막아 준다.
 */

/** 빈 문자열·공백만 있는 값은 "검색 안 함"으로 본다. */
export function normalizeSearchTerm(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** `ILIKE ... ESCAPE '\'` 와 함께 쓴다. */
export function toIlikePattern(term: string): string {
  const escaped = term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  return `%${escaped}%`;
}
