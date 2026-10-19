import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadEnvironment } from "./environment.js";

// 설치된 DB 확장(AUTH_DATABASE_EXTENSIONS·CLASS_CHAT_DATABASE_INSTALLED)은 기능 켜기와 따로 검사한다.
const mariaDbPreview = {
  NODE_ENV: "development",
  DATABASE_ENGINE: "mariadb",
  DATABASE_URL: "mariadb://classhub_app:synthetic@localhost:13307/classhub_dev",
  DATABASE_TLS_CA_FILE: "synthetic-ca.pem",
  DATABASE_ACCOUNT_HOST: "%",
} as const;
const passkeys = {
  ADMIN_WEB_ENABLED: "true",
  ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64url"),
  ADMIN_MFA_KEY_VERSION: "synthetic-1",
  ADMIN_PASSKEYS_ENABLED: "true",
  ADMIN_WEBAUTHN_RP_ID: "localhost",
  PUBLIC_APP_ORIGIN: "http://localhost:5174",
  PUBLIC_API_ORIGIN: "http://localhost:5174",
} as const;
const mockSocial = {
  SOCIAL_AUTH_ENABLED: "true",
  SOCIAL_GOOGLE_ENABLED: "true",
  SOCIAL_AUTH_FLOW_KEY: Buffer.alloc(32, 5).toString("base64url"),
  SOCIAL_AUTH_MOCK_ISSUER: "http://127.0.0.1:18090",
  PUBLIC_APP_ORIGIN: "http://localhost:5174",
  PUBLIC_API_ORIGIN: "http://localhost:5174",
} as const;

function issuePaths(input: Record<string, unknown>): string[] {
  try {
    loadEnvironment(input);
    return [];
  } catch (error) {
    if (error instanceof ZodError) return error.issues.map((issue) => issue.path.join("."));
    throw error;
  }
}

describe("installed database extensions", () => {
  it("defaults to nothing installed and every social provider off", () => {
    const environment = loadEnvironment(mariaDbPreview);
    expect(environment.AUTH_DATABASE_EXTENSIONS).toBe("none");
    expect(environment.CLASS_CHAT_DATABASE_INSTALLED).toBe(false);
    expect([
      environment.SOCIAL_AUTH_ENABLED,
      environment.SOCIAL_GOOGLE_ENABLED,
      environment.SOCIAL_NAVER_ENABLED,
      environment.SOCIAL_KAKAO_ENABLED,
    ]).toEqual([false, false, false, false]);
  });

  it("rejects unknown installation values instead of passing them through", () => {
    expect(issuePaths({ ...mariaDbPreview, AUTH_DATABASE_EXTENSIONS: "app_help_chat_v1" })).toEqual(
      ["AUTH_DATABASE_EXTENSIONS"],
    );
  });

  it("refuses MariaDB passkeys until the passkey extension is installed", () => {
    expect(issuePaths({ ...mariaDbPreview, ...passkeys })).toContain("AUTH_DATABASE_EXTENSIONS");
    for (const installed of ["passkeys", "all"])
      expect(
        issuePaths({ ...mariaDbPreview, ...passkeys, AUTH_DATABASE_EXTENSIONS: installed }),
      ).not.toContain("AUTH_DATABASE_EXTENSIONS");
    expect(
      issuePaths({ ...mariaDbPreview, ...passkeys, AUTH_DATABASE_EXTENSIONS: "social" }),
    ).toContain("AUTH_DATABASE_EXTENSIONS");
  });

  it("refuses MariaDB social login until the social extension is installed", () => {
    expect(issuePaths({ ...mariaDbPreview, ...mockSocial })).toContain("AUTH_DATABASE_EXTENSIONS");
    expect(
      issuePaths({ ...mariaDbPreview, ...mockSocial, AUTH_DATABASE_EXTENSIONS: "social" }),
    ).toEqual([]);
  });

  it("allows real providers on loopback http only in development (2026-10-01 local test)", () => {
    const realGoogle = {
      ...mariaDbPreview,
      AUTH_DATABASE_EXTENSIONS: "social",
      SOCIAL_AUTH_ENABLED: "true",
      SOCIAL_GOOGLE_ENABLED: "true",
      SOCIAL_GOOGLE_CLIENT_ID: "synthetic-client",
      SOCIAL_GOOGLE_CLIENT_SECRET: "synthetic-secret",
      SOCIAL_AUTH_FLOW_KEY: Buffer.alloc(32, 5).toString("base64url"),
      PUBLIC_APP_ORIGIN: "http://localhost:5174",
      PUBLIC_API_ORIGIN: "http://localhost:5174",
    };
    expect(issuePaths(realGoogle)).toEqual([]);
    expect(
      issuePaths({
        ...realGoogle,
        PUBLIC_APP_ORIGIN: "https://changing-words.trycloudflare.com",
        PUBLIC_API_ORIGIN: "https://changing-words.trycloudflare.com",
      }),
    ).toContain("SOCIAL_AUTH_ENABLED");
    expect(
      issuePaths({
        ...realGoogle,
        PUBLIC_APP_ORIGIN: "http://example.test",
        PUBLIC_API_ORIGIN: "http://example.test",
      }),
    ).toContain("SOCIAL_AUTH_ENABLED");
    expect(issuePaths({ ...realGoogle, NODE_ENV: "test" })).toContain("SOCIAL_AUTH_ENABLED");
  });

  it("treats blank server-bundle social settings as unset (docker compose passes ${NAME:-})", () => {
    const blankSocial = {
      ...mariaDbPreview,
      AUTH_DATABASE_EXTENSIONS: "all",
      SOCIAL_AUTH_ENABLED: "false",
      SOCIAL_GOOGLE_CLIENT_ID: "",
      SOCIAL_GOOGLE_CLIENT_SECRET: " ",
      SOCIAL_NAVER_CLIENT_ID: "",
      SOCIAL_NAVER_CLIENT_SECRET: "",
      SOCIAL_KAKAO_CLIENT_ID: "",
      SOCIAL_KAKAO_CLIENT_SECRET: "",
      SOCIAL_AUTH_FLOW_KEY: "",
    };
    const environment = loadEnvironment(blankSocial);
    expect(environment.SOCIAL_GOOGLE_CLIENT_ID).toBeUndefined();
    expect(environment.SOCIAL_GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(environment.SOCIAL_AUTH_FLOW_KEY).toBeUndefined();
    // 켠 제공자의 키나 흐름 키가 비어 있으면 여전히 거절한다.
    expect(
      issuePaths({
        ...blankSocial,
        SOCIAL_AUTH_ENABLED: "true",
        SOCIAL_GOOGLE_ENABLED: "true",
        PUBLIC_APP_ORIGIN: "http://localhost:5174",
        PUBLIC_API_ORIGIN: "http://localhost:5174",
      }),
    ).toEqual(expect.arrayContaining(["SOCIAL_AUTH_FLOW_KEY", "SOCIAL_GOOGLE_CLIENT_ID"]));
    expect(issuePaths({ ...blankSocial, SOCIAL_AUTH_FLOW_KEY: "too-short" })).toEqual([
      "SOCIAL_AUTH_FLOW_KEY",
    ]);
  });

  it("keeps an installed extension selectable while its feature stays off", () => {
    const environment = loadEnvironment({
      ...mariaDbPreview,
      AUTH_DATABASE_EXTENSIONS: "all",
      CLASS_CHAT_DATABASE_INSTALLED: "true",
    });
    expect(environment.ADMIN_PASSKEYS_ENABLED).toBe(false);
    expect(environment.SOCIAL_AUTH_ENABLED).toBe(false);
    expect(environment.AUTH_DATABASE_EXTENSIONS).toBe("all");
    expect(environment.CLASS_CHAT_DATABASE_INSTALLED).toBe(true);
  });

  it("refuses profile photos until the photo table is installed, and keeps it off by default", () => {
    const environment = loadEnvironment(mariaDbPreview);
    expect(environment.PROFILE_PHOTOS_ENABLED).toBe(false);
    expect(environment.PROFILE_PHOTOS_DATABASE_INSTALLED).toBe(false);
    expect(issuePaths({ ...mariaDbPreview, PROFILE_PHOTOS_ENABLED: "true" })).toContain(
      "PROFILE_PHOTOS_DATABASE_INSTALLED",
    );
    expect(
      issuePaths({
        ...mariaDbPreview,
        PROFILE_PHOTOS_ENABLED: "true",
        PROFILE_PHOTOS_DATABASE_INSTALLED: "true",
      }),
    ).toEqual([]);
    expect(issuePaths({ ...mariaDbPreview, PROFILE_PHOTOS_DATABASE_INSTALLED: "true" })).toEqual(
      [],
    );
  });

  it("refuses MariaDB class chat until its tables are installed", () => {
    expect(issuePaths({ ...mariaDbPreview, CLASS_CHAT_ENABLED: "true" })).toContain(
      "CLASS_CHAT_DATABASE_INSTALLED",
    );
    expect(
      issuePaths({
        ...mariaDbPreview,
        CLASS_CHAT_ENABLED: "true",
        CLASS_CHAT_DATABASE_INSTALLED: "true",
      }),
    ).toEqual([]);
  });

  it("forbids the mock identity provider in production and requires a flow key", () => {
    expect(
      issuePaths({
        ...mariaDbPreview,
        ...mockSocial,
        AUTH_DATABASE_EXTENSIONS: "social",
        SOCIAL_AUTH_FLOW_KEY: undefined,
      }),
    ).toContain("SOCIAL_AUTH_FLOW_KEY");
    expect(
      issuePaths({
        ...mockSocial,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://classhub_app:p@db.internal:5432/classhub?sslmode=verify-full",
        EMAIL_HMAC_KEY: "production-placeholder-key-at-least-32-bytes",
        REDIS_URL: "rediss://redis.internal:6380",
      }),
    ).toContain("SOCIAL_AUTH_MOCK_ISSUER");
  });
});
