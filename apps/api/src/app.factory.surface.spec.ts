import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Controller, Get, Module, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApplication } from "./app.factory.js";
import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";
import { SecurityAuditHttpProducer } from "./security-audit/security-audit-http.producer.js";

// 관리자 프로그램(API_SURFACE=admin)은 학생·교사 API가 함께 등록돼 있어도 관리자 주소만 연다(T-ADMIN-SPLIT 3단계).
@Controller()
class SurfaceFixtureController {
  @Get("admin/ping")
  admin() {
    return { surface: "admin" };
  }

  @Post("auth/login")
  userLogin() {
    return { surface: "user" };
  }

  @Get("bootstrap")
  bootstrap() {
    return { surface: "user" };
  }

  @Get("legal/documents/terms")
  legal() {
    return { surface: "shared" };
  }

  @Post("client-errors")
  clientErrors() {
    return { surface: "shared" };
  }
}

@Module({})
class SurfaceFixtureModule {}

const noop = () => undefined;

async function start(environmentInput: Record<string, string>, webRoot: string) {
  const environment = loadEnvironment({
    NODE_ENV: "development",
    SERVE_WEB: "true",
    ...environmentInput,
  });
  vi.spyOn(AppModule, "configure").mockResolvedValue({
    environment,
    module: {
      module: SurfaceFixtureModule,
      controllers: [SurfaceFixtureController],
      providers: [
        {
          provide: Logger,
          useValue: { log: noop, error: noop, warn: noop, debug: noop, verbose: noop, fatal: noop },
        },
        { provide: SecurityAuditHttpProducer, useValue: { recordFailure: async () => undefined } },
      ],
    },
  });
  return (await createApplication({ environment, webRoot })).app;
}

describe("administrator program surface", () => {
  let app: NestFastifyApplication;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "classhub-admin-surface-"));
    await mkdir(join(webRoot, "admin"), { recursive: true });
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "admin", "index.html"), "<title>admin-fixture</title>");
    await writeFile(join(webRoot, "assets", "admin-shell-01234567.js"), "/* admin asset */");
    app = await start(
      {
        API_SURFACE: "admin",
        ADMIN_WEB_ENABLED: "true",
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
        ADMIN_MFA_KEY_VERSION: "test-1",
        USER_APP_ORIGIN: "http://localhost:5174",
      },
      webRoot,
    );
  });

  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
    if (webRoot) await rm(webRoot, { recursive: true, force: true });
  });

  it("answers administrator, legal and client-error routes", async () => {
    const fastify = app.getHttpAdapter().getInstance();
    expect((await fastify.inject({ method: "GET", url: "/api/v1/admin/ping" })).statusCode).toBe(
      200,
    );
    expect(
      (await fastify.inject({ method: "GET", url: "/api/v1/legal/documents/terms" })).statusCode,
    ).toBe(200);
    expect(
      (await fastify.inject({ method: "POST", url: "/api/v1/client-errors" })).statusCode,
    ).toBe(201);
  });

  it.each([
    ["POST", "/api/v1/auth/login"],
    ["GET", "/api/v1/bootstrap"],
    ["GET", "/api/v1/admin/..%2fbootstrap"],
    ["GET", "/API/v1/bootstrap"],
  ] as const)("refuses the user API %s %s", async (method, url) => {
    const response = await app.getHttpAdapter().getInstance().inject({ method, url });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('"surface":"user"');
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("serves the administrator screen bundle", async () => {
    const fastify = app.getHttpAdapter().getInstance();
    for (const url of ["/", "/admin", "/admin/login"]) {
      const response = await fastify.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("admin-fixture");
    }
    expect(
      (await fastify.inject({ method: "GET", url: "/assets/admin-shell-01234567.js" })).statusCode,
    ).toBe(200);
  });
});

describe("user program surface", () => {
  it("never registers administrator credentials or routes", () => {
    expect(() =>
      loadEnvironment({ NODE_ENV: "development", API_SURFACE: "user", ADMIN_WEB_ENABLED: "true" }),
    ).toThrow(/API_SURFACE=user/u);
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        API_SURFACE: "user",
        ADMIN_MFA_KEY_VERSION: "test-1",
      }),
    ).toThrow(/관리자 비밀값/u);
  });

  it("requires the user screen origin for mail links in the administrator program", () => {
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        API_SURFACE: "admin",
        ADMIN_WEB_ENABLED: "true",
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
        ADMIN_MFA_KEY_VERSION: "test-1",
      }),
    ).toThrow(/USER_APP_ORIGIN/u);
    expect(() => loadEnvironment({ NODE_ENV: "development", API_SURFACE: "admin" })).toThrow(
      /ADMIN_WEB_ENABLED=true/u,
    );
  });

  it("keeps the production administrator program off the user screen host", () => {
    // 승인된 운영 개방(BACKLOG 28)도 관리자 주소가 학생·교사 주소와 같으면 기동을 거부한다.
    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        API_SURFACE: "admin",
        ADMIN_WEB_ENABLED: "true",
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
        ADMIN_MFA_KEY_VERSION: "test-1",
        PUBLIC_APP_ORIGIN: "https://uribanhub.com",
        PUBLIC_API_ORIGIN: "https://uribanhub.com",
        USER_APP_ORIGIN: "https://uribanhub.com",
      }),
    ).toThrow(/다른 호스트에서만/u);
  });
});
