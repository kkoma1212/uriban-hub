import { Controller, Get, Module, Req, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication } from "./app.factory.js";
import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";
import { SecurityAuditHttpProducer } from "./security-audit/security-audit-http.producer.js";
import { BootstrapController } from "./bootstrap/bootstrap.controller.js";
import { BootstrapService } from "./bootstrap/bootstrap.service.js";
import { SessionService } from "./auth/session.service.js";
import { UnauthenticatedException } from "./auth/auth.errors.js";
import { AdminSessionGuard } from "./admin-auth/admin-session.guard.js";
import { AdminAuthService } from "./admin-auth/admin-auth.service.js";
import { AdminSessionRequiredException } from "./admin-auth/admin-auth.errors.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "./admin-auth/admin-auth.request.js";
import { sessionResponse } from "./admin-auth/admin-auth.controller.js";
// @ts-expect-error The observation collector is a Node.js operational module.
import { observeCompanyRoleRoutes } from "../../../OPERATIONS/scripts/observe-company-role-routes.mjs";

@Controller("admin/auth")
class ReadOnlyAdminSessionFixture {
  @Get("session")
  @UseGuards(AdminSessionGuard)
  session(@Req() request: AuthenticatedAdminRequest) {
    return sessionResponse(getAuthenticatedAdminSession(request));
  }
}
@Module({})
class RoleFixtureModule {}
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});
const tokens = Object.fromEntries(
  ["student", "teacher", "admin"].map((role, i) => [
    role,
    Buffer.alloc(32, i + 1).toString("base64url"),
  ]),
);
const noop = () => undefined;

async function start(surface: "user" | "admin") {
  const environment = loadEnvironment({
    NODE_ENV: "development",
    SERVE_WEB: "false",
    API_SURFACE: surface,
    ...(surface === "admin"
      ? {
          ADMIN_WEB_ENABLED: "true",
          ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64url"),
          ADMIN_MFA_KEY_VERSION: "fixture",
          USER_APP_ORIGIN: "http://localhost:5176",
        }
      : {}),
  });
  vi.spyOn(AppModule, "configure").mockResolvedValue({
    environment,
    module: {
      module: RoleFixtureModule,
      controllers: surface === "user" ? [BootstrapController] : [ReadOnlyAdminSessionFixture],
      providers: [
        {
          provide: Logger,
          useValue: { log: noop, error: noop, warn: noop, debug: noop, verbose: noop, fatal: noop },
        },
        { provide: SecurityAuditHttpProducer, useValue: { recordFailure: async () => undefined } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: SessionService,
          useValue: {
            authenticate: async (token: string | undefined) => {
              const role =
                token === tokens.student
                  ? "student"
                  : token === tokens.teacher
                    ? "teacher"
                    : undefined;
              if (!role) throw new UnauthenticatedException();
              return { userId: role, sessionId: "fixture" };
            },
          },
        },
        {
          provide: BootstrapService,
          useValue: {
            getForUser: async (role: string) => ({
              account: {
                signup_role: role,
                email: "never-record@example.invalid",
                display_name: "never-record",
              },
            }),
          },
        },
        {
          provide: AdminAuthService,
          useValue: {
            authenticate: async (token: string | undefined) => {
              if (token !== tokens.admin) throw new AdminSessionRequiredException();
              const now = new Date();
              return {
                adminAccountId: "fixture",
                displayName: "never-record",
                email: "never-record@example.invalid",
                roles: ["super_admin"],
                issuedAt: now,
                lastSeenAt: now,
                absoluteExpiresAt: now,
                mfaVerifiedAt: now,
                reauthenticatedAt: null,
              };
            },
          },
        },
      ],
    },
  });
  const app = (await createApplication({ environment })).app;
  apps.push(app);
  return app;
}

it("observes eight split-route outcomes through real Fastify boundaries and session guards", async () => {
  const user = await start("user"),
    admin = await start("admin");
  const observations: unknown[] = [];
  for (const [name, app, path] of [
    ["admin", admin, "/api/v1/bootstrap"],
    ["user", user, "/api/v1/admin/auth/session"],
  ] as const) {
    const response = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: path });
    let errorCode = null;
    try {
      const body = JSON.parse(response.body);
      errorCode = body.error?.code ?? body.code ?? null;
    } catch {}
    observations.push({
      surface: name,
      status: response.statusCode,
      contentType: response.headers["content-type"],
      errorCode,
    });
  }
  const result = await observeCompanyRoleRoutes({
    targets: { "user-api": "https://user.example", "admin-api": "https://admin.example" },
    sessions: tokens,
    fetchImpl: async (
      url: string,
      options: { headers: Record<string, string>; method: string },
    ) => {
      const target = new URL(url);
      const app = target.hostname === "user.example" ? user : admin;
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ method: "GET", url: target.pathname, headers: options.headers });
      observations.push({
        target: target.hostname,
        path: target.pathname,
        status: response.statusCode,
        contentType: response.headers["content-type"],
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": String(response.headers["content-type"]) },
      });
    },
  }).catch((error: Error) => {
    throw new Error(
      error.message + "; sanitized HTTP observations " + JSON.stringify(observations),
    );
  });
  expect(result.roles.map((row: { status: number }) => row.status)).toEqual([
    200, 401, 200, 401, 401, 200, 404, 404,
  ]);
  expect(JSON.stringify(result)).not.toContain("never-record");
  expect(result.admission).toBe(false);
});
