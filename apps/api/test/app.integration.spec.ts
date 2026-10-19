import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as createHttpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { ShutdownSignal } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AUTH_RATE_LIMITER } from "../src/auth/auth.tokens.js";
import { PasswordResetService } from "../src/auth/password-reset.service.js";
import { createApplication, createOpenApiDocument } from "../src/app.factory.js";
import { AppModule } from "../src/app.module.js";
import { createSecurityHeaders } from "../src/common/http/security-headers.js";
import type { RedisRateLimiter } from "../src/common/rate-limit/redis-rate-limiter.js";
import { loadEnvironment, type AppEnvironment } from "../src/config/environment.js";
import { DATABASE, type ClassHubDatabase } from "../src/database/database.module.js";
import { HealthController } from "../src/health/health.controller.js";
import { LocalTestAdminModule } from "../src/local-test-admin/local-test-admin.module.js";
import {
  setupAppIntegrationEnvironments,
  teardownAppIntegrationEnvironments,
} from "./app-integration-test-harness.js";

let DEVELOPMENT_TEST_ENVIRONMENT: AppEnvironment;
let SERVED_WEB_TEST_ENVIRONMENT: AppEnvironment;

beforeAll(async () => {
  const environments = await setupAppIntegrationEnvironments();
  DEVELOPMENT_TEST_ENVIRONMENT = environments.development;
  SERVED_WEB_TEST_ENVIRONMENT = environments.servedWeb;
}, 120_000);

afterAll(teardownAppIntegrationEnvironments, 120_000);

function expectSecurityHeaders(
  headers: Readonly<Record<string, number | string | string[] | undefined>>,
  environment: Pick<typeof DEVELOPMENT_TEST_ENVIRONMENT, "NODE_ENV" | "PUBLIC_APP_ORIGIN">,
): void {
  const expected = createSecurityHeaders(environment);

  for (const [name, value] of Object.entries(expected)) {
    expect(headers[name.toLowerCase()]).toBe(value);
  }

  expect(headers["strict-transport-security"]).toBe(expected["Strict-Transport-Security"]);
}

function rawGet(port: number, path: string): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      { host: "127.0.0.1", method: "GET", path, port },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ body, statusCode: response.statusCode ?? 0 });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("API scaffold", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createApplication({ environment: DEVELOPMENT_TEST_ENVIRONMENT }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns liveness status and a generated request ID", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(response.headers, DEVELOPMENT_TEST_ENVIRONMENT);

    const withQuery = await app.inject({ method: "GET", url: "/healthz?probe=1" });
    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.headers["cache-control"]).toBe("no-store");
  });

  it("configures finite HTTP connection, request, and keep-alive timeouts", () => {
    const server = app.getHttpServer() as Server;

    expect(server.timeout).toBe(30_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(65_000);
  });

  it("returns the common error envelope for unknown API routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/missing" });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(response.headers, DEVELOPMENT_TEST_ENVIRONMENT);
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "찾는 화면이나 기능이 없어요.",
        request_id: response.headers["x-request-id"],
      },
    });
  });

  it("does not register any attendance notification route by default", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/attendance-notifications/today",
      }),
      app.inject({
        method: "POST",
        payload: {},
        url: "/api/v1/attendance-notifications",
      }),
      app.inject({
        method: "PATCH",
        payload: {},
        url: "/api/v1/attendance-notifications/1",
      }),
      app.inject({
        method: "POST",
        payload: {},
        url: "/api/v1/attendance-notifications/1/cancel",
      }),
      app.inject({
        method: "POST",
        payload: {},
        url: "/api/v1/attendance-notifications/1/acknowledge",
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects a pre-auth state change without the configured Origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      error: {
        code: "ORIGIN_NOT_ALLOWED",
        message: "허용되지 않은 요청 출처입니다.",
        request_id: response.headers["x-request-id"],
      },
    });
  });

  it("protects both enabled password-reset endpoints with the configured Origin", async () => {
    const service = app.get(PasswordResetService);
    const requestReset = vi.spyOn(service, "requestReset");
    const confirmReset = vi.spyOn(service, "confirmReset");

    try {
      const [requestResponse, confirmResponse] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset-requests",
          payload: {},
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/auth/password-resets/confirm",
          payload: {},
        }),
      ]);

      expect(requestResponse.statusCode).toBe(403);
      expect(requestResponse.headers["set-cookie"]).toBeUndefined();
      expect(requestResponse.json()).toEqual({
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message: "허용되지 않은 요청 출처입니다.",
          request_id: requestResponse.headers["x-request-id"],
        },
      });
      expect(confirmResponse.statusCode).toBe(403);
      expect(confirmResponse.headers["set-cookie"]).toBeUndefined();
      expect(confirmResponse.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
      expect(requestReset).not.toHaveBeenCalled();
      expect(confirmReset).not.toHaveBeenCalled();
    } finally {
      requestReset.mockRestore();
      confirmReset.mockRestore();
    }
  });

  it.each([
    ["empty", undefined],
    ["malformed", '{"display_name":'],
  ])("returns a safe Korean validation message for %s JSON", async (_case, payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
      },
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "요청 형식을 확인해 주세요.",
        request_id: response.headers["x-request-id"],
      },
    });
  });

  it("keeps a supported form media type in the request validation path", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:5173",
      },
      payload: "display_name=student",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "요청 형식을 확인해 주세요.",
        request_id: response.headers["x-request-id"],
      },
    });
    expect(response.body).not.toContain("Unsupported Media Type");
  });

  it("normalizes an unsupported multipart request media type", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sign-up",
      headers: {
        "content-type": "multipart/form-data; boundary=classhub-boundary",
        origin: "http://localhost:5173",
      },
      payload: "--classhub-boundary--",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요.",
        request_id: response.headers["x-request-id"],
      },
    });
    expect(response.body).not.toContain("Unsupported Media Type");
  });

  it("marks successful auth responses as non-cacheable", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: "http://localhost:5173" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ logged_out: true });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("does not apply the API cache policy to web asset paths", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/no-store-probe.js" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"] ?? "").not.toContain("no-store");
  });

  it("publishes the discriminated home card response contract", () => {
    const document = createOpenApiDocument(app);
    const homeResponse = document.paths["/api/v1/home"]?.get?.responses?.["200"];
    const homeSchema = document.components?.schemas?.HomeResponseDto;

    expect(homeResponse).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/HomeResponseDto" },
        },
      },
    });
    expect(homeSchema).toMatchObject({
      properties: {
        meal: {
          oneOf: [
            {
              properties: { status: { enum: ["empty", "ok"] } },
              required: ["data", "status"],
            },
            {
              properties: {
                error_code: { enum: ["MEAL_QUERY_FAILED"] },
                status: { enum: ["error"] },
              },
              required: ["data", "error_code", "message", "status"],
            },
          ],
        },
        notices: { oneOf: expect.any(Array) },
        schedules: { oneOf: expect.any(Array) },
        supplies: { oneOf: expect.any(Array) },
      },
      required: expect.arrayContaining([
        "meal",
        "notices",
        "pending_member_count",
        "schedules",
        "server_today",
        "supplies",
      ]),
      type: "object",
    });
  });

  it("publishes the enabled password-reset endpoints in OpenAPI", () => {
    const document = createOpenApiDocument(app);

    expect(document.paths["/api/v1/auth/password-reset-requests"]?.post?.responses).toHaveProperty(
      "202",
    );
    expect(document.paths["/api/v1/auth/password-resets/confirm"]?.post?.responses).toHaveProperty(
      "200",
    );
  });

  it("does not register the local test admin API unless explicitly enabled", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/local-test-admin/accounts",
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("production module boundary", () => {
  it("does not import the local test admin module", async () => {
    const environment = loadEnvironment({
      DATABASE_URL:
        "postgresql://classhub_app:synthetic-password@db.internal:5432/classhub?sslmode=verify-full",
      EMAIL_HMAC_KEY: "production-test-hmac-key-at-least-32-bytes",
      NODE_ENV: "production",
      PUBLIC_API_ORIGIN: "https://classhub.example",
      PUBLIC_APP_ORIGIN: "https://classhub.example",
      REDIS_URL: "rediss://redis.internal:6380",
      SMTP_HOST: "smtp.invalid",
      SMTP_PASSWORD: "synthetic-password",
      SMTP_PORT: "587",
      SMTP_REQUIRE_TLS: "true",
      SMTP_SECURE: "false",
      SMTP_USERNAME: "synthetic-user",
      TRUSTED_PROXY_HOPS: "1",
    });
    const configuredModule = await AppModule.configure(environment);

    expect(configuredModule.module.imports).not.toContain(LocalTestAdminModule);
  });
});

describe("API shutdown lifecycle", () => {
  it("closes the HTTP server, PostgreSQL pool, and Redis client on SIGTERM", async () => {
    const { app } = await createApplication({ environment: DEVELOPMENT_TEST_ENVIRONMENT });
    const database = app.get<ClassHubDatabase>(DATABASE);
    const rateLimiter = app.get<RedisRateLimiter>(AUTH_RATE_LIMITER);
    const healthController = app.get(HealthController);
    const databaseDestroy = vi.spyOn(database, "destroy");
    const rateLimiterClose = vi.spyOn(rateLimiter, "close");
    const beforeApplicationShutdown = vi.spyOn(healthController, "beforeApplicationShutdown");
    const existingListeners = new Set(process.listeners(ShutdownSignal.SIGTERM));
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const processExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let shutdownCompleted = false;

    try {
      app.enableShutdownHooks([ShutdownSignal.SIGTERM]);
      const shutdownListener = process
        .listeners(ShutdownSignal.SIGTERM)
        .find((listener) => !existingListeners.has(listener));
      expect(shutdownListener).toBeDefined();

      await app.listen(0, "127.0.0.1");
      expect(app.getHttpServer().listening).toBe(true);

      await shutdownListener!(ShutdownSignal.SIGTERM);
      shutdownCompleted = true;

      expect(app.getHttpServer().listening).toBe(false);
      expect(databaseDestroy).toHaveBeenCalledOnce();
      expect(rateLimiterClose).toHaveBeenCalledOnce();
      expect(beforeApplicationShutdown).toHaveBeenCalledOnce();
      expect(processKill).toHaveBeenCalledWith(process.pid, ShutdownSignal.SIGTERM);
      expect(processExit).not.toHaveBeenCalled();
      expect(process.listeners(ShutdownSignal.SIGTERM)).not.toContain(shutdownListener);
    } finally {
      processKill.mockRestore();
      processExit.mockRestore();
      databaseDestroy.mockRestore();
      rateLimiterClose.mockRestore();
      beforeApplicationShutdown.mockRestore();

      try {
        if (!shutdownCompleted) {
          await app.close();
        }
      } finally {
        for (const listener of process.listeners(ShutdownSignal.SIGTERM)) {
          if (!existingListeners.has(listener)) {
            process.removeListener(ShutdownSignal.SIGTERM, listener);
          }
        }
      }
    }
  });
});

describe("served web application", () => {
  const indexMarker = "classhub-spa-fallback-fixture";
  let app: NestFastifyApplication | undefined;
  let webRoot: string | undefined;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "classhub-web-fixture-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(
      join(webRoot, "index.html"),
      `<!doctype html><html><body>${indexMarker}</body></html>`,
      "utf8",
    );
    await writeFile(
      join(webRoot, "assets", "existing.js"),
      "export const fixture = true;\n",
      "utf8",
    );
    await writeFile(
      join(webRoot, "assets", "admin-console-fixture.js"),
      "privateAdminFixture",
      "utf8",
    );

    ({ app } = await createApplication({
      environment: SERVED_WEB_TEST_ENVIRONMENT,
      webRoot,
    }));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (webRoot !== undefined) {
        await rm(webRoot, { force: true, recursive: true });
      }
    }
  });

  it("serves extensionless SPA deep links from the index document", async () => {
    const home = await app!.inject({ method: "GET", url: "/home" });
    const login = await app!.inject({ method: "GET", url: "/login?from=bookmark" });
    const futureRoute = await app!.inject({ method: "GET", url: "/future-client-route" });

    for (const response of [home, login, futureRoute]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expectSecurityHeaders(response.headers, SERVED_WEB_TEST_ENVIRONMENT);
      expect(response.headers["cache-control"] ?? "").not.toContain("no-store");
      expect(response.body).toContain(indexMarker);
    }
  });

  it.each(["GET", "HEAD"] as const)(
    "blocks administrator pages and files for %s when disabled",
    async (method) => {
      for (const url of [
        "/admin",
        "/admin/login",
        "/admin/account",
        "/ADMIN/login",
        "/%61dmin/login",
        "/admin%2flogin",
        "/assets/admin-console-fixture.js",
        "/ASSETS/ADMIN-CONSOLE-FIXTURE.JS",
        "/assets%2f%61dmin-console-fixture.js",
      ]) {
        const response = await app!.inject({ method, url });
        expect(response.statusCode, url).toBe(404);
        expect(response.headers["cache-control"], url).toBe("no-store");
        expect(response.body).not.toContain(indexMarker);
        expect(response.body).not.toContain("privateAdminFixture");
      }
    },
  );

  it("does not serve administrator files through range or conditional requests", async () => {
    for (const headers of [{ range: "bytes=0-8" }, { "if-none-match": "*" }]) {
      const response = await app!.inject({
        method: "GET",
        url: "/assets/admin-console-fixture.js",
        headers,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("privateAdminFixture");
    }
  });

  it("preserves administrator pages, static files and authenticated API boundaries when enabled", async () => {
    const { app: adminApp } = await createApplication({
      environment: { ...SERVED_WEB_TEST_ENVIRONMENT, ADMIN_WEB_ENABLED: true },
      webRoot: webRoot!,
    });
    try {
      const page = await adminApp.inject({ method: "GET", url: "/admin/login" });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(indexMarker);
      for (const method of ["GET", "HEAD"] as const) {
        const asset = await adminApp.inject({ method, url: "/assets/admin-console-fixture.js" });
        expect(asset.statusCode).toBe(200);
        expect(asset.headers["cache-control"] ?? "").not.toContain("no-store");
      }
      const session = await adminApp.inject({ method: "GET", url: "/api/v1/admin/auth/session" });
      expect(session.statusCode).toBe(401);
    } finally {
      await adminApp.close();
    }
  });

  it("keeps API and health responses on their existing JSON routes", async () => {
    const missingApi = await app!.inject({ method: "GET", url: "/api/v1/missing" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers["content-type"]).toContain("application/json");
    expect(missingApi.headers["cache-control"]).toBe("no-store");
    expect(missingApi.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "찾는 화면이나 기능이 없어요.",
        request_id: missingApi.headers["x-request-id"],
      },
    });

    const health = await app!.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(health.headers["cache-control"]).toBe("no-store");

    const readiness = await app!.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({ status: "ready" });
    expect(readiness.headers["cache-control"]).toBe("no-store");
  });

  it("does not turn missing assets or non-GET requests into the index document", async () => {
    const responses = await Promise.all([
      app!.inject({ method: "GET", url: "/assets" }),
      app!.inject({ method: "GET", url: "/assets/missing.js" }),
      app!.inject({ method: "GET", url: "/assets%2Fmissing.js" }),
      app!.inject({ method: "GET", url: "/api%2Fv1%2Fmissing" }),
      app!.inject({ method: "GET", url: "/healthz/extra" }),
      app!.inject({ method: "GET", url: "/readyz/extra" }),
      app!.inject({ method: "GET", url: "/readyz%2Fextra" }),
      app!.inject({ method: "GET", url: "/api/v1/readyz" }),
      app!.inject({ method: "GET", url: "/missing.js" }),
      app!.inject({ method: "HEAD", url: "/home" }),
      app!.inject({ method: "POST", url: "/home" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(indexMarker);
    }
  });

  it("continues serving existing static assets without the API cache policy", async () => {
    const response = await app!.inject({ method: "GET", url: "/assets/existing.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["cache-control"] ?? "").not.toContain("no-store");
    expectSecurityHeaders(response.headers, SERVED_WEB_TEST_ENVIRONMENT);
    expect(response.body).toContain("fixture = true");
  });

  it("caches only content-hashed build files for a year and keeps fixed names revalidated", async () => {
    const hashed = join(webRoot!, "assets", "index-D_yYMtZP.js");
    await writeFile(hashed, "export const hashed = true;\n", "utf8");
    try {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app!.inject({ method, url: "/assets/index-D_yYMtZP.js" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      }
    } finally {
      await rm(hashed);
    }
    // 이름에 해시가 없는 파일과 첫 화면은 새 배포가 바로 보이도록 매번 확인한다.
    for (const url of ["/assets/existing.js", "/", "/index.html", "/home"]) {
      const response = await app!.inject({ method: "GET", url });
      expect(response.headers["cache-control"] ?? "", url).not.toContain("immutable");
    }
  });

  it("serves files added after startup and stops serving removed deployment files", async () => {
    const asset = join(webRoot!, "assets", "after-startup.js");
    await writeFile(asset, "export const deployedAfterStartup = true;\n", "utf8");
    try {
      const get = await app!.inject({ method: "GET", url: "/assets/after-startup.js" });
      expect(get.statusCode).toBe(200);
      expect(get.body).toContain("deployedAfterStartup = true");
      expect(get.headers["content-type"]).toContain("javascript");
      const head = await app!.inject({ method: "HEAD", url: "/assets/after-startup.js" });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
    } finally {
      await rm(asset);
    }
    const removed = await app!.inject({ method: "GET", url: "/assets/after-startup.js" });
    expect(removed.statusCode).toBe(404);
    expect(removed.body).not.toContain(indexMarker);
  });

  it("rejects non-leading parent segments before static file resolution", async () => {
    await app!.listen(0, "127.0.0.1");
    const address = (app!.getHttpServer() as Server).address();
    if (address === null || typeof address === "string") {
      throw new Error("The disposable served-Web listener did not expose a loopback port");
    }
    const responses = await Promise.all(
      [
        "/public/../assets/existing.js",
        "/public/%2e%2e/assets/existing.js",
        "/public/%2E%2E/assets/existing.js",
      ].map((path) => rawGet(address.port, path)),
    );

    for (const response of responses) {
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain(indexMarker);
      expect(response.body).not.toContain("fixture = true");
    }
  });

  it("rejects non-leading parent segments inside the static plugin", async () => {
    if (webRoot === undefined) {
      throw new Error("The disposable served-Web fixture root was not initialized");
    }
    const staticPluginApp = Fastify();

    try {
      await staticPluginApp.register(fastifyStatic, { root: webRoot });
      staticPluginApp.get("/dot-dot", (_request, reply) => reply.sendFile("assets/../index.html"));

      const response = await staticPluginApp.inject({ method: "GET", url: "/dot-dot" });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(indexMarker);
    } finally {
      await staticPluginApp.close();
    }
  });
});

describe("readiness endpoints", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createApplication({ environment: DEVELOPMENT_TEST_ENVIRONMENT }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports readiness only when PostgreSQL and Redis are available", async () => {
    const response = await app.inject({ method: "GET", url: "/readyz?probe=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(response.headers, DEVELOPMENT_TEST_ENVIRONMENT);
  });

  it("fails readiness closed without leaking dependency details and keeps liveness independent", async () => {
    const rateLimiter = app.get<RedisRateLimiter>(AUTH_RATE_LIMITER);
    const redisProbe = vi
      .spyOn(rateLimiter, "ensureAvailable")
      .mockRejectedValueOnce(new Error("redis://:redis-secret@cache.internal:6379"));

    try {
      const readiness = await app.inject({ method: "GET", url: "/readyz" });
      const liveness = await app.inject({ method: "GET", url: "/healthz" });

      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ status: "not_ready" });
      expect(readiness.headers["cache-control"]).toBe("no-store");
      expect(readiness.body).not.toContain("redis-secret");
      expect(readiness.body).not.toContain("cache.internal");
      expect(liveness.statusCode).toBe(200);
      expect(liveness.json()).toEqual({ status: "ok" });
    } finally {
      redisProbe.mockRestore();
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it("bounds stalled readiness responses and shares one in-flight database probe", async () => {
    let releaseDatabase!: () => void;
    const stalledDatabase = new Promise<void>((resolve) => {
      releaseDatabase = resolve;
    });
    const controller = app.get(HealthController);
    const databaseProbe = vi
      .spyOn(controller as unknown as { probeDatabase: () => Promise<void> }, "probeDatabase")
      .mockImplementation(() => stalledDatabase);

    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/readyz" }),
        app.inject({ method: "GET", url: "/readyz" }),
      ]);

      for (const response of responses) {
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: "not_ready" });
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(databaseProbe).toHaveBeenCalledOnce();

      const liveness = await app.inject({ method: "GET", url: "/healthz" });
      expect(liveness.statusCode).toBe(200);
      expect(liveness.json()).toEqual({ status: "ok" });
    } finally {
      releaseDatabase();
      await stalledDatabase;
      await Promise.resolve();
      await Promise.resolve();
      databaseProbe.mockRestore();
    }
  });

  it("removes shutdown-started instances from readiness while preserving liveness", async () => {
    const controller = app.get(HealthController);
    controller.beforeApplicationShutdown();

    const readiness = await app.inject({ method: "GET", url: "/readyz" });
    const liveness = await app.inject({ method: "GET", url: "/healthz" });

    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "not_ready" });
    expect(readiness.headers["cache-control"]).toBe("no-store");
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: "ok" });
  });
});
