import { describe, expect, it } from "vitest";

import { parseRetentionCommand, parseRetentionMode } from "./cli-arguments.js";
import { loadRetentionEnvironment } from "./environment.js";

describe("retention CLI boundaries", () => {
  it("requires one explicit non-destructive or destructive mode", () => {
    expect(parseRetentionMode(["--dry-run"])).toBe("dry-run");
    expect(parseRetentionMode(["--execute"])).toBe("execute");
    expect(() => parseRetentionMode([])).toThrow("Exactly one mode");
    expect(() => parseRetentionMode(["--execute", "--dry-run"])).toThrow("Exactly one mode");
    expect(() => parseRetentionMode(["--unknown"])).toThrow("Exactly one mode");
  });

  it("keeps assessments as the default and requires an exact optional target", () => {
    expect(parseRetentionCommand(["--dry-run"])).toEqual({
      mode: "dry-run",
      target: "student-assessments",
    });
    expect(parseRetentionCommand(["--target=attendance-notifications", "--execute"])).toEqual({
      mode: "execute",
      target: "attendance-notifications",
    });
    expect(() => parseRetentionCommand(["--execute", "--target=unknown"])).toThrow(
      "Retention target",
    );
    expect(() =>
      parseRetentionCommand([
        "--execute",
        "--target=student-assessments",
        "--target=attendance-notifications",
      ]),
    ).toThrow("Exactly one mode");
  });

  // 위 케이스가 증명하는 기본값은 --dry-run 쪽이다. 실제로 지우는 쪽은 --execute이므로
  // 그 한 줄이 어느 표를 겨냥하는지 따로 못박는다.
  it("aims a bare --execute at student assessments", () => {
    expect(parseRetentionCommand(["--execute"])).toEqual({
      mode: "execute",
      target: "student-assessments",
    });
  });

  it("routes the reminder target", () => {
    expect(parseRetentionCommand(["--dry-run", "--target=temporary-password-reminders"])).toEqual({
      mode: "dry-run",
      target: "temporary-password-reminders",
    });
  });

  it("routes the guardian consent request retention target", () => {
    expect(parseRetentionCommand(["--execute", "--target=guardian-consent-requests"])).toEqual({
      mode: "execute",
      target: "guardian-consent-requests",
    });
  });

  // 못 알아듣는 입력은 조용히 기본 대상을 지우는 대신 멈춰야 한다.
  it("stops on anything it does not fully understand", () => {
    for (const argv of [
      ["--execute", "--force"],
      ["--execute", "extra"],
      ["--execute", "--target="],
      ["--execute", "--target=Student-Assessments"],
      ["--execute=true"],
    ]) {
      expect(() => parseRetentionCommand(argv), argv.join(" ")).toThrow();
    }
  });

  it("requires the dedicated retention database role", () => {
    expect(() => loadRetentionEnvironment({ NODE_ENV: "test" })).toThrow(
      "RETENTION_DATABASE_URL is required",
    );
    expect(() =>
      loadRetentionEnvironment({
        NODE_ENV: "test",
        RETENTION_DATABASE_URL: "postgresql://classhub_app:password@127.0.0.1:5432/classhub_test",
      }),
    ).toThrow("classhub_retention role");
    expect(
      loadRetentionEnvironment({
        NODE_ENV: "test",
        RETENTION_DATABASE_URL:
          "postgresql://classhub_retention:password@127.0.0.1:5432/classhub_test",
      }),
    ).toMatchObject({ nodeEnvironment: "test" });
  });

  it("keeps production URLs on the hardened shared contract", () => {
    expect(() =>
      loadRetentionEnvironment({
        NODE_ENV: "production",
        RETENTION_DATABASE_URL:
          "postgresql://classhub_retention:password@db.internal:5432/classhub?sslmode=disable",
      }),
    ).toThrow("canonical sslmode=verify-full");
  });
});
