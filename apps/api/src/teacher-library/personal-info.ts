export interface PersonalInfoHit {
  kind: "email" | "name" | "phone";
  text: string;
}

// 휴대전화(010 등)·일반 전화 모양. 날짜(2025-03-02)와 헷갈리지 않게 앞자리를 0으로 한정한다.
const PHONE = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/gu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/**
 * 담을 글에서 원글 반 학생 이름·전화번호·이메일 모양을 찾는다. 교사에게 강조해 보여 주기 위한
 * 최선노력 검사다 — 별명·줄임말·사진 속 정보는 찾지 못한다(화면에서도 그렇게 알린다).
 */
export function findPersonalInfo(text: string, names: readonly string[]): PersonalInfoHit[] {
  const hits: PersonalInfoHit[] = [];
  const seen = new Set<string>();
  const add = (kind: PersonalInfoHit["kind"], value: string): void => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, text: value });
  };
  for (const match of text.matchAll(PHONE)) add("phone", match[0]);
  for (const match of text.matchAll(EMAIL)) add("email", match[0]);
  // 한 글자 이름은 흔한 낱말과 겹쳐 오탐이 많으므로 두 글자 이상만 본다.
  for (const name of names) if (name.length >= 2 && text.includes(name)) add("name", name);
  return hits;
}
