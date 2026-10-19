import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminRoleInsufficientException,
  AdminSessionRequiredException,
  AdminStepUpRequiredException,
} from "./admin-auth.errors.js";
import type { AuthenticatedAdminSession } from "./admin-auth.types.js";
import { AdminRolesGuard } from "./admin-roles.guard.js";
import { AdminStepUpGuard } from "./admin-step-up.guard.js";

function session(overrides: Partial<AuthenticatedAdminSession> = {}): AuthenticatedAdminSession {
  return {
    absoluteExpiresAt: new Date("2026-09-03T00:30:00.000Z"),
    adminAccountId: "17",
    csrfTokenHash: Buffer.alloc(32),
    displayName: "보안 관리자",
    email: "admin@example.com",
    issuedAt: new Date("2026-09-03T00:00:00.000Z"),
    lastSeenAt: new Date("2026-09-03T00:00:00.000Z"),
    mfaVerifiedAt: new Date("2026-09-03T00:00:00.000Z"),
    reauthenticatedAt: new Date("2026-09-03T00:01:00.000Z"),
    roles: ["security_auditor"],
    sessionId: "31",
    ...overrides,
  };
}

function context(authenticatedSession: AuthenticatedAdminSession): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getNext: () => undefined,
      getRequest: () => ({ authenticatedAdminSession: authenticatedSession }),
      getResponse: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("admin authorization guards", () => {
  it("allows any explicitly accepted role and denies a different role", () => {
    const reflector = {
      getAllAndOverride: vi.fn(() => ["super_admin", "security_auditor"]),
    };
    const guard = new AdminRolesGuard(reflector as never);
    expect(guard.canActivate(context(session()))).toBe(true);

    reflector.getAllAndOverride.mockReturnValue(["super_admin"]);
    expect(() => guard.canActivate(context(session()))).toThrow(AdminRoleInsufficientException);
  });

  it("rechecks changed and withdrawn roles instead of caching an earlier acceptance", () => {
    const guard = new AdminRolesGuard({
      getAllAndOverride: () => ["super_admin"],
    } as never);
    const current = session({ roles: ["super_admin"] });
    const request = context(current);
    expect(guard.canActivate(request)).toBe(true);
    current.roles = ["security_auditor"];
    expect(() => guard.canActivate(request)).toThrow(AdminRoleInsufficientException);
    current.roles = [];
    expect(() => guard.canActivate(request)).toThrow(AdminRoleInsufficientException);
  });

  it.each([new Date("2026-09-02T23:59:59.999Z"), new Date("2026-09-03T00:02:00.001Z")])(
    "rejects MFA proof outside the issuance-to-present interval: %s",
    (mfaVerifiedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-03T00:02:00.000Z"));
      expect(() => new AdminStepUpGuard().canActivate(context(session({ mfaVerifiedAt })))).toThrow(
        AdminSessionRequiredException,
      );
    },
  );
  it("requires an explicit recent proof independently of login and manual session renewal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:05:59.999Z"));
    const guard = new AdminStepUpGuard();
    expect(guard.canActivate(context(session()))).toBe(true);
    for (const reauthenticatedAt of [
      null,
      new Date("2026-09-03T00:00:00Z"),
      new Date("2026-09-03T00:06:01Z"),
      new Date(NaN),
    ]) {
      expect(() => guard.canActivate(context(session({ reauthenticatedAt })))).toThrow(
        AdminStepUpRequiredException,
      );
    }
    vi.setSystemTime(new Date("2026-09-03T00:06:00.000Z"));
    expect(() => guard.canActivate(context(session()))).toThrow(AdminStepUpRequiredException);
    expect(() =>
      guard.canActivate(context(session({ absoluteExpiresAt: new Date("2026-09-03T01:00:00Z") }))),
    ).toThrow(AdminStepUpRequiredException);
    vi.setSystemTime(new Date("2026-09-03T00:30:00.000Z"));
    expect(() => guard.canActivate(context(session()))).toThrow(AdminSessionRequiredException);
  });

  it.each(["issuedAt", "mfaVerifiedAt", "absoluteExpiresAt"] as const)(
    "fails closed for invalid %s",
    (field) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-03T00:02:00Z"));
      expect(() =>
        new AdminStepUpGuard().canActivate(context(session({ [field]: new Date(NaN) }))),
      ).toThrow(AdminSessionRequiredException);
    },
  );
});
