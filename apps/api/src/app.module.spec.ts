import { describe, expect, it } from "vitest";

import { AppModule, shouldIgnoreAppEnvironmentFiles } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";

function includesConfiguredModule(
  configuredModule: Awaited<ReturnType<typeof AppModule.configure>>["module"],
  moduleName: string,
): boolean {
  return (configuredModule.imports ?? []).some((moduleReference) => {
    if (typeof moduleReference === "function") return moduleReference.name === moduleName;
    if (
      typeof moduleReference === "object" &&
      moduleReference !== null &&
      "module" in moduleReference &&
      typeof moduleReference.module === "function"
    ) {
      return moduleReference.module.name === moduleName;
    }
    return false;
  });
}

describe("AppModule environment-file boundary", () => {
  it("registers administrator auth only behind its explicit switch", async () => {
    const disabled = await AppModule.configure(loadEnvironment({ NODE_ENV: "development" }));
    expect(includesConfiguredModule(disabled.module, "AdminAuthModule")).toBe(false);

    const enabled = await AppModule.configure(
      loadEnvironment({
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
        ADMIN_MFA_KEY_VERSION: "test-1",
        ADMIN_WEB_ENABLED: "true",
        DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
        EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
        NODE_ENV: "test",
        PUBLIC_API_ORIGIN: "https://classhub.test",
        PUBLIC_APP_ORIGIN: "https://classhub.test",
      }),
    );
    expect(includesConfiguredModule(enabled.module, "AdminAuthModule")).toBe(true);
    // 2026-09-26: 시범 동안 사용자 문의 접수 창구는 닫고(이메일로만), 관리자 문의 목록은 유지한다.
    expect(includesConfiguredModule(enabled.module, "SupportInquiriesModule")).toBe(false);
    expect(includesConfiguredModule(enabled.module, "AdminManagementModule")).toBe(true);
  });

  it.each([
    ["production", false, true],
    ["test", false, true],
    ["development", false, false],
    [undefined, false, false],
    ["development", true, true],
  ] as const)(
    "returns %s/%s -> %s",
    (explicitNodeEnvironment, hasEnvironmentOverride, expected) => {
      expect(shouldIgnoreAppEnvironmentFiles(explicitNodeEnvironment, hasEnvironmentOverride)).toBe(
        expected,
      );
    },
  );

  it("does not configure the local test admin module when it is disabled", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "development",
      LOCAL_TEST_ADMIN_ENABLED: "false",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "LocalTestAdminModule")).toBe(false);
  });

  it("does not register attendance notification routes by default", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "development",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "AttendanceNotificationsModule")).toBe(
      false,
    );
  });

  it("registers attendance notification routes only when explicitly enabled", async () => {
    const environment = loadEnvironment({
      ATTENDANCE_NOTIFICATIONS_ENABLED: "true",
      DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
      EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
      NODE_ENV: "test",
      PUBLIC_API_ORIGIN: "https://classhub.test",
      PUBLIC_APP_ORIGIN: "https://classhub.test",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "AttendanceNotificationsModule")).toBe(true);
  });

  it("does not register student assessment routes by default", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "development",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "StudentAssessmentsModule")).toBe(false);
  });

  it("registers student assessment routes only when explicitly enabled", async () => {
    const environment = loadEnvironment({
      DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
      EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
      NODE_ENV: "test",
      PUBLIC_API_ORIGIN: "https://classhub.test",
      PUBLIC_APP_ORIGIN: "https://classhub.test",
      STUDENT_ASSESSMENTS_ENABLED: "true",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "StudentAssessmentsModule")).toBe(true);
  });

  it("registers poll routes only when explicitly enabled", async () => {
    const disabled = await AppModule.configure(
      loadEnvironment({
        NODE_ENV: "development",
      }),
    );
    expect(includesConfiguredModule(disabled.module, "PollsModule")).toBe(false);

    const enabled = await AppModule.configure(
      loadEnvironment({
        DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
        EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
        NODE_ENV: "test",
        POLLS_ENABLED: "true",
        PUBLIC_API_ORIGIN: "https://classhub.test",
        PUBLIC_APP_ORIGIN: "https://classhub.test",
      }),
    );
    expect(includesConfiguredModule(enabled.module, "PollsModule")).toBe(true);
  });

  it("does not register retired seat draw routes even with an old enabled flag", async () => {
    const disabled = await AppModule.configure(
      loadEnvironment({
        NODE_ENV: "development",
      }),
    );
    expect(includesConfiguredModule(disabled.module, "SeatDrawsModule")).toBe(false);

    const enabled = await AppModule.configure(
      loadEnvironment({
        DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
        EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
        NODE_ENV: "test",
        PUBLIC_API_ORIGIN: "https://classhub.test",
        PUBLIC_APP_ORIGIN: "https://classhub.test",
        SEAT_DRAWS_ENABLED: "true",
      }),
    );
    expect(includesConfiguredModule(enabled.module, "SeatDrawsModule")).toBe(false);
    expect(includesConfiguredModule(enabled.module, "LayoutDraftsModule")).toBe(false);
    expect(includesConfiguredModule(enabled.module, "LayoutTemplatesModule")).toBe(false);
  });

  it("does not register retired grouping and duty routes even with old enabled flags", async () => {
    const disabled = await AppModule.configure(
      loadEnvironment({
        NODE_ENV: "development",
      }),
    );
    expect(includesConfiguredModule(disabled.module, "TeamDrawsModule")).toBe(false);

    const enabled = await AppModule.configure(
      loadEnvironment({
        DATABASE_URL: "postgresql://classhub_app:test-password@127.0.0.1:5432/classhub_test",
        EMAIL_HMAC_KEY: "test-placeholder-key-at-least-32-bytes",
        NODE_ENV: "test",
        PUBLIC_API_ORIGIN: "https://classhub.test",
        PUBLIC_APP_ORIGIN: "https://classhub.test",
        TEAM_DRAWS_ENABLED: "true",
        DUTY_ROSTERS_ENABLED: "true",
      }),
    );
    expect(includesConfiguredModule(enabled.module, "TeamDrawsModule")).toBe(false);
    expect(includesConfiguredModule(enabled.module, "DutyRostersModule")).toBe(false);
    expect(includesConfiguredModule(enabled.module, "LayoutDraftsModule")).toBe(false);
  });

  it("keeps the local test admin module available only for an explicitly enabled development environment", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "development",
      LOCAL_TEST_ADMIN_ENABLED: "true",
      LOCAL_TEST_ADMIN_OPERATOR_EMAIL: "operator@example.com",
      LOCAL_TEST_ADMIN_DATABASE_URL:
        "postgresql://classhub_local_admin:local_admin_db_password@127.0.0.1:5432/classhub_dev",
      LOCAL_TEST_ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=1$synthetic",
      LOCAL_TEST_ADMIN_USERNAME: "local-operator",
    });

    const configured = await AppModule.configure(environment);

    expect(includesConfiguredModule(configured.module, "LocalTestAdminModule")).toBe(true);
  });
});
