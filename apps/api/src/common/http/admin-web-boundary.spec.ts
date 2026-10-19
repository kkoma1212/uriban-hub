import { describe, expect, it } from "vitest";

import { isAdministratorWebPath } from "./admin-web-boundary.js";

describe("administrator web boundary", () => {
  it.each([
    "/admin",
    "/admin/login?next=/home",
    "/ADMIN/account",
    "/%61dmin/login",
    "/admin%2flogin",
    "//admin//login",
    "/other/../admin/login",
    "/assets/admin-console-fixture.js",
    "/ASSETS/ADMIN-CONSOLE-FIXTURE.JS",
    "/assets%2f%61dmin-login.js",
    "/assets/./admin-shell.js",
    "/assets%5cadmin-shell.js",
    "/assets/admin/config.json",
  ])("recognizes %s before resolving a file or SPA route", (path) => {
    expect(isAdministratorWebPath(path)).toBe(true);
  });

  it.each([
    "/login",
    "/home?next=/admin",
    "/administration",
    "/assets/main.js",
    "/assets/administrator-guide.js",
    "/api/v1/admin/auth/session",
    "/bad%zz",
  ])("does not change the existing handler for %s", (path) => {
    expect(isAdministratorWebPath(path)).toBe(false);
  });
});
