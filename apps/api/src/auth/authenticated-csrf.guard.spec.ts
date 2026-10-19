import type { ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { OriginNotAllowedException } from "./auth.errors.js";
import type { AuthenticatedFastifyRequest } from "./authenticated-request.js";
import { AuthenticatedCsrfGuard } from "./authenticated-csrf.guard.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "./session-cookie.js";

const EXPECTED_ORIGIN = "http://localhost:5173";
const SESSION_TOKEN = "s".repeat(43);
const CSRF_TOKEN = "c".repeat(43);

function executionContext(request: AuthenticatedFastifyRequest): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function requestFor(origin: string): AuthenticatedFastifyRequest {
  return {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}; ${CSRF_COOKIE_NAME}=${CSRF_TOKEN}`,
      origin,
      "x-csrf-token": CSRF_TOKEN,
    },
    method: "POST",
    routeOptions: { url: "/api/v1/notices" },
  } as unknown as FastifyRequest;
}

function makeGuard() {
  const authenticatedSession = { userId: "42" };
  const resolveSecurityAuditIdentity = vi.fn();
  const authenticateWithCsrf = vi.fn().mockResolvedValue(authenticatedSession);
  const config = { get: vi.fn(() => EXPECTED_ORIGIN) };
  const reflector = { getAllAndOverride: vi.fn(() => false) };
  const sessionService = { authenticateWithCsrf, resolveSecurityAuditIdentity };

  return {
    authenticateWithCsrf,
    authenticatedSession,
    guard: new AuthenticatedCsrfGuard(config as never, reflector as never, sessionService as never),
    resolveSecurityAuditIdentity,
  };
}

describe("AuthenticatedCsrfGuard pre-database Origin rejection", () => {
  it("rejects a bad Origin before either session lookup with a well-shaped random cookie", async () => {
    const { guard, authenticateWithCsrf, resolveSecurityAuditIdentity } = makeGuard();
    const request = requestFor("https://attacker.invalid");

    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
      OriginNotAllowedException,
    );

    expect(resolveSecurityAuditIdentity).not.toHaveBeenCalled();
    expect(authenticateWithCsrf).not.toHaveBeenCalled();
    expect(request.securityAuditIdentity).toBeUndefined();
    expect(request.authenticatedSession).toBeUndefined();
  });

  it("authenticates with CSRF only after the configured Origin is accepted", async () => {
    const { guard, authenticateWithCsrf, authenticatedSession, resolveSecurityAuditIdentity } =
      makeGuard();
    const request = requestFor(EXPECTED_ORIGIN);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);

    expect(resolveSecurityAuditIdentity).not.toHaveBeenCalled();
    expect(authenticateWithCsrf).toHaveBeenCalledOnce();
    expect(authenticateWithCsrf).toHaveBeenCalledWith(
      SESSION_TOKEN,
      CSRF_TOKEN,
      CSRF_TOKEN,
      expect.objectContaining({
        allowUnverifiedEmail: false,
        onSecurityAuditIdentity: expect.any(Function),
      }),
    );
    expect(request.authenticatedSession).toBe(authenticatedSession);
  });
});
