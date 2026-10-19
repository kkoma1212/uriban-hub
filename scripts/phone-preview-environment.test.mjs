import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import { createPhonePreviewInput } from "./phone-preview-environment.mjs";

const origin = "https://synthetic-preview.trycloudflare.com";
const databaseUrl = "postgresql://synthetic:synthetic@db.example.invalid:5432/synthetic";
const secret = "synthetic-shared-hmac-key-at-least-32-characters";
test("preserves shared database/HMAC settings while excluding administrator credentials", () => {
  const input = {
    DATABASE_URL: databaseUrl,
    DATABASE_ENGINE: "postgres",
    ADMIN_WEB_ENABLED: "true",
    ADMIN_MFA_ENCRYPTION_KEY: "synthetic-only",
    ADMIN_MFA_KEY_VERSION: "synthetic-v1",
    EMAIL_HMAC_KEY: secret,
  };
  const result = createPhonePreviewInput(input, origin, databaseUrl);
  assert.equal(result.EMAIL_HMAC_KEY, secret);
  assert.equal(result.ADMIN_MFA_ENCRYPTION_KEY, undefined);
  assert.equal(result.ADMIN_MFA_KEY_VERSION, undefined);
  assert.equal(result.ADMIN_WEB_ENABLED, "false");
  assert.equal(result.PUBLIC_PREVIEW_ENABLED, "true");
  assert.equal(input.ADMIN_WEB_ENABLED, "true");
  assert.equal(input.ADMIN_MFA_ENCRYPTION_KEY, "synthetic-only");
  assert.equal(result.PUBLIC_APP_ORIGIN, origin);
  assert.equal(result.PUBLIC_API_ORIGIN, origin);
  assert.equal(result.API_PORT, "3301");
  assert.equal(result.SERVE_WEB, "true");
  assert.equal(result.NODE_ENV, "test");
  assert.equal(result.TRUSTED_PROXY_HOPS, "1");
  assert.equal(input.DATABASE_URL, databaseUrl);
  const selected = new URL(result.DATABASE_URL);
  assert.equal(selected.searchParams.get("application_name"), "classhub_phone_preview");
  selected.searchParams.delete("application_name");
  assert.equal(selected.toString(), databaseUrl);
});
test("removes all local-test administrator credentials and keeps the feature disabled", () => {
  const result = createPhonePreviewInput(
    {
      LOCAL_TEST_ADMIN_ENABLED: "true",
      LOCAL_TEST_ADMIN_DATABASE_URL: "synthetic",
      LOCAL_TEST_ADMIN_PASSWORD_HASH: "synthetic",
      LOCAL_TEST_ADMIN_USERNAME: "synthetic",
    },
    origin,
    databaseUrl,
  );
  assert.deepEqual(
    Object.keys(result).filter((key) => key.startsWith("LOCAL_TEST_ADMIN_")),
    ["LOCAL_TEST_ADMIN_ENABLED"],
  );
  assert.equal(result.LOCAL_TEST_ADMIN_ENABLED, "false");
  assert.equal(result.ADMIN_WEB_ENABLED, "false");
});
test("preserves native MariaDB TLS configuration and never falls back to PostgreSQL", () => {
  const input = {
    DATABASE_ENGINE: "mariadb",
    DATABASE_URL: "mysql://synthetic:synthetic@db.example.invalid/synthetic",
    DATABASE_TLS_CA_FILE: "synthetic.pem",
    DATABASE_ACCOUNT_HOST: "synthetic.invalid",
  };
  const result = createPhonePreviewInput(input, origin, databaseUrl);
  assert.equal(result.DATABASE_URL, input.DATABASE_URL);
  assert.equal(result.DATABASE_TLS_CA_FILE, input.DATABASE_TLS_CA_FILE);
  assert.equal(result.DATABASE_ACCOUNT_HOST, input.DATABASE_ACCOUNT_HOST);
  assert.equal(
    createPhonePreviewInput({ DATABASE_ENGINE: "mariadb" }, origin, databaseUrl).DATABASE_URL,
    undefined,
  );
});
test("does not manufacture a shared authentication key when configuration is missing", () => {
  assert.equal(createPhonePreviewInput({}, origin, databaseUrl).EMAIL_HMAC_KEY, undefined);
  const unchanged = createPhonePreviewInput(
    { EMAIL_HMAC_KEY: "replace-with-at-least-32-random-bytes" },
    origin,
    databaseUrl,
  );
  assert.equal(unchanged.EMAIL_HMAC_KEY, "replace-with-at-least-32-random-bytes");
});
test("removes inherited and future administrator settings and overrides exposure switches", () => {
  const result = createPhonePreviewInput(
    {
      ADMIN_WEB_ENABLED: "true",
      ADMIN_FUTURE_RECOVERY_SECRET: "synthetic",
      PUBLIC_PREVIEW_ENABLED: "false",
      API_HOST: "0.0.0.0",
      TRUSTED_PROXY_ADDRESSES: "203.0.113.8",
    },
    origin,
    databaseUrl,
  );
  assert.deepEqual(
    Object.keys(result).filter((key) => key.startsWith("ADMIN_")),
    ["ADMIN_WEB_ENABLED"],
  );
  assert.equal(result.PUBLIC_PREVIEW_ENABLED, "true");
  assert.equal(result.API_HOST, "127.0.0.1");
  assert.equal(result.TRUSTED_PROXY_ADDRESSES, "127.0.0.1,::1");
});
test("keeps the shared database access-log install flag so the API expects the installed grants", () => {
  const result = createPhonePreviewInput(
    { ADMIN_ACCESS_LOGS_DATABASE_INSTALLED: "true", ADMIN_MFA_ENCRYPTION_KEY: "synthetic-only" },
    origin,
    databaseUrl,
  );
  assert.equal(result.ADMIN_ACCESS_LOGS_DATABASE_INSTALLED, "true");
  assert.equal(result.ADMIN_MFA_ENCRYPTION_KEY, undefined);
  assert.equal(result.ADMIN_WEB_ENABLED, "false");
});
test("passes only API settings and system values, never other roles' or social secrets", () => {
  const result = createPhonePreviewInput(
    {
      OPERATOR_DATABASE_URL: "synthetic",
      RETENTION_DATABASE_URL: "synthetic",
      WORKER_DATABASE_URL: "synthetic",
      SOCIAL_GOOGLE_CLIENT_SECRET: "synthetic",
      SOCIAL_AUTH_FLOW_KEY: "synthetic",
      UNRELATED_SHELL_TOKEN: "synthetic",
      SMTP_PASSWORD: "synthetic-smtp",
      TERMS_POLICY_VERSION: "dev-synthetic",
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
    },
    origin,
    databaseUrl,
  );
  for (const key of [
    "OPERATOR_DATABASE_URL",
    "RETENTION_DATABASE_URL",
    "WORKER_DATABASE_URL",
    "SOCIAL_GOOGLE_CLIENT_SECRET",
    "SOCIAL_AUTH_FLOW_KEY",
    "UNRELATED_SHELL_TOKEN",
  ])
    assert.equal(result[key], undefined, key);
  assert.equal(result.SMTP_PASSWORD, "synthetic-smtp");
  assert.equal(result.TERMS_POLICY_VERSION, "dev-synthetic");
  assert.equal(result.SystemRoot, "C:\\Windows");
  assert.equal(result.Path, "C:\\Windows\\System32");
  assert.equal(result.SOCIAL_AUTH_ENABLED, "false");
});
test("keeps social login off on the changing public preview origin", () => {
  const result = createPhonePreviewInput(
    { SOCIAL_AUTH_ENABLED: "true", SOCIAL_GOOGLE_ENABLED: "true" },
    origin,
    databaseUrl,
  );
  assert.equal(result.SOCIAL_AUTH_ENABLED, "false");
});
test("accepts the fixed workers.dev entry origin", () => {
  const fixed = "https://uriban-hub.synthetic-account.workers.dev";
  const result = createPhonePreviewInput({}, fixed, databaseUrl);
  assert.equal(result.PUBLIC_APP_ORIGIN, fixed);
  assert.equal(result.PUBLIC_API_ORIGIN, fixed);
  assert.equal(result.TRUSTED_PROXY_HOPS, "1");
});
for (const invalid of [
  undefined,
  "http://synthetic-preview.trycloudflare.com",
  "https://api.synthetic-preview.trycloudflare.com",
  "https://example.invalid",
  origin + "/",
  origin + "@example.invalid",
  "http://uriban-hub.synthetic-account.workers.dev",
  "https://synthetic-account.workers.dev",
  "https://a.uriban-hub.synthetic-account.workers.dev",
  "https://uriban-hub.synthetic-account.workers.dev:8443",
  "https://uriban-hub.synthetic-account.workers.dev.example.invalid",
]) {
  test(`rejects invalid public origin ${invalid}`, () =>
    assert.throws(() => createPhonePreviewInput({}, invalid, databaseUrl), /issued Cloudflare/u));
}
