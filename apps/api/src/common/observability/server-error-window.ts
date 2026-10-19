/**
 * 관리자 첫 화면의 "최근 1시간 서버 오류" 수. 이 프로세스가 돌려준 5xx 응답 시각만 메모리에 둔다
 * (요청 내용·주소는 남기지 않는다). 재시작하면 0부터 다시 센다 — 화면에도 그렇게 적는다.
 */
const WINDOW_MS = 60 * 60 * 1000;
/** 오류 폭주 때 메모리가 늘지 않게 최근 것만 둔다(넘으면 "이상"으로 충분히 보인다). */
const MAX_KEPT = 10_000;

const errorTimes: number[] = [];
const startedAt = Date.now();

function prune(now: number): void {
  let drop = 0;
  while (drop < errorTimes.length && errorTimes[drop]! <= now - WINDOW_MS) drop += 1;
  if (drop > 0) errorTimes.splice(0, drop);
}

export function recordServerResponseStatus(statusCode: number, now = Date.now()): void {
  if (statusCode < 500) return;
  errorTimes.push(now);
  if (errorTimes.length > MAX_KEPT) errorTimes.splice(0, errorTimes.length - MAX_KEPT);
}

export function serverErrorsInLastHour(now = Date.now()): number {
  prune(now);
  return errorTimes.length;
}

export function serverStartedAt(): Date {
  return new Date(startedAt);
}
