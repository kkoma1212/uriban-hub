import { describe, expect, it } from "vitest";

import { loadEnvironment } from "./environment.js";

// 2026-10-07 사용자 승인: DB·Redis가 같은 서버·내부망에 있을 때 운영자가 TLS 조건을 명시적으로 끌 수 있다.
// 기본값은 그대로 강제여야 하고, 끄는 값은 정확히 "disabled"만 받는다.
const production = {
  NODE_ENV: "production",
  PUBLIC_APP_ORIGIN: "https://classhub.example",
  PUBLIC_API_ORIGIN: "https://classhub.example",
  TRUSTED_PROXY_HOPS: "1",
  DATABASE_ENGINE: "mariadb",
  DATABASE_URL: "mariadb://classhub_app:synthetic_password@mariadb:3306/classhub",
  DATABASE_ACCOUNT_HOST: "%",
  REDIS_URL: "redis://redis:6379",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_REQUIRE_TLS: "true",
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@classhub.example",
  EMAIL_HMAC_KEY: "synthetic-email-hmac-key-0123456789abcdef",
  EMAIL_HMAC_KEY_VERSION: "prod-1",
};
const issues = (input: Record<string, string>) => {
  try {
    loadEnvironment(input);
    return [];
  } catch (error) {
    return (error as { issues: { path: string[] }[] }).issues.map((issue) => issue.path.join("."));
  }
};

describe("production TLS mode switches", () => {
  it("still requires the DB CA file and rediss:// by default", () => {
    expect(issues(production).sort()).toEqual(["DATABASE_TLS_CA_FILE", "REDIS_URL"]);
  });

  it("accepts a same-host DB and Redis without TLS only when both switches are explicitly disabled", () => {
    const environment = loadEnvironment({
      ...production,
      DATABASE_TLS_MODE: "disabled",
      REDIS_TLS_MODE: "disabled",
    });
    expect(environment.DATABASE_TLS_MODE).toBe("disabled");
    expect(environment.REDIS_TLS_MODE).toBe("disabled");
    expect(environment.DATABASE_TLS_CA_FILE).toBeUndefined();
  });

  it("keeps each switch independent", () => {
    expect(issues({ ...production, DATABASE_TLS_MODE: "disabled" })).toEqual(["REDIS_URL"]);
    expect(issues({ ...production, REDIS_TLS_MODE: "disabled" })).toEqual(["DATABASE_TLS_CA_FILE"]);
  });

  it("rejects a CA file left in place with DB TLS disabled, and any other switch value", () => {
    expect(
      issues({
        ...production,
        DATABASE_TLS_MODE: "disabled",
        REDIS_TLS_MODE: "disabled",
        DATABASE_TLS_CA_FILE: "/etc/classhub/ca.pem",
      }),
    ).toEqual(["DATABASE_TLS_CA_FILE"]);
    for (const value of ["off", "false", "none", "Disabled"]) {
      expect(issues({ ...production, DATABASE_TLS_MODE: value })).toContain("DATABASE_TLS_MODE");
      expect(issues({ ...production, REDIS_TLS_MODE: value })).toContain("REDIS_TLS_MODE");
    }
  });

  it("does not relax the other production requirements", () => {
    const disabled = { ...production, DATABASE_TLS_MODE: "disabled", REDIS_TLS_MODE: "disabled" };
    expect(issues({ ...disabled, PUBLIC_APP_ORIGIN: "http://classhub.example" })).toContain(
      "PUBLIC_APP_ORIGIN",
    );
    expect(issues({ ...disabled, SMTP_REQUIRE_TLS: "false" })).toContain("SMTP_REQUIRE_TLS");
    expect(
      issues({
        ...disabled,
        DATABASE_URL: "mariadb://root:synthetic_password@mariadb:3306/classhub",
      }),
    ).toContain("DATABASE_URL");
  });
});
