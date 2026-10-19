import { describe, expect, it } from "vitest";
import { loadEnvironment } from "./environment.js";
const qa = {
  NODE_ENV: "development",
  NATIVE_ASSESSMENT_QA_ENABLED: "true",
  LOCAL_TEST_ADMIN_ENABLED: "false",
  PUBLIC_PREVIEW_ENABLED: "false",
  API_HOST: "127.0.0.1",
  API_PORT: "3010",
  PUBLIC_APP_ORIGIN: "http://localhost:5176",
  PUBLIC_API_ORIGIN: "http://localhost:5176",
  DATABASE_ENGINE: "mariadb",
  DATABASE_URL: "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev",
  DATABASE_TLS_MODE: "required",
  DATABASE_TLS_CA_FILE: "synthetic-ca.pem",
  DATABASE_ACCOUNT_HOST: "%",
  REDIS_URL: "redis://127.0.0.1:6380/1",
  STUDENT_ASSESSMENTS_ENABLED: "true",
  STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "false",
};
describe("dedicated native personal-assessment QA boundary", () => {
  it("accepts the native sandbox mariadb URL protocol under the same exact boundary", () => {
    expect(
      loadEnvironment({ ...qa, DATABASE_URL: qa.DATABASE_URL.replace("mysql:", "mariadb:") })
        .NATIVE_ASSESSMENT_QA_ENABLED,
    ).toBe(true);
  });
  it("accepts exact isolated synthetic profile without local administrator or class binding", () => {
    const e = loadEnvironment(qa);
    expect(e.NODE_ENV).toBe("development");
    expect(e.STUDENT_ASSESSMENTS_ENABLED).toBe(true);
    expect(e.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED).toBe(false);
    expect(e.LOCAL_TEST_ADMIN_ENABLED).toBe(false);
    expect(e.NATIVE_ASSESSMENT_QA_ENABLED).toBe(true);
  });
  it.each([
    ["NODE_ENV", "test"],
    ["NODE_ENV", "production"],
    ["LOCAL_TEST_ADMIN_ENABLED", "true"],
    ["PUBLIC_PREVIEW_ENABLED", "true"],
    ["API_HOST", "localhost"],
    ["API_HOST", "0.0.0.0"],
    ["API_PORT", "3000"],
    ["PUBLIC_APP_ORIGIN", "http://localhost:5174"],
    ["PUBLIC_API_ORIGIN", "http://localhost:5174"],
    ["PUBLIC_APP_ORIGIN", "https://localhost:5176"],
    ["PUBLIC_APP_ORIGIN", "http://localhost:5176/"],
    ["DATABASE_ENGINE", "postgres"],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3307/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3308/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@db.internal:3309/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@127.0.0.1:3309/classhub_mariadb_phase1_dev",
    ],
    ["DATABASE_URL", "mysql://classhub_app:synthetic-only@localhost:3309/classhub"],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev?x=1",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev#x",
    ],
    ["DATABASE_TLS_MODE", "disabled"],
    ["DATABASE_TLS_CA_FILE", " "],
    ["DATABASE_TLS_CA_FILE", undefined],
    ["REDIS_URL", "redis://127.0.0.1:6380/0"],
    ["REDIS_URL", "redis://127.0.0.1:6379/1"],
    ["STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED", "true"],
  ] as const)("rejects opt-in with mismatched %s=%s", (key, value) => {
    expect(() => loadEnvironment({ ...qa, [key]: value })).toThrow("Native assessment QA");
  });
  it("defaults to no exception and preserves normal development and production gates", () => {
    expect(loadEnvironment({ NODE_ENV: "development" }).NATIVE_ASSESSMENT_QA_ENABLED).toBe(false);
    expect(() => loadEnvironment({ ...qa, NATIVE_ASSESSMENT_QA_ENABLED: "false" })).toThrow(
      "STUDENT_ASSESSMENTS_ENABLED can only be enabled",
    );
    expect(() => loadEnvironment({ ...qa, NATIVE_ASSESSMENT_QA_ENABLED: undefined })).toThrow();
  });
  it("does not extend the exception to other features", () => {
    expect(() => loadEnvironment({ ...qa, CONTENT_SELECTED_AUDIENCE_ENABLED: "true" })).toThrow(
      "CONTENT_SELECTED_AUDIENCE_ENABLED can only be enabled",
    );
  });
});

const classQa = {
  ...qa,
  NATIVE_ASSESSMENT_QA_ENABLED: "false",
  NATIVE_CLASS_ASSESSMENT_QA_ENABLED: "true",
  API_SURFACE: "user",
  ADMIN_WEB_ENABLED: "false",
  STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "true",
};
describe("dedicated native class-assessment configuration boundary", () => {
  it("accepts only the explicit isolated user profile without claiming schema readiness", () => {
    const environment = loadEnvironment(classQa);
    expect(environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED).toBe(true);
    expect(environment.NATIVE_ASSESSMENT_QA_ENABLED).toBe(false);
    expect(environment.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED).toBe(true);
    expect(environment.API_SURFACE).toBe("user");
    expect(environment).not.toHaveProperty("schemaVerified");
    expect(
      loadEnvironment({
        ...classQa,
        DATABASE_URL: classQa.DATABASE_URL.replace("mysql:", "mariadb:"),
      }).NATIVE_CLASS_ASSESSMENT_QA_ENABLED,
    ).toBe(true);
  });
  it.each([
    ["NODE_ENV", "test"],
    ["NODE_ENV", "production"],
    ["LOCAL_TEST_ADMIN_ENABLED", "true"],
    ["PUBLIC_PREVIEW_ENABLED", "true"],
    ["API_HOST", "localhost"],
    ["API_HOST", "0.0.0.0"],
    ["API_PORT", "3000"],
    ["PUBLIC_APP_ORIGIN", "http://localhost:5174"],
    ["PUBLIC_API_ORIGIN", "http://localhost:5174"],
    ["PUBLIC_APP_ORIGIN", "https://localhost:5176"],
    ["PUBLIC_APP_ORIGIN", "http://localhost:5176/"],
    ["DATABASE_ENGINE", "postgres"],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3307/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3308/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@db.internal:3309/classhub_mariadb_phase1_dev",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@127.0.0.1:3309/classhub_mariadb_phase1_dev",
    ],
    ["DATABASE_URL", "mysql://classhub_app:synthetic-only@localhost:3309/classhub"],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev?x=1",
    ],
    [
      "DATABASE_URL",
      "mysql://classhub_app:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev#x",
    ],
    ["DATABASE_TLS_MODE", "disabled"],
    ["DATABASE_TLS_CA_FILE", " "],
    ["DATABASE_TLS_CA_FILE", undefined],
    ["REDIS_URL", "redis://127.0.0.1:6380/0"],
    ["REDIS_URL", "redis://127.0.0.1:6379/1"],
    ["STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED", "false"],
    ["STUDENT_ASSESSMENTS_ENABLED", "false"],
    ["NATIVE_ASSESSMENT_QA_ENABLED", "true"],
    ["API_SURFACE", "all"],
    ["API_SURFACE", "admin"],
    ["ADMIN_WEB_ENABLED", "true"],
    ["DATABASE_ACCOUNT_HOST", "localhost"],
    [
      "DATABASE_URL",
      "mysql://classhub_root:synthetic-only@localhost:3309/classhub_mariadb_phase1_dev",
    ],
  ] as const)("rejects class profile drift %s=%s", (key, value) => {
    expect(() => loadEnvironment({ ...classQa, [key]: value })).toThrow();
  });
  it("defaults off, forbids other feature exceptions and preserves personal QA", () => {
    expect(loadEnvironment({ NODE_ENV: "development" }).NATIVE_CLASS_ASSESSMENT_QA_ENABLED).toBe(
      false,
    );
    expect(loadEnvironment(qa).NATIVE_CLASS_ASSESSMENT_QA_ENABLED).toBe(false);
    expect(() =>
      loadEnvironment({ ...classQa, NATIVE_CLASS_ASSESSMENT_QA_ENABLED: "false" }),
    ).toThrow();
    expect(() =>
      loadEnvironment({ ...classQa, CONTENT_SELECTED_AUDIENCE_ENABLED: "true" }),
    ).toThrow();
    expect(() =>
      loadEnvironment({ ...classQa, ADMIN_MFA_ENCRYPTION_KEY: "synthetic-only" }),
    ).toThrow();
  });
});
