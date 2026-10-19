import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { Controller, Get, Module, Req, UnauthorizedException } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import { Logger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApplication } from "./app.factory.js";
import { AppModule } from "./app.module.js";
import { loadEnvironment } from "./config/environment.js";
import { SecurityAuditHttpProducer } from "./security-audit/security-audit-http.producer.js";

@Controller()
class CacheFixtureController {
  @Get("bootstrap")
  bootstrap(@Req() request: FastifyRequest) {
    if (request.headers.cookie !== "fixture-session=valid") throw new UnauthorizedException();
    return { privateFixture: true };
  }

  @Get("records/:id")
  record() {
    return { privateFixture: true };
  }

  @Get("failure")
  failure() {
    throw new Error("synthetic handler failure");
  }
}

@Module({})
class CacheFixtureModule {}

describe("sensitive response caching across equivalent HTTP paths", () => {
  let app: NestFastifyApplication;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "classhub-cache-policy-"));
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<title>public-fixture</title>");
    await writeFile(join(webRoot, "assets", "public-01234567.js"), "/* public asset */");
    const environment = loadEnvironment({ NODE_ENV: "development", SERVE_WEB: "true" });
    const noop = () => undefined;
    vi.spyOn(AppModule, "configure").mockResolvedValue({
      environment,
      module: {
        module: CacheFixtureModule,
        controllers: [CacheFixtureController],
        providers: [
          {
            provide: Logger,
            useValue: {
              log: noop,
              error: noop,
              warn: noop,
              debug: noop,
              verbose: noop,
              fatal: noop,
            },
          },
          {
            provide: SecurityAuditHttpProducer,
            useValue: { recordFailure: async () => undefined },
          },
        ],
      },
    });
    ({ app } = await createApplication({ environment, webRoot }));
  });

  afterAll(async () => {
    await app?.close();
    vi.restoreAllMocks();
    if (webRoot) {
      expect(dirname(webRoot)).toBe(resolve(tmpdir()));
      expect(basename(webRoot)).toMatch(/^classhub-cache-policy-/u);
      await rm(webRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "/api/v1/bootstrap",
    "/%61pi/v1/bootstrap",
    "/a%70i/v1/bootstrap?unrelated=%zz",
    "/%61%70%69/v1/bootstrap",
    "/api/v1/%62ootstrap",
  ])("keeps authenticated and rejected GET/HEAD responses private for %s", async (url) => {
    for (const method of ["GET", "HEAD"] as const) {
      for (const authenticated of [false, true]) {
        const response = await app.inject({
          method,
          url,
          headers: authenticated ? { cookie: "fixture-session=valid" } : {},
        });
        expect(response.statusCode).toBe(authenticated ? 200 : 401);
        expect(response.headers["cache-control"]).toBe("no-store");
        if (method === "HEAD") expect(response.body).toBe("");
      }
    }
  });

  it.each(["%25", "%2F", "%3F", "%2561"])(
    "uses the registered API route even for encoded parameter %s",
    async (parameter) => {
      const response = await app.inject({ url: `/api/v1/records/${parameter}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );

  it.each([
    ["/%61pi/v1/missing", 404],
    ["/%61pi/v1/failure", 500],
    ["/%61pi/v1/sensitive-url-value%zz", 400],
    ["/api/v1/%E0%A4%A", 400],
  ])("keeps errors private for %s", async (url, status) => {
    const response = await app.inject({ url: String(url) });
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("synthetic handler failure");
    expect(response.body).not.toContain("sensitive-url-value");
  });

  it("keeps malformed HEAD responses empty and oversized parameter errors private", async () => {
    const malformed = await app.inject({ method: "HEAD", url: "/%61pi/v1/%zz" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toBe("");
    expect(malformed.headers["cache-control"]).toBe("no-store");
    const oversized = await app.inject({ url: `/api/v1/records/${"x".repeat(400)}` });
    expect(oversized.statusCode).toBe(404);
    expect(oversized.headers["cache-control"]).toBe("no-store");
  });

  it.each(["/login", "/apiculture", "/assets/public-01234567.js"])(
    "preserves normal public Web caching for %s",
    async (url) => {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"] ?? "").not.toContain("no-store");
      expect(response.body).not.toContain("privateFixture");
    },
  );

  it("does not turn double encoding into a sensitive handler", async () => {
    const response = await app.inject({
      url: "/%2561pi/v1/bootstrap",
      headers: { cookie: "fixture-session=valid" },
    });
    expect(response.body).not.toContain("privateFixture");
  });
});
