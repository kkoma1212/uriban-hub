import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { loadEnvironment } from "./environment.js";
import { parseMariaDbUrl } from "./mariadb-environment.js";

const mariaUrl = "mariadb://classhub_app:synthetic-secret@db.internal:3306/classhub";
const mariaDevelopment = {
  NODE_ENV: "development",
  DATABASE_ENGINE: "mariadb",
  DATABASE_URL: mariaUrl,
  DATABASE_TLS_CA_FILE: "/synthetic/ca.pem",
  DATABASE_ACCOUNT_HOST: "%",
};
const production = {
  ...mariaDevelopment,
  NODE_ENV: "production",
  PUBLIC_APP_ORIGIN: "https://classhub.example",
  PUBLIC_API_ORIGIN: "https://classhub.example",
  EMAIL_HMAC_KEY: "synthetic-hmac-key-at-least-32-bytes",
  REDIS_URL: "rediss://redis.internal:6380",
  SMTP_USERNAME: "synthetic-mail-user",
  SMTP_PASSWORD: "synthetic-mail-secret",
  SMTP_REQUIRE_TLS: "true",
  TRUSTED_PROXY_HOPS: "1",
};
const postgresProduction = {
  ...production,
  DATABASE_ENGINE: "postgres",
  DATABASE_URL:
    "postgresql://classhub_app:synthetic-secret@db.internal/classhub?sslmode=verify-full",
  DATABASE_TLS_CA_FILE: undefined,
  DATABASE_ACCOUNT_HOST: undefined,
};
function rejection(input: Record<string, unknown>, path: string) {
  let caught: unknown;
  try {
    loadEnvironment(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  expect((caught as ZodError).issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: [path] })]),
  );
  return caught as ZodError;
}

afterEach(() => vi.unstubAllEnvs());

describe("parseMariaDbUrl", () => {
  it.each(["mariadb", "mysql"])(
    "accepts an explicit %s URL and defaults to port 3306",
    (scheme) => {
      expect(
        parseMariaDbUrl(`${scheme}://classhub_app:synthetic-secret@db.internal/classhub`),
      ).toEqual({
        host: "db.internal",
        port: 3306,
        user: "classhub_app",
        password: "synthetic-secret",
        database: "classhub",
      });
    },
  );
  it("decodes credentials and the database exactly once without treating password punctuation as URL options", () => {
    expect(
      parseMariaDbUrl(
        "mariadb://classhub%5Fapp:p%40ss%3A%2F%3F%23%25%252F%ED%95%9C@db.internal:3307/classhub%5Ftest",
        "classhub_app",
      ),
    ).toEqual({
      host: "db.internal",
      port: 3307,
      user: "classhub_app",
      password: "p@ss:/?#%%2F한",
      database: "classhub_test",
    });
  });
  it.each([
    "postgresql://classhub_app:synthetic-secret@db.internal/classhub",
    "mariadb://classhub_app:synthetic-secret@127.0.0.1/classhub",
    "mariadb://classhub_app:synthetic-secret@[::1]/classhub",
    "mariadb://classhub_app:synthetic-secret@[2001:db8::1]/classhub",
    "mariadb://classhub_app:synthetic-secret@/classhub",
    "mariadb://classhub_app@db.internal/classhub",
    "mariadb://:synthetic-secret@db.internal/classhub",
    "mariadb://classhub_app:synthetic-secret@db.internal/",
    "mariadb://classhub_app:synthetic-secret@db.internal/classhub/other",
    "mariadb://classhub_app:synthetic-secret@db.internal:0/classhub",
    "mariadb://classhub_app:synthetic-secret@db.internal:65536/classhub",
    "mariadb://classhub_app:synthetic-secret%FF@db.internal/classhub",
    "mariadb://classhub_app:synthetic-secret%ZZ@db.internal/classhub",
  ])(
    "rejects malformed identity and non-DNS authorities without disclosing the input: %s",
    (value) => {
      let caught: unknown;
      try {
        parseMariaDbUrl(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toContain("MariaDB DATABASE_URL requires");
      expect(String(caught) + JSON.stringify(caught)).not.toMatch(
        /synthetic-secret|db\.internal|%FF|%ZZ/u,
      );
      expect(caught).not.toHaveProperty("cause");
    },
  );
  it.each([
    "?ssl=false",
    "?rejectUnauthorized=false",
    "?sslmode=disable",
    "?sslmode=verify-full",
    "?host=other.internal",
    "?multipleStatements=true",
    "#synthetic-secret",
  ])("rejects every URL option or fragment: %s", (suffix) => {
    expect(() => parseMariaDbUrl(mariaUrl + suffix)).toThrow("no URL options");
  });
  it("compares the decoded username to the requested production role", () => {
    expect(() =>
      parseMariaDbUrl(mariaUrl.replace("classhub_app", "classhub_worker"), "classhub_app"),
    ).toThrow("MariaDB DATABASE_URL requires");
  });
});

describe("MariaDB application environment", () => {
  it("preserves explicit URL, CA file, account host and pool size in MariaDB mode", () => {
    const input = {
      ...mariaDevelopment,
      DATABASE_ACCOUNT_HOST: "172.20.%",
      DATABASE_POOL_MAX: "4",
    };
    const environment = loadEnvironment(input);
    expect(environment).toMatchObject({
      ...mariaDevelopment,
      DATABASE_ACCOUNT_HOST: "172.20.%",
      DATABASE_POOL_MAX: 4,
    });
    expect(input.DATABASE_POOL_MAX).toBe("4");
  });
  it.each(["DATABASE_URL", "DATABASE_TLS_CA_FILE", "DATABASE_ACCOUNT_HOST"])(
    "requires explicit MariaDB %s",
    (name) => {
      rejection({ ...mariaDevelopment, [name]: undefined }, name);
      rejection({ ...mariaDevelopment, [name]: "" }, name);
    },
  );
  it.each(["other@host", "host name", "host\nname", "host' OR 1=1"])(
    "rejects malformed account-host identity: %s",
    (accountHost) => {
      rejection(
        { ...mariaDevelopment, DATABASE_ACCOUNT_HOST: accountHost },
        "DATABASE_ACCOUNT_HOST",
      );
    },
  );
  it("rejects PostgreSQL URLs and TLS query overrides in MariaDB mode", () => {
    for (const DATABASE_URL of [
      postgresProduction.DATABASE_URL,
      `${mariaUrl}?rejectUnauthorized=false`,
    ])
      rejection({ ...mariaDevelopment, DATABASE_URL }, "DATABASE_URL");
  });
  it("accepts MariaDB production with the application account and retains other production security checks", () => {
    expect(loadEnvironment(production)).toMatchObject({
      DATABASE_ENGINE: "mariadb",
      DATABASE_URL: mariaUrl,
    });
    rejection({ ...production, REDIS_URL: "redis://redis.internal" }, "REDIS_URL");
    rejection({ ...production, SMTP_REQUIRE_TLS: "false" }, "SMTP_REQUIRE_TLS");
    rejection({ ...production, TRUSTED_PROXY_HOPS: "0" }, "TRUSTED_PROXY_HOPS");
  });
  it.each(["classhub_worker", "classhub_operator", "root"])(
    "requires classhub_app in MariaDB production, rejecting %s",
    (user) => {
      rejection(
        { ...production, DATABASE_URL: mariaUrl.replace("classhub_app", user) },
        "DATABASE_URL",
      );
    },
  );
  it("allows a synthetic probe account only outside production", () => {
    const environment = loadEnvironment({
      ...mariaDevelopment,
      DATABASE_URL: mariaUrl.replace("classhub_app", "probe_app"),
    });
    expect(environment.DATABASE_URL).toContain("probe_app:");
  });
  it("does not expose either encoded or decoded credentials in configuration issues", () => {
    const error = rejection(
      {
        ...production,
        DATABASE_URL: "mariadb://wrong_role:private%2Fpassword%40secret@db.internal/classhub",
      },
      "DATABASE_URL",
    );
    expect(String(error) + JSON.stringify(error)).not.toMatch(
      /private|password%40|wrong_role|db\.internal/u,
    );
    expect(error).not.toHaveProperty("cause");
  });
  // new URL()이 던지는 TypeError는 입력 주소를 그대로 싣는다 — 읽을 수 없는 주소도 값 없이 거절해야 한다.
  it.each([
    "PUBLIC_APP_ORIGIN",
    "PUBLIC_API_ORIGIN",
    "USER_APP_ORIGIN",
    "DATABASE_URL",
    "REDIS_URL",
    "ADMIN_WORKER_PROCESSING_URL",
    "LOCAL_TEST_ADMIN_DATABASE_URL",
    "SOCIAL_AUTH_MOCK_ISSUER",
  ])("rejects an unreadable %s without echoing its credentials", (name) => {
    const error = rejection(
      {
        ...mariaDevelopment,
        LOCAL_TEST_ADMIN_ENABLED: "true",
        [name]: "scheme://leak_user:leak-secret@bad host:1/x",
      },
      name,
    );
    expect(String(error) + JSON.stringify(error) + inspect(error, { depth: 8 })).not.toMatch(
      /leak/u,
    );
  });
  it("rejects LOCAL_TEST_ADMIN even with a complete development fixture", () => {
    const error = rejection(
      {
        ...mariaDevelopment,
        LOCAL_TEST_ADMIN_ENABLED: "true",
        LOCAL_TEST_ADMIN_OPERATOR_EMAIL: "synthetic@example.com",
        LOCAL_TEST_ADMIN_USERNAME: "synthetic-admin",
        LOCAL_TEST_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$synthetic",
        LOCAL_TEST_ADMIN_DATABASE_URL:
          "postgresql://classhub_local_admin:synthetic@localhost/classhub_test",
      },
      "LOCAL_TEST_ADMIN_ENABLED",
    );
    expect(error.issues).toHaveLength(1);
    expect(error.message).toContain("unavailable with MariaDB");
  });
});

describe("unchanged PostgreSQL production environment validation", () => {
  it("still defaults to PostgreSQL and requires its verified TLS URL", () => {
    expect(
      loadEnvironment({ ...postgresProduction, DATABASE_ENGINE: undefined }).DATABASE_ENGINE,
    ).toBe("postgres");
    rejection(
      {
        ...postgresProduction,
        DATABASE_URL: postgresProduction.DATABASE_URL.replace("verify-full", "disable"),
      },
      "DATABASE_URL",
    );
    rejection(
      {
        ...postgresProduction,
        DATABASE_URL: postgresProduction.DATABASE_URL.replace("classhub_app", "classhub_worker"),
      },
      "DATABASE_URL",
    );
    rejection({ ...postgresProduction, DATABASE_URL: mariaUrl }, "DATABASE_URL");
  });
  it.each([
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ["PGSSLMODE", "disable"],
  ])("still rejects the PostgreSQL runtime TLS override %s", (name, value) => {
    vi.stubEnv(name, value);
    rejection(postgresProduction, "DATABASE_URL");
  });
});
