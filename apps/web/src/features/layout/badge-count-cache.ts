import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";

/*
 * 2026-10-01 성능: 메뉴 숫자(출결 대기·열린 도움 요청)는 화면 틀이 탭마다 새로 그려지면서 매번 비었다가
 * 다시 받아졌다. 마지막 숫자를 잠깐(15초) 기억해 탭을 옮겨도 그대로 보이고 같은 요청을 줄인다.
 * 앱 안의 변경 알림·창 다시 보기·주기 갱신은 그대로 숫자를 새로 받는다. 로그아웃·계정 정리 때 지운다.
 */
const FRESH_MS = 15_000;
const counts = new Map<string, { at: number; session: string; value: number | undefined }>();

/** 세션마다 새로 받는 CSRF 쿠키 값 — 세션이 바뀌면(다른 계정 포함) 기억한 숫자를 쓰지 않는다. */
function currentSession(): string {
  if (typeof document === "undefined") return "";
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__Host-classhub_csrf="));
  return cookie ?? "";
}

if (typeof window !== "undefined")
  window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, () => counts.clear());

export function rememberedBadgeCount(key: string): { fresh: boolean; value: number | undefined } {
  const entry = counts.get(key);
  if (entry === undefined || entry.session !== currentSession())
    return { fresh: false, value: undefined };
  return { fresh: Date.now() - entry.at < FRESH_MS, value: entry.value };
}

export function rememberBadgeCount(key: string, value: number | undefined): void {
  counts.set(key, { at: Date.now(), session: currentSession(), value });
}

export function forgetBadgeCount(key: string): void {
  counts.delete(key);
}

/** 테스트마다 빈 상태로 시작하게 한다. */
export function forgetAllBadgeCounts(): void {
  counts.clear();
}
