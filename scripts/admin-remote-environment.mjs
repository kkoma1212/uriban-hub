import { URL } from "node:url";
import { APP_ENVIRONMENT_KEYS } from "../apps/api/dist/config/environment.js";
import { systemKeys } from "./phone-preview-environment.mjs";

/*
 * 관리자 원격 접속(T-ADMIN-REMOTE, 2026-10-20 사용자 B안): Cloudflare Access로 잠근 관리자 전용 주소
 * → 터널 → 이 PC의 관리자 프로그램. 회사 서버 api-admin(OPERATIONS/server-release/docker-compose.yml)과
 * 같은 모양 — 운영 모드·관리자 전용(API_SURFACE=admin)·학생·교사 주소와 다른 호스트 — 으로 띄운다.
 * 인터넷 쪽에 닿는 프로그램이라 공개 미리보기처럼 API가 읽는 설정과 시스템 값만 넘긴다.
 */
const apiKeys = new Set(APP_ENVIRONMENT_KEYS);

export const ADMIN_REMOTE_PORT = 3302;
export const ADMIN_REMOTE_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u;

// 운영 모드에서는 승인 전 기능을 켤 수 없다(environment.ts). 관리자 프로그램은 학생·교사 API를 받지 않으므로 끈다.
const PRODUCTION_LOCKED_FEATURES = [
  "ATTENDANCE_NOTIFICATIONS_ENABLED",
  "CLASS_CHAT_ENABLED",
  "ELECTIONS_ENABLED",
  "POLLS_ENABLED",
  "STUDENT_ASSESSMENTS_ENABLED",
  "STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED",
  "WEB_PUSH_ENABLED",
];

export function createAdminRemoteInput(environment, adminOrigin, userOrigin) {
  if (!ADMIN_REMOTE_ORIGIN_PATTERN.test(adminOrigin ?? "")) {
    throw new Error("A fixed https workers.dev administrator origin is required.");
  }
  if (!URL.canParse(userOrigin ?? "") || new URL(userOrigin).protocol !== "https:") {
    throw new Error("The student and teacher https origin is required for mail links.");
  }
  const adminHostname = new URL(adminOrigin).hostname;
  // 쿠키는 호스트에 묶이므로 관리자 주소가 학생·교사 주소와 같으면 안 된다(environment.ts도 거절한다).
  if (new URL(userOrigin).hostname === adminHostname) {
    throw new Error("The administrator origin must differ from the student and teacher origin.");
  }
  // 회사 서버처럼 같은 기계 안의 Redis만 암호화 연결을 생략한다(docker-compose.yml REDIS_TLS_MODE).
  if (
    !URL.canParse(environment.REDIS_URL ?? "") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(environment.REDIS_URL).hostname)
  ) {
    throw new Error("The administrator program only skips Redis TLS for a loopback Redis.");
  }
  const input = {
    ...environment,
    NODE_ENV: "production",
    API_SURFACE: "admin",
    API_HOST: "127.0.0.1",
    API_PORT: String(ADMIN_REMOTE_PORT),
    TRUSTED_PROXY_HOPS: "1",
    TRUSTED_PROXY_ADDRESSES: "127.0.0.1,::1",
    PUBLIC_PREVIEW_ENABLED: "false",
    REDIS_TLS_MODE: "disabled",
    PUBLIC_APP_ORIGIN: adminOrigin,
    PUBLIC_API_ORIGIN: adminOrigin,
    USER_APP_ORIGIN: userOrigin,
    SERVE_WEB: "true",
    ADMIN_WEB_ENABLED: "true",
    // 패스키는 등록한 주소에 묶인다 — 이 주소에서는 다시 등록해야 한다.
    ADMIN_WEBAUTHN_RP_ID: adminHostname,
    LOCAL_TEST_ADMIN_ENABLED: "false",
    SOCIAL_AUTH_ENABLED: "false",
    ...Object.fromEntries(PRODUCTION_LOCKED_FEATURES.map((name) => [name, "false"])),
  };
  for (const key of Object.keys(input)) {
    if (!apiKeys.has(key) && !systemKeys.has(key.toUpperCase())) delete input[key];
    if (key.startsWith("SOCIAL_") && key !== "SOCIAL_AUTH_ENABLED") delete input[key];
    if (key.startsWith("LOCAL_TEST_ADMIN_") && key !== "LOCAL_TEST_ADMIN_ENABLED")
      delete input[key];
  }
  return input;
}
