import { describe, expect, it } from "vitest";
import { loadEnvironment } from "./environment.js";

const preview = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic",
  PUBLIC_PREVIEW_ENABLED: "true",
  PUBLIC_APP_ORIGIN: "https://synthetic-preview.trycloudflare.com",
  PUBLIC_API_ORIGIN: "https://synthetic-preview.trycloudflare.com",
  EMAIL_HMAC_KEY: "synthetic-shared-key-at-least-32-characters",
  TRUSTED_PROXY_HOPS: "1",
  SMTP_REQUIRE_TLS: "true",
  SMTP_USERNAME: "synthetic",
  SMTP_PASSWORD: "synthetic",
};

describe("public preview environment boundary", () => {
  it("accepts an explicitly restricted HTTPS preview", () => {
    const parsed = loadEnvironment(preview);
    expect(parsed.ADMIN_WEB_ENABLED).toBe(false);
    expect(parsed.LOCAL_TEST_ADMIN_ENABLED).toBe(false);
  });
  it.each([undefined, "false"])("rejects an unmarked Quick Tunnel (%s)", (enabled) => {
    expect(() => loadEnvironment({ ...preview, PUBLIC_PREVIEW_ENABLED: enabled })).toThrow(
      "PUBLIC_PREVIEW_ENABLED",
    );
  });
  it.each(["development", "test", "production"])("rejects public admin in %s", (nodeEnv) => {
    expect(() =>
      loadEnvironment({
        ...preview,
        NODE_ENV: nodeEnv,
        ADMIN_WEB_ENABLED: "true",
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
        ADMIN_MFA_KEY_VERSION: "synthetic",
      }),
    ).toThrow();
  });
  it.each([
    { ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url") },
    { ADMIN_MFA_KEY_VERSION: "synthetic" },
    { API_HOST: "0.0.0.0" },
    { TRUSTED_PROXY_HOPS: "0" },
    { TRUSTED_PROXY_HOPS: "2" },
    { TRUSTED_PROXY_ADDRESSES: "203.0.113.8" },
    { SMTP_REQUIRE_TLS: "false", SMTP_SECURE: "false" },
    { SMTP_USERNAME: undefined, SMTP_PASSWORD: undefined },
    { EMAIL_HMAC_KEY: undefined },
    { EMAIL_HMAC_KEY: "local-preview-placeholder-not-a-secret-0001" },
  ])("rejects unsafe public configuration %j", (override) => {
    expect(() => loadEnvironment({ ...preview, ...override })).toThrow();
  });
  it("keeps local administrator access available", () => {
    const parsed = loadEnvironment({
      NODE_ENV: "development",
      ADMIN_WEB_ENABLED: "true",
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
      ADMIN_MFA_KEY_VERSION: "synthetic",
    });
    expect(parsed.ADMIN_WEB_ENABLED).toBe(true);
  });
});
