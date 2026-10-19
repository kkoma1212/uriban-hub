import { describe, expect, it } from "vitest";
import { publicSystemState, requiresMaintenanceCheck } from "./system-state.policy.js";

describe("proposed maintenance contract", () => {
  it("publishes only enabled text and state, never row metadata", () => {
    expect(
      publicSystemState([
        {
          key: "announcement",
          value_json: { enabled: true, message: " <b>공지</b> " },
        },
        { key: "maintenance_mode", value_json: '{"enabled":true}' },
      ]),
    ).toEqual({ maintenance: true, announcement: "<b>공지</b>" });
  });
  it("removes disabled announcements and defaults absent settings", () => {
    expect(
      publicSystemState([{ key: "announcement", value_json: { enabled: false, message: "old" } }]),
    ).toEqual({ maintenance: false, announcement: null });
    expect(publicSystemState([])).toEqual({
      maintenance: false,
      announcement: null,
    });
  });
  it("refuses malformed values rather than publishing normal status", () => {
    for (const value_json of ["{", { enabled: "true" }, { enabled: true, message: " " }])
      expect(() => publicSystemState([{ key: "announcement", value_json }])).toThrow();
  });
  it("preserves educational reads, admin recovery and exact account deletion", () => {
    for (const path of ["/api/v1/notices", "/api/v1/home", "/api/v1/my-assessments/1"])
      expect(requiresMaintenanceCheck("GET", path)).toBe(false);
    for (const path of [
      "/api/v1/admin/system-state/maintenance_mode",
      "/api/v1/admin/auth/totp",
      "/api/v1/auth/login",
      "/api/v1/auth/logout",
      "/api/v1/auth/password-resets/confirm",
      "/api/v1/auth/account-recovery-requests",
      "/api/v1/account/deletion",
    ])
      expect(requiresMaintenanceCheck("POST", path)).toBe(false);
  });
  it("blocks user mutations without broad auth-prefix exemptions", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      for (const path of [
        "/api/v1/notices/1",
        "/api/v1/auth/sign-up",
        "/api/v1/account/profile-photo",
        "/api/v1/auth/social/signup",
      ])
        expect(requiresMaintenanceCheck(method, path)).toBe(true);
    expect(
      requiresMaintenanceCheck("POST", "/api/v1/auth/social/:provider/start", {
        intent: "login",
      }),
    ).toBe(false);
    expect(
      requiresMaintenanceCheck("POST", "/api/v1/auth/social/:provider/start", {
        intent: "signup_over_14",
      }),
    ).toBe(true);
    for (const path of [
      "/api/v1/admin-lookalike/system-state",
      "/api/v1/authentic/login",
      "/api/v1/auth/login-extra",
      "/api/v1/account/deletion-extra",
    ])
      expect(requiresMaintenanceCheck("POST", path)).toBe(true);
  });
});
