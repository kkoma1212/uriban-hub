import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment } from "../apps/api/dist/config/environment.js";
import { ADMIN_REMOTE_PORT, createAdminRemoteInput } from "./admin-remote-environment.mjs";

const adminOrigin = "https://uriban-hub-admin.synthetic-account.workers.dev";
const userOrigin = "https://uriban-hub.synthetic-account.workers.dev";

// 이 PC 운영 묶음과 같은 모양의 합성 설정(값은 모두 가짜).
function localLike(overrides = {}) {
  return {
    NODE_ENV: "development",
    DATABASE_ENGINE: "mariadb",
    DATABASE_URL: "mariadb://classhub_app:synthetic-password@localhost:3307/synthetic_db",
    DATABASE_TLS_MODE: "disabled",
    DATABASE_ACCOUNT_HOST: "localhost",
    REDIS_URL: "redis://127.0.0.1:6380",
    API_PORT: "3000",
    PUBLIC_APP_ORIGIN: "http://localhost:5174",
    PUBLIC_API_ORIGIN: "http://localhost:5174",
    EMAIL_HMAC_KEY: "synthetic-shared-hmac-key-at-least-32-characters",
    EMAIL_HMAC_KEY_VERSION: "synthetic-v1",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64url"),
    ADMIN_MFA_KEY_VERSION: "synthetic-admin-v1",
    ADMIN_PASSKEYS_ENABLED: "true",
    ADMIN_WEBAUTHN_RP_ID: "localhost",
    AUTH_DATABASE_EXTENSIONS: "all",
    SMTP_HOST: "smtp.example.invalid",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USERNAME: "synthetic",
    SMTP_PASSWORD: "synthetic",
    SMTP_FROM: "synthetic@example.invalid",
    POLLS_ENABLED: "true",
    ELECTIONS_ENABLED: "true",
    CLASS_CHAT_ENABLED: "true",
    WEB_PUSH_ENABLED: "true",
    ATTENDANCE_NOTIFICATIONS_ENABLED: "true",
    SOCIAL_AUTH_ENABLED: "true",
    SOCIAL_GOOGLE_CLIENT_SECRET: "synthetic",
    LOCAL_TEST_ADMIN_ENABLED: "true",
    LOCAL_TEST_ADMIN_PASSWORD_HASH: "synthetic",
    SOME_SHELL_VARIABLE: "not-for-the-api",
    ...overrides,
  };
}

test("runs as the production administrator program on its own host", () => {
  const input = createAdminRemoteInput(localLike(), adminOrigin, userOrigin);
  assert.equal(input.NODE_ENV, "production");
  assert.equal(input.API_SURFACE, "admin");
  assert.equal(input.API_HOST, "127.0.0.1");
  assert.equal(input.API_PORT, String(ADMIN_REMOTE_PORT));
  assert.equal(input.PUBLIC_APP_ORIGIN, adminOrigin);
  assert.equal(input.PUBLIC_API_ORIGIN, adminOrigin);
  assert.equal(input.USER_APP_ORIGIN, userOrigin);
  assert.equal(input.ADMIN_WEBAUTHN_RP_ID, new URL(adminOrigin).hostname);
  assert.equal(input.PUBLIC_PREVIEW_ENABLED, "false");
  assert.equal(input.TRUSTED_PROXY_HOPS, "1");
});

test("keeps administrator secrets but drops social, local-test and unrelated values", () => {
  const source = localLike();
  const input = createAdminRemoteInput(source, adminOrigin, userOrigin);
  assert.equal(input.ADMIN_MFA_ENCRYPTION_KEY, source.ADMIN_MFA_ENCRYPTION_KEY);
  assert.equal(input.EMAIL_HMAC_KEY, source.EMAIL_HMAC_KEY);
  assert.equal(input.SOCIAL_AUTH_ENABLED, "false");
  assert.equal(input.SOCIAL_GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(input.LOCAL_TEST_ADMIN_ENABLED, "false");
  assert.equal(input.LOCAL_TEST_ADMIN_PASSWORD_HASH, undefined);
  assert.equal(input.SOME_SHELL_VARIABLE, undefined);
  // 원본 설정은 바꾸지 않는다.
  assert.equal(source.ADMIN_WEBAUTHN_RP_ID, "localhost");
  assert.equal(source.NODE_ENV, "development");
});

test("turns off the features production does not allow yet", () => {
  const input = createAdminRemoteInput(localLike(), adminOrigin, userOrigin);
  for (const name of [
    "ATTENDANCE_NOTIFICATIONS_ENABLED",
    "CLASS_CHAT_ENABLED",
    "ELECTIONS_ENABLED",
    "POLLS_ENABLED",
    "WEB_PUSH_ENABLED",
  ])
    assert.equal(input[name], "false", name);
});

test("passes the server's production validation", () => {
  const environment = loadEnvironment(createAdminRemoteInput(localLike(), adminOrigin, userOrigin));
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.API_SURFACE, "admin");
  assert.equal(environment.ADMIN_WEB_ENABLED, true);
  assert.equal(environment.ADMIN_PASSKEYS_ENABLED, true);
});

test("refuses origins that are not a fixed https workers.dev host or share the user host", () => {
  for (const origin of [
    undefined,
    "http://uriban-hub-admin.synthetic-account.workers.dev",
    "https://synthetic.trycloudflare.com",
    "https://admin.example.invalid",
    `${adminOrigin}/`,
  ])
    assert.throws(() => createAdminRemoteInput(localLike(), origin, userOrigin), origin);
  assert.throws(() => createAdminRemoteInput(localLike(), adminOrigin, adminOrigin));
  assert.throws(() => createAdminRemoteInput(localLike(), adminOrigin, "http://localhost:5174"));
});

test("skips Redis TLS only for a loopback Redis", () => {
  assert.equal(
    createAdminRemoteInput(localLike(), adminOrigin, userOrigin).REDIS_TLS_MODE,
    "disabled",
  );
  assert.throws(() =>
    createAdminRemoteInput(
      localLike({ REDIS_URL: "redis://redis.example.invalid:6379" }),
      adminOrigin,
      userOrigin,
    ),
  );
});
