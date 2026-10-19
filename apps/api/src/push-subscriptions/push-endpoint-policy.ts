/*
 * 서버가 브라우저가 알려 준 주소로 직접 요청을 보내므로, 임의 주소를 받으면 내부망으로
 * 요청을 보내게 만드는 공격(SSRF)이 된다. 주요 브라우저의 공식 푸시 서비스만 허용하고,
 * 구독 저장과 실제 발송 두 곳에서 모두 이 검사를 거친다.
 */
const EXACT_PUSH_HOSTS = new Set([
  "fcm.googleapis.com", // Chrome·Android·Samsung Internet
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari·iOS 홈 화면 웹앱
]);
const PUSH_HOST_SUFFIXES = [".notify.windows.com"]; // Edge(WNS)

export const MAX_PUSH_ENDPOINT_LENGTH = 1024;

export function parseAllowedPushEndpoint(value: string): URL | null {
  if (value.length > MAX_PUSH_ENDPOINT_LENGTH || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.href !== value) return null; // 정규화로 다른 호스트가 숨는 입력을 거부한다.
  const host = url.hostname;
  const allowed =
    EXACT_PUSH_HOSTS.has(host) ||
    PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
  return allowed ? url : null;
}
