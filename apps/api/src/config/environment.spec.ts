import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadEnvironment } from "./environment.js";

const PRODUCTION_ENVIRONMENT_BASE = {
  DATABASE_URL:
    "postgresql://classhub_app:production-placeholder@db.internal:5432/classhub?sslmode=verify-full",
  EMAIL_HMAC_KEY: "production-placeholder-key-at-least-32-bytes",
  NODE_ENV: "production",
  REDIS_URL: "rediss://redis.internal:6380",
  SMTP_HOST: "smtp.internal",
  SMTP_PASSWORD: "synthetic-production-password",
  SMTP_PORT: "587",
  SMTP_REQUIRE_TLS: "true",
  SMTP_SECURE: "false",
  SMTP_USERNAME: "synthetic-production-user",
  TRUSTED_PROXY_HOPS: "1",
} as const;

const VALID_PRODUCTION_ENVIRONMENT = {
  ...PRODUCTION_ENVIRONMENT_BASE,
  PUBLIC_API_ORIGIN: "https://classhub.example",
  PUBLIC_APP_ORIGIN: "https://classhub.example",
} as const;

const VALID_TEST_ENVIRONMENT = {
  DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
  EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
  NODE_ENV: "test",
  PUBLIC_API_ORIGIN: "https://classhub.test",
  PUBLIC_APP_ORIGIN: "https://classhub.test",
  REDIS_URL: "redis://127.0.0.1:6379",
} as const;

function getEnvironmentIssues(input: Record<string, unknown>) {
  try {
    loadEnvironment(input);
  } catch (error) {
    if (error instanceof ZodError) return error.issues;
    throw error;
  }

  throw new Error("환경 검증이 실패해야 합니다.");
}

describe("loadEnvironment", () => {
  it.each([undefined, "", "   "])("allows an unconfigured NEIS key (%s)", (key) => {
    expect(
      loadEnvironment({ NODE_ENV: "development", NEIS_API_KEY: key }).NEIS_API_KEY,
    ).toBeUndefined();
  });

  it("requires NODE_ENV instead of silently assuming development", () => {
    const issues = getEnvironmentIssues({});

    expect(issues).toEqual([
      expect.objectContaining({
        path: ["NODE_ENV"],
      }),
    ]);
  });

  it("accepts matching PWA and API hostnames", () => {
    const environment = loadEnvironment({
      NODE_ENV: "development",
      PUBLIC_APP_ORIGIN: "https://classhub.example",
      PUBLIC_API_ORIGIN: "https://classhub.example",
    });

    expect(environment.API_PORT).toBe(3000);
    expect(environment.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(environment.SMTP_PORT).toBe(1025);
    expect(environment.SMTP_REQUIRE_TLS).toBe(false);
    expect(environment.TERMS_POLICY_VERSION).toBe("2026-07-11");
  });

  it("keeps the local HTTP defaults in development", () => {
    const environment = loadEnvironment({ NODE_ENV: "development" });

    expect(environment.PUBLIC_APP_ORIGIN).toBe("http://localhost:5174");
    expect(environment.PUBLIC_API_ORIGIN).toBe("http://localhost:5174");
  });

  it("accepts explicit hardened values and ephemeral plaintext dependencies in test", () => {
    const environment = loadEnvironment(VALID_TEST_ENVIRONMENT);

    expect(environment.ATTENDANCE_NOTIFICATIONS_ENABLED).toBe(false);
    expect(environment.CONTENT_SELECTED_AUDIENCE_ENABLED).toBe(false);
    expect(environment.NODE_ENV).toBe("test");
    expect(environment.PASSWORD_RESET_ENABLED).toBe(true);
    expect(environment.POLLS_ENABLED).toBe(false);
    expect(environment.STUDENT_ASSESSMENTS_ENABLED).toBe(false);
    expect(environment.ADMIN_WEB_ENABLED).toBe(false);
    expect(environment.PUBLIC_APP_ORIGIN).toBe("https://classhub.test");
    expect(environment.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("requires an explicit 32-byte versioned MFA key when admin web is enabled", () => {
    const issues = getEnvironmentIssues({
      ...VALID_TEST_ENVIRONMENT,
      ADMIN_WEB_ENABLED: "true",
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["ADMIN_MFA_ENCRYPTION_KEY"] }),
        expect.objectContaining({ path: ["ADMIN_MFA_KEY_VERSION"] }),
      ]),
    );

    const environment = loadEnvironment({
      ...VALID_TEST_ENVIRONMENT,
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      ADMIN_MFA_KEY_VERSION: "test-1",
      ADMIN_WEB_ENABLED: "true",
    });
    expect(environment.ADMIN_WEB_ENABLED).toBe(true);
    expect(environment.ADMIN_MFA_KEY_VERSION).toBe("test-1");

    expect(() =>
      loadEnvironment({
        ...VALID_TEST_ENVIRONMENT,
        ADMIN_MFA_ENCRYPTION_KEY: `${Buffer.alloc(32, 7).toString("base64url").slice(0, -1)}B`,
        ADMIN_MFA_KEY_VERSION: "test-1",
        ADMIN_WEB_ENABLED: "true",
      }),
    ).toThrow();
  });

  describe("production admin web (BACKLOG 28 approval, 2026-10-08)", () => {
    const PRODUCTION_ADMIN = {
      ...PRODUCTION_ENVIRONMENT_BASE,
      ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      ADMIN_MFA_KEY_VERSION: "production-1",
      ADMIN_WEB_ENABLED: "true",
      API_SURFACE: "admin",
      PUBLIC_API_ORIGIN: "https://admin.classhub.example",
      PUBLIC_APP_ORIGIN: "https://admin.classhub.example",
      USER_APP_ORIGIN: "https://classhub.example",
    } as const;

    it("allows the administrator-only program on its own host", () => {
      const environment = loadEnvironment(PRODUCTION_ADMIN);

      expect(environment.ADMIN_WEB_ENABLED).toBe(true);
      expect(environment.API_SURFACE).toBe("admin");
    });

    it.each(["all", "user"])("refuses admin web in the %s program", (surface) => {
      expect(() =>
        loadEnvironment({
          ...PRODUCTION_ADMIN,
          API_SURFACE: surface,
          PUBLIC_API_ORIGIN: "https://classhub.example",
          PUBLIC_APP_ORIGIN: "https://classhub.example",
        }),
      ).toThrow(/API_SURFACE/u);
    });

    it.each(["https://admin.classhub.example", "https://admin.classhub.example:8443"])(
      "refuses admin web on the user screen host (%s)",
      (userOrigin) => {
        expect(() => loadEnvironment({ ...PRODUCTION_ADMIN, USER_APP_ORIGIN: userOrigin })).toThrow(
          "다른 호스트에서만",
        );
      },
    );
  });

  it.each([
    "ATTENDANCE_NOTIFICATIONS_ENABLED",
    "CONTENT_SELECTED_AUDIENCE_ENABLED",
    "POLLS_ENABLED",
    "STUDENT_ASSESSMENTS_ENABLED",
  ] as const)("keeps %s inside explicit non-production fixtures", (featureName) => {
    const enabledTestEnvironment = loadEnvironment({
      ...VALID_TEST_ENVIRONMENT,
      [featureName]: "true",
    });

    expect(enabledTestEnvironment[featureName]).toBe(true);
    expect(
      loadEnvironment({
        NODE_ENV: "development",
        LOCAL_TEST_ADMIN_ENABLED: "true",
        LOCAL_TEST_ADMIN_OPERATOR_EMAIL: "operator@example.com",
        LOCAL_TEST_ADMIN_DATABASE_URL:
          "postgresql://classhub_local_admin:local_admin_db_password@127.0.0.1:5432/classhub_dev",
        LOCAL_TEST_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$synthetic",
        LOCAL_TEST_ADMIN_USERNAME: "local-operator",
        [featureName]: "true",
      })[featureName],
    ).toBe(true);
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        [featureName]: "true",
      }),
    ).toThrow(
      `${featureName} can only be enabled in NODE_ENV=test or an explicit development local-test-admin fixture.`,
    );
  });

  it.each(["ATTENDANCE_NOTIFICATIONS_ENABLED", "POLLS_ENABLED", "ELECTIONS_ENABLED"] as const)(
    "allows %s in an explicit native MariaDB preview while rejecting a remote database",
    (featureName) => {
      const preview = {
        NODE_ENV: "development",
        DATABASE_ENGINE: "mariadb",
        DATABASE_URL: "mariadb://classhub_app:synthetic@localhost:13307/classhub_dev",
        DATABASE_TLS_CA_FILE: "synthetic-ca.pem",
        DATABASE_ACCOUNT_HOST: "%",
        [featureName]: "true",
      };
      expect(loadEnvironment(preview)[featureName]).toBe(true);
      expect(() =>
        loadEnvironment({
          ...preview,
          DATABASE_URL:
            "mariadb://classhub_app:synthetic@database.example.invalid:13307/classhub_dev",
        }),
      ).toThrow();
      expect(() => loadEnvironment({ ...preview, API_HOST: "0.0.0.0" })).toThrow();
      expect(() =>
        loadEnvironment({ ...VALID_PRODUCTION_ENVIRONMENT, [featureName]: "true" }),
      ).toThrow();
    },
  );

  describe("WEB_PUSH_ENABLED", () => {
    // RFC 8291 부록 A의 합성 키 쌍(운영 키 아님).
    const keys = {
      WEB_PUSH_VAPID_PUBLIC_KEY:
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      WEB_PUSH_VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      WEB_PUSH_SUBJECT: "mailto:operator@example.com",
    };
    const preview = {
      NODE_ENV: "development",
      DATABASE_ENGINE: "mariadb",
      DATABASE_URL: "mariadb://classhub_app:synthetic@localhost:13307/classhub_dev",
      DATABASE_TLS_CA_FILE: "synthetic-ca.pem",
      DATABASE_ACCOUNT_HOST: "%",
      WEB_PUSH_ENABLED: "true",
      ...keys,
    };

    it("is off by default and allowed with matching keys in a native MariaDB preview", () => {
      expect(loadEnvironment(VALID_TEST_ENVIRONMENT).WEB_PUSH_ENABLED).toBe(false);
      expect(loadEnvironment(preview).WEB_PUSH_ENABLED).toBe(true);
    });

    it("requires both keys and a contact subject", () => {
      for (const missing of Object.keys(keys)) {
        const input: Record<string, unknown> = { ...preview };
        delete input[missing];
        expect(() => loadEnvironment(input)).toThrow(
          "WEB_PUSH_ENABLED=true이면 VAPID 공개키·비밀키와 WEB_PUSH_SUBJECT가 필요합니다.",
        );
      }
    });

    it("rejects a public key that does not belong to the private key without echoing keys", () => {
      const issues = getEnvironmentIssues({
        ...preview,
        WEB_PUSH_VAPID_PUBLIC_KEY:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      });
      expect(issues.map((issue) => issue.message)).toContain(
        "VAPID 공개키가 비밀키와 짝이 맞지 않습니다.",
      );
      expect(JSON.stringify(issues)).not.toContain(keys.WEB_PUSH_VAPID_PRIVATE_KEY);
    });

    it("rejects malformed subjects", () => {
      for (const subject of ["operator@example.com", "http://example.com", "mailto:"]) {
        expect(() => loadEnvironment({ ...preview, WEB_PUSH_SUBJECT: subject })).toThrow();
      }
    });

    it("stays blocked in production and outside explicit fixtures", () => {
      expect(() =>
        loadEnvironment({ ...VALID_PRODUCTION_ENVIRONMENT, WEB_PUSH_ENABLED: "true", ...keys }),
      ).toThrow("WEB_PUSH_ENABLED는 승인 전 production 환경에서 활성화할 수 없습니다.");
      expect(() =>
        loadEnvironment({ NODE_ENV: "development", WEB_PUSH_ENABLED: "true", ...keys }),
      ).toThrow("WEB_PUSH_ENABLED can only be enabled in NODE_ENV=test");
    });
  });

  it("allows the approved selected-audience capability to be explicitly enabled in production", () => {
    const environment = loadEnvironment({
      ...VALID_PRODUCTION_ENVIRONMENT,
      CONTENT_SELECTED_AUDIENCE_ENABLED: "true",
    });

    expect(environment.CONTENT_SELECTED_AUDIENCE_ENABLED).toBe(true);
  });

  it.each([
    "ATTENDANCE_NOTIFICATIONS_ENABLED",
    "POLLS_ENABLED",
    "STUDENT_ASSESSMENTS_ENABLED",
  ] as const)("keeps %s blocked in production", (featureName) => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        [featureName]: "true",
      }),
    ).toThrow(`${featureName}는 승인 전 production 환경에서 활성화할 수 없습니다.`);
  });

  it("rejects development defaults in test", () => {
    const issues = getEnvironmentIssues({ NODE_ENV: "test" });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["PUBLIC_APP_ORIGIN"] }),
        expect.objectContaining({ path: ["PUBLIC_API_ORIGIN"] }),
        expect.objectContaining({ path: ["DATABASE_URL"] }),
        expect.objectContaining({ path: ["EMAIL_HMAC_KEY"] }),
      ]),
    );
  });

  it("accepts explicit HTTPS origins and encrypted dependencies in production", () => {
    const environment = loadEnvironment(VALID_PRODUCTION_ENVIRONMENT);

    expect(environment.PUBLIC_APP_ORIGIN).toBe("https://classhub.example");
    expect(environment.PUBLIC_API_ORIGIN).toBe("https://classhub.example");
    expect(environment.SMTP_REQUIRE_TLS).toBe(true);
    expect(environment.SMTP_SECURE).toBe(false);
    expect(environment.SMTP_USERNAME).toBe("synthetic-production-user");
    expect(environment.TRUSTED_PROXY_HOPS).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["zero", "0"],
  ] as const)("rejects %s trusted proxy hops in production", (_label, proxyHops) => {
    const input: Record<string, unknown> = { ...VALID_PRODUCTION_ENVIRONMENT };
    if (proxyHops === undefined) delete input.TRUSTED_PROXY_HOPS;
    else input.TRUSTED_PROXY_HOPS = proxyHops;

    expect(getEnvironmentIssues(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "production TRUSTED_PROXY_HOPS는 실제 reverse proxy topology에 맞는 1 이상의 값이어야 합니다.",
          path: ["TRUSTED_PROXY_HOPS"],
        }),
      ]),
    );
  });

  it("rejects the reviewer probe's plaintext production transports", () => {
    const issues = getEnvironmentIssues({
      DATABASE_URL:
        "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=disable",
      EMAIL_HMAC_KEY: "synthetic-key-that-is-longer-than-32-bytes",
      NODE_ENV: "production",
      PUBLIC_API_ORIGIN: "https://classhub.example",
      PUBLIC_APP_ORIGIN: "https://classhub.example",
      REDIS_URL: "redis://redis.internal:6379",
      SMTP_HOST: "smtp.internal",
      SMTP_PORT: "25",
      SMTP_SECURE: "false",
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["DATABASE_URL"] }),
        expect.objectContaining({ path: ["REDIS_URL"] }),
        expect.objectContaining({ path: ["SMTP_REQUIRE_TLS"] }),
        expect.objectContaining({ path: ["SMTP_USERNAME"] }),
        expect.objectContaining({ path: ["SMTP_PASSWORD"] }),
      ]),
    );
  });

  it.each([
    ["a missing sslmode", "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub"],
    [
      "sslmode=disable",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=disable",
    ],
    [
      "sslmode=require",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=require",
    ],
    [
      "sslmode=verify-ca",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-ca",
    ],
    [
      "the reviewer libpq downgrade",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=require&uselibpqcompat=true",
    ],
    [
      "multiple sslmode values",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&sslmode=verify-full",
    ],
    [
      "uppercase SSLMODE",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?SSLMODE=verify-full",
    ],
    [
      "an explicit ssl switch",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&ssl=1",
    ],
    [
      "a rejectUnauthorized override",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&rejectUnauthorized=false",
    ],
    [
      "an unknown query option",
      "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full&service=privileged-service",
    ],
  ])("rejects production PostgreSQL with %s", (_label, databaseUrl) => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow("canonical sslmode=verify-full");
  });

  it("rejects a non-PostgreSQL production DATABASE_URL", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        DATABASE_URL: "https://db.internal/classhub?sslmode=verify-full",
      }),
    ).toThrow("DATABASE_URL must be a PostgreSQL URL");
  });

  it("rejects a mismatched production database role", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        DATABASE_URL:
          "postgresql://classhub_migrator:password@db.internal/classhub?sslmode=verify-full",
      }),
    ).toThrow("classhub_app database role");
  });

  it.each([
    [
      "a loopback hostname",
      "postgresql://classhub_app:password@127.0.0.1/classhub?sslmode=verify-full",
    ],
    ["a missing password", "postgresql://classhub_app@db.internal/classhub?sslmode=verify-full"],
  ])("rejects production PostgreSQL authority with %s", (_label, databaseUrl) => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow("explicit remote hostname, nonblank password, and database name");
  });

  it.each([
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0", "NODE_TLS_REJECT_UNAUTHORIZED"],
    ["PGSSLMODE", "disable", "PGSSL*"],
  ] as const)("rejects the runtime %s override in production", (key, value, message) => {
    const originalValue = process.env[key];
    process.env[key] = value;

    try {
      expect(() => loadEnvironment(VALID_PRODUCTION_ENVIRONMENT)).toThrow(message);
    } finally {
      if (originalValue === undefined) delete process.env[key];
      else process.env[key] = originalValue;
    }
  });

  it("rejects plaintext Redis in production, including loopback", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toThrow("production REDIS_URL은 rediss:// URL이어야 합니다.");
  });

  it("requires SMTP transport encryption in production", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        SMTP_REQUIRE_TLS: "false",
        SMTP_SECURE: "false",
      }),
    ).toThrow("production SMTP는 SMTP_SECURE 또는 SMTP_REQUIRE_TLS를 활성화해야 합니다.");
  });

  it("requires nonblank SMTP authentication in production", () => {
    const issues = getEnvironmentIssues({
      ...VALID_PRODUCTION_ENVIRONMENT,
      SMTP_PASSWORD: undefined,
      SMTP_USERNAME: undefined,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["SMTP_USERNAME"] }),
        expect.objectContaining({ path: ["SMTP_PASSWORD"] }),
      ]),
    );
  });

  it.each([
    ["SMTP_USERNAME", "username-only"],
    ["SMTP_PASSWORD", "password-only"],
  ] as const)("rejects partial SMTP auth when only %s is configured", (key, value) => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        [key]: value,
      }),
    ).toThrow("SMTP_USERNAME과 SMTP_PASSWORD는 함께 설정하거나 모두 생략해야 합니다.");
  });

  it("continues to allow different production ports on the same hostname", () => {
    const environment = loadEnvironment({
      ...VALID_PRODUCTION_ENVIRONMENT,
      PUBLIC_API_ORIGIN: "https://classhub.example:8443",
    });

    expect(environment.PUBLIC_API_ORIGIN).toBe("https://classhub.example:8443");
  });

  it("rejects different PWA and API hostnames", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        PUBLIC_APP_ORIGIN: "https://classhub.example",
        PUBLIC_API_ORIGIN: "https://api.classhub.example",
      }),
    ).toThrow("PWA와 API의 배포 hostname은 같아야 합니다.");
  });

  it.each([
    ["PUBLIC_APP_ORIGIN", "http://classhub.example"],
    ["PUBLIC_API_ORIGIN", "ftp://classhub.example"],
  ] as const)("rejects a non-HTTPS %s outside development", (key, value) => {
    const issues = getEnvironmentIssues({
      ...VALID_PRODUCTION_ENVIRONMENT,
      [key]: value,
    });

    expect(issues).toEqual([
      expect.objectContaining({
        message: `${key}은 development 외 환경에서 https여야 합니다.`,
        path: [key],
      }),
    ]);
  });

  it("rejects both development origin defaults in production", () => {
    const issues = getEnvironmentIssues(PRODUCTION_ENVIRONMENT_BASE);

    expect(issues).toEqual([
      expect.objectContaining({
        message: "PUBLIC_APP_ORIGIN의 개발 기본값을 development 외 환경에서 사용할 수 없습니다.",
        path: ["PUBLIC_APP_ORIGIN"],
      }),
      expect.objectContaining({
        message: "PUBLIC_API_ORIGIN의 개발 기본값을 development 외 환경에서 사용할 수 없습니다.",
        path: ["PUBLIC_API_ORIGIN"],
      }),
    ]);
  });

  it("rejects wildcard public origin hostnames", () => {
    const issues = getEnvironmentIssues({
      ...VALID_PRODUCTION_ENVIRONMENT,
      PUBLIC_API_ORIGIN: "https://*.classhub.example",
      PUBLIC_APP_ORIGIN: "https://*.classhub.example",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        message: "PUBLIC_APP_ORIGIN에는 wildcard hostname을 사용할 수 없습니다.",
        path: ["PUBLIC_APP_ORIGIN"],
      }),
      expect.objectContaining({
        message: "PUBLIC_API_ORIGIN에는 wildcard hostname을 사용할 수 없습니다.",
        path: ["PUBLIC_API_ORIGIN"],
      }),
    ]);
  });

  it("rejects a non-Redis URL for the Redis connection", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        REDIS_URL: "https://redis.example",
      }),
    ).toThrow("REDIS_URL은 redis:// 또는 rediss:// URL이어야 합니다.");
  });

  it("rejects an email HMAC key shorter than 32 characters", () => {
    expect(() =>
      loadEnvironment({ NODE_ENV: "development", EMAIL_HMAC_KEY: "too-short" }),
    ).toThrow();
  });

  it("rejects the local test admin module in production", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        LOCAL_TEST_ADMIN_ENABLED: "true",
      }),
    ).toThrow("로컬 테스트 관리 기능은 development에서만 활성화할 수 있습니다.");
  });

  it("rejects a local test admin database URL in production even when disabled", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        LOCAL_TEST_ADMIN_DATABASE_URL:
          "postgresql://classhub_local_admin:secret@db.internal:5432/classhub",
      }),
    ).toThrow("development 외 환경에는 로컬 테스트 관리자 DB 연결을 설정할 수 없습니다.");
  });

  it("rejects the public development HMAC key in production", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        EMAIL_HMAC_KEY: undefined,
      }),
    ).toThrow("development 외 환경에서는 EMAIL_HMAC_KEY를 안전한 secret으로 설정해야 합니다.");
  });

  it("rejects the development database URL in production", () => {
    expect(() =>
      loadEnvironment({
        ...VALID_PRODUCTION_ENVIRONMENT,
        DATABASE_URL: undefined,
      }),
    ).toThrow("development 외 환경에서는 DATABASE_URL을 안전한 환경값으로 설정해야 합니다.");
  });

  it("requires local credentials when the local test admin is enabled", () => {
    expect(() =>
      loadEnvironment({ NODE_ENV: "development", LOCAL_TEST_ADMIN_ENABLED: "true" }),
    ).toThrow("LOCAL_TEST_ADMIN_OPERATOR_EMAIL은 로컬 테스트 관리자 활성화 시 필수입니다.");
  });

  it("requires a dedicated local-admin database role when the tool is enabled", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        LOCAL_TEST_ADMIN_DATABASE_URL:
          "postgresql://classhub_app:local_app_password@127.0.0.1:5432/classhub_dev",
        LOCAL_TEST_ADMIN_ENABLED: "true",
        LOCAL_TEST_ADMIN_OPERATOR_EMAIL: "admin@classhub.local",
        LOCAL_TEST_ADMIN_PASSWORD_HASH:
          "$argon2id$v=19$m=65536,t=3,p=1$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        LOCAL_TEST_ADMIN_USERNAME: "admin",
      }),
    ).toThrow("로컬 테스트 관리자는 classhub_local_admin DB role을 사용해야 합니다.");
  });
});

it("validates installed library grants independently of feature opening", () => {
  expect(loadEnvironment({ NODE_ENV: "development" }).TEACHER_LIBRARY_DATABASE_INSTALLED).toBe(
    false,
  );
  expect(
    loadEnvironment({ NODE_ENV: "development", TEACHER_LIBRARY_DATABASE_INSTALLED: "true" })
      .TEACHER_LIBRARY_DATABASE_INSTALLED,
  ).toBe(true);
  expect(
    getEnvironmentIssues({ NODE_ENV: "development", TEACHER_LIBRARY_DATABASE_INSTALLED: "yes" }),
  ).toEqual([expect.objectContaining({ path: ["TEACHER_LIBRARY_DATABASE_INSTALLED"] })]);
});
