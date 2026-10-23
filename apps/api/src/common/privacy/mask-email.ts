/**
 * "abcd@example.com" → "ab***@example.com": 누구인지 짐작만 되게, 전체 주소는 보내지 않는다.
 * 아이디 부분은 끝까지 다 보이지 않게 한다("ab@…" → "a***@…", "a@…" → "***@…").
 *
 * 관리자 화면·학생 관리·가입 인증 화면이 같은 규칙을 쓴다. 예전에는 학생 관리 쪽 두 곳이 앞 두 글자를
 * 그대로 보여 아이디가 1~2글자면 전부 드러났다 — 2026-10-22 사용자 결정으로 이 규칙 하나로 합쳤다.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = Array.from(email.slice(0, at));
  const visible = local.slice(0, Math.min(2, local.length - 1)).join("");
  return `${visible}***${email.slice(at)}`;
}
