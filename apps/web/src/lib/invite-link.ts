/*
 * QR 합류: 교사가 보여 준 QR(/join?code=…)을 찍으면 코드를 이 탭에 잠시 담아 두고,
 * 로그인·가입을 거친 뒤 참여 화면에서 미리 채운다. 자동으로 참여 요청을 보내지는 않는다.
 * 초대 코드는 반 전체에 나눠 주는 값이라 비밀은 아니지만, 형식이 맞을 때만 저장한다.
 */
const INVITE_CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{8}$/u;
const STORAGE_KEY = "classhub:pending-invite-code";
// 저장소 변경이 실패해도 현재 앱에서 이전 반 코드를 다시 읽지 않는다.
let ignoreStoredInviteCode = false;

export function normalizeInviteCode(value: string | null | undefined): string | null {
  const code = (value ?? "").trim().toUpperCase();
  return INVITE_CODE_PATTERN.test(code) ? code : null;
}

export function inviteJoinUrl(code: string, origin = window.location.origin): string {
  const url = new URL("/join", origin);
  url.searchParams.set("code", code);
  return url.href;
}

export function storePendingInviteCode(code: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, code);
    ignoreStoredInviteCode = false;
  } catch {
    ignoreStoredInviteCode = true;
    // 저장이 막힌 브라우저에서는 이전 코드를 쓰지 않고 학생이 직접 입력한다.
  }
}

export function readPendingInviteCode(): string | null {
  if (ignoreStoredInviteCode) return null;
  try {
    return normalizeInviteCode(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearPendingInviteCode(): void {
  ignoreStoredInviteCode = true;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장소를 지우지 못해도 현재 앱에서는 이전 반 코드를 미리 채우지 않는다.
  }
}
