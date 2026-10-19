import { URL } from "node:url";
import { APP_ENVIRONMENT_KEYS } from "../apps/api/dist/config/environment.js";

// 인터넷에 열린 미리보기에는 API가 읽는 설정과 Windows에서 Node를 돌리는 데 필요한 시스템 값만 넘긴다
// (총검수 I4-02, 2026-10-03). 다른 역할의 DB 비밀번호·셸 변수처럼 목록 밖의 값은 넘기지 않는다.
const apiKeys = new Set(APP_ENVIRONMENT_KEYS);
const systemKeys = new Set(
  [
    "SystemRoot",
    "windir",
    "ComSpec",
    "Path",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "COMPUTERNAME",
    "INSTANCE_ID",
    "RELEASE_ID",
    "IMAGE_DIGEST",
  ].map((key) => key.toUpperCase()),
);

// 켤 때마다 바뀌는 Quick Tunnel 주소, 또는 고정 입구 workers.dev 주소
// (OPERATIONS/web-deployment/fixed-entry, 2026-10-19 사용자 선택 A안).
export const PREVIEW_ORIGIN_PATTERN =
  /^https:\/\/(?:(?!api\.)[a-z0-9-]+\.trycloudflare\.com|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)$/u;

export function createPhonePreviewInput(environment, origin, defaultDatabaseUrl) {
  if (!origin || !PREVIEW_ORIGIN_PATTERN.test(origin)) {
    throw new Error("An issued Cloudflare preview HTTPS origin is required.");
  }
  const input = {
    ...environment,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3301",
    TRUSTED_PROXY_HOPS: "1",
    TRUSTED_PROXY_ADDRESSES: "127.0.0.1,::1",
    PUBLIC_PREVIEW_ENABLED: "true",
    PUBLIC_APP_ORIGIN: origin,
    PUBLIC_API_ORIGIN: origin,
    SERVE_WEB: "true",
    ADMIN_WEB_ENABLED: "false",
    LOCAL_TEST_ADMIN_ENABLED: "false",
    // 바뀌는 임시 주소에서는 소셜 로그인을 켜지 않는다(돌아올 주소를 미리 등록할 수 없다).
    // .env.local에서 이 PC용으로 켜도 공개 미리보기는 끈 채로 뜬다.
    SOCIAL_AUTH_ENABLED: "false",
  };
  if (!input.DATABASE_URL && input.DATABASE_ENGINE !== "mariadb") {
    input.DATABASE_URL = defaultDatabaseUrl;
  }
  if (input.DATABASE_URL) {
    const databaseUrl = new URL(input.DATABASE_URL);
    if (["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
      databaseUrl.searchParams.set("application_name", "classhub_phone_preview");
      input.DATABASE_URL = databaseUrl.toString();
    }
  }
  // ADMIN_ACCESS_LOGS_DATABASE_INSTALLED는 비밀이 아니라 공유 DB에 접속기록 표가 설치됐다는 표시다.
  // 지우면 미리보기 API가 설치 전 권한을 기대해 시작을 거부한다(2026-10-03 원장 101·102 적용 직후 실측).
  const keptAdminKeys = new Set(["ADMIN_WEB_ENABLED", "ADMIN_ACCESS_LOGS_DATABASE_INSTALLED"]);
  for (const key of Object.keys(input)) {
    if (!apiKeys.has(key) && !systemKeys.has(key.toUpperCase())) delete input[key];
    // 소셜 로그인은 위에서 끄므로 제공자 ID·비밀키·흐름 키도 넘기지 않는다.
    if (key.startsWith("SOCIAL_") && key !== "SOCIAL_AUTH_ENABLED") delete input[key];
    if (key.startsWith("ADMIN_") && !keptAdminKeys.has(key)) delete input[key];
    if (key.startsWith("LOCAL_TEST_ADMIN_") && key !== "LOCAL_TEST_ADMIN_ENABLED")
      delete input[key];
  }
  // Shared authentication keys must be supplied unchanged; loadEnvironment rejects missing keys.
  return input;
}
