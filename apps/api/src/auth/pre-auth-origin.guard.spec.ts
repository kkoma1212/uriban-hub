import type { ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { OriginNotAllowedException } from "./auth.errors.js";
import type { AuthenticatedFastifyRequest } from "./authenticated-request.js";
import { SESSION_COOKIE_NAME } from "./session-cookie.js";
import { PreAuthOriginGuard } from "./pre-auth-origin.guard.js";

const EXPECTED_ORIGIN = "http://localhost:5173";
const VALID_SESSION_TOKEN = "a".repeat(43);

function executionContext(request: AuthenticatedFastifyRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function requestFor(
  route: string,
  origin: string | undefined,
  cookie = `${SESSION_COOKIE_NAME}=${VALID_SESSION_TOKEN}`,
): AuthenticatedFastifyRequest {
  return {
    headers: { cookie, origin },
    method: "POST",
    routeOptions: { url: route },
  } as unknown as FastifyRequest;
}

function makeGuard() {
  const config = {
    get: vi.fn(() => EXPECTED_ORIGIN),
  };
  return {
    guard: new PreAuthOriginGuard(config as never),
  };
}

describe("PreAuthOriginGuard pre-database Origin rejection", () => {
  it.each(["/api/v1/auth/logout", "/api/v1/auth/csrf-token"])(
    "rejects Origin before any session lookup even with a well-shaped cookie on %s",
    async (route) => {
      const { guard } = makeGuard();
      const request = requestFor(route, "https://attacker.invalid");

      await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
        OriginNotAllowedException,
      );

      expect(request.securityAuditIdentity).toBeUndefined();
    },
  );

  it("preserves the stable 403 decision without attaching session identity", async () => {
    const { guard } = makeGuard();
    const request = requestFor("/api/v1/auth/logout", "https://attacker.invalid");

    let caught: unknown;
    try {
      await guard.canActivate(executionContext(request));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OriginNotAllowedException);
    expect((caught as OriginNotAllowedException).getStatus()).toBe(403);
    expect((caught as OriginNotAllowedException).getResponse()).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(request.securityAuditIdentity).toBeUndefined();
  });

  it.each([
    "/api/v1/auth/login",
    "/api/v1/auth/sign-up",
    "/api/v1/auth/password-reset-requests",
    "/api/v1/auth/password-resets/confirm",
    "/api/v1/local-test-admin/login",
  ])("does not inspect cookies for pre-auth Origin failure on %s", async (route) => {
    const { guard } = makeGuard();
    const request = requestFor(route, undefined);

    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
      OriginNotAllowedException,
    );
  });

  it("accepts the configured Origin without performing audit enrichment", async () => {
    const { guard } = makeGuard();
    const request = requestFor("/api/v1/auth/logout", EXPECTED_ORIGIN);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
  });
});
