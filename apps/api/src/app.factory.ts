import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyReply } from "fastify";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { HttpErrorFilter } from "./common/errors/http-error.filter.js";
import { recordServerResponseStatus } from "./common/observability/server-error-window.js";
import { isAdministratorWebPath } from "./common/http/admin-web-boundary.js";
import { isOutsideAdminSurfaceApi } from "./common/http/api-surface-boundary.js";
import { createSecurityHeaders } from "./common/http/security-headers.js";
import { registerHttpRequestForLog } from "./common/logging/http-observability.js";
import { createRequestId } from "./common/request/request-id.js";
import { withRequestLimitContext } from "./common/rate-limit/request-limit-context.js";
import type { AppEnvironment } from "./config/environment.js";
import { DATABASE, type ClassHubDatabase } from "./database/database.module.js";
import { assertNativeClassAssessmentQaReadiness } from "./config/native-class-assessment-qa-readiness.js";
import { applyOpenApiContract } from "./openapi/contract.js";
import { SecurityAuditHttpProducer } from "./security-audit/security-audit-http.producer.js";

export interface ClassHubApplication {
  app: NestFastifyApplication;
  environment: AppEnvironment;
}

interface ApplicationFactoryOptions {
  environment?: AppEnvironment;
  webRoot?: string;
}

function isSensitiveResponsePath(pathname: string | undefined): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/readyz" ||
    pathname === "/api" ||
    pathname?.startsWith("/api/") === true
  );
}

function requiresNoStore(requestUrl: string, routeUrl: string | undefined): boolean {
  // Bind the policy to the matched route; raw and routed paths may encode letters differently.
  if (isSensitiveResponsePath(routeUrl)) return true;
  const queryStart = requestUrl.indexOf("?");
  const pathname = queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
  try {
    // Unmatched API routes still need the policy. Decode once, without changing routing.
    return isSensitiveResponsePath(decodeURIComponent(pathname));
  } catch {
    return true;
  }
}

function isSpaFallbackPath(requestUrl: string): boolean {
  const queryStart = requestUrl.indexOf("?");
  const rawPathname = queryStart === -1 ? requestUrl : requestUrl.slice(0, queryStart);
  let pathname: string;

  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return false;
  }

  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/healthz" ||
    pathname.startsWith("/healthz/") ||
    pathname === "/readyz" ||
    pathname.startsWith("/readyz/") ||
    pathname === "/assets" ||
    pathname.startsWith("/assets/")
  ) {
    return false;
  }

  return !pathname.split("/").some((segment) => segment.includes("."));
}

function staticWebPath(requestUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.split("?", 1)[0]!);
  } catch {
    return undefined;
  }
  if (
    /^\/(?:api|healthz|readyz)(?:\/|$)/u.test(pathname) ||
    /(?:^|\/)\.|[\\%\0]/u.test(pathname) ||
    !/\.(?:html|css|js|mjs|json|webmanifest|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|txt)$/iu.test(
      pathname,
    )
  )
    return undefined;
  return pathname.slice(1);
}

/*
 * 빌드가 내용 해시를 이름에 붙인 파일(assets/이름-8자.확장자)은 내용이 바뀌면 이름도 바뀌므로 1년 보관해도 안전하다.
 * index.html·sw.js·manifest처럼 이름이 고정된 파일은 기존대로 매번 확인한다(max-age=0) — 새 배포가 바로 보이게.
 */
const HASHED_WEB_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u;
const HASHED_WEB_ASSET_CACHE = { maxAge: 365 * 24 * 60 * 60 * 1000, immutable: true };

function sendWebFile(reply: FastifyReply, asset: string): FastifyReply {
  return HASHED_WEB_ASSET.test(asset)
    ? reply.sendFile(asset, HASHED_WEB_ASSET_CACHE)
    : reply.sendFile(asset);
}

function configureGlobalPrefix(app: NestFastifyApplication): void {
  app.setGlobalPrefix("api/v1", {
    exclude: [
      { path: "healthz", method: RequestMethod.GET },
      { path: "readyz", method: RequestMethod.GET },
    ],
  });
}

export function createApplicationHttpAdapter(
  environment: Pick<AppEnvironment, "TRUSTED_PROXY_HOPS" | "TRUSTED_PROXY_ADDRESSES">,
): FastifyAdapter {
  const trustedProxies = new BlockList();
  for (const value of environment.TRUSTED_PROXY_ADDRESSES.split(",")) {
    const address = value.trim();
    trustedProxies.addAddress(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return new FastifyAdapter({
    // Keep the socket alive beyond the browser's 20-second request budget.
    // Ancillary SMTP can time out after ten seconds, after a mutation commits.
    connectionTimeout: 30_000,
    genReqId: createRequestId,
    keepAliveTimeout: 65_000,
    requestTimeout: 30_000,
    routerOptions: {
      // Malformed URLs precede onSend. Preserve the 400 contract without echoing the URL.
      onBadUrl: (_path: string, request: IncomingMessage, response: ServerResponse) => {
        const body = JSON.stringify({
          code: "FST_ERR_BAD_URL",
          error: "Bad Request",
          message: "Malformed request URL",
          statusCode: 400,
        });
        response.writeHead(400, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "X-Content-Type-Options": "nosniff",
          "x-request-id": createRequestId(),
        });
        response.end(request.method === "HEAD" ? undefined : body);
      },
    },
    // Fastify 5.12.1 rejects numeric trust: hop count alone trusts direct attackers.
    // Check the actual connecting address as well as the configured chain length.
    trustProxy:
      environment.TRUSTED_PROXY_HOPS === 0
        ? false
        : (address, hop) =>
            hop < environment.TRUSTED_PROXY_HOPS &&
            isIP(address) !== 0 &&
            trustedProxies.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"),
  });
}

export async function createApplication(
  options: ApplicationFactoryOptions = {},
): Promise<ClassHubApplication> {
  const configuredModule = await AppModule.configure(options.environment);
  const { environment } = configuredModule;
  const adapter = createApplicationHttpAdapter(environment);
  const app = await NestFactory.create<NestFastifyApplication>(configuredModule.module, adapter, {
    bufferLogs: true,
    abortOnError: false,
  });

  app.useLogger(app.get(Logger));
  configureGlobalPrefix(app);
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter(app.get(SecurityAuditHttpProducer)));

  const fastify = app.getHttpAdapter().getInstance();
  const securityHeaders = createSecurityHeaders(environment);

  fastify
    .addHook("onRequest", (request, reply, done) => {
      registerHttpRequestForLog(request);
      void reply.header("x-request-id", request.id);
      // 관리자 프로그램은 관리자 API(+약관 읽기·화면 오류 기록)만 받는다(api-surface-boundary.ts).
      if (environment.API_SURFACE === "admin" && isOutsideAdminSurfaceApi(request.url)) {
        void reply.header("Cache-Control", "no-store");
        reply.callNotFound();
        return;
      }
      withRequestLimitContext(reply, done);
    })
    .addHook("onSend", (request, reply, payload, done) => {
      for (const [name, value] of Object.entries(securityHeaders)) {
        void reply.header(name, value);
      }

      if (requiresNoStore(request.url, request.routeOptions.url)) {
        void reply.header("Cache-Control", "no-store");
      }
      done(null, payload);
    })
    .addHook("onResponse", (_request, reply, done) => {
      recordServerResponseStatus(reply.statusCode);
      done();
    });

  if (environment.SERVE_WEB) {
    // 관리자 프로그램은 관리자 화면 묶음(AdminWeb/, 입구 admin/index.html), 그 밖은 학생·교사 묶음(Web/).
    const servesAdminScreens = environment.API_SURFACE === "admin";
    const webRoot =
      options.webRoot ??
      fileURLToPath(
        new URL(servesAdminScreens ? "../../../AdminWeb/" : "../../../Web/", import.meta.url),
      );
    const indexEntry = servesAdminScreens ? "admin/index.html" : "index.html";
    const indexFile = resolve(webRoot, indexEntry);

    if (!existsSync(indexFile)) {
      throw new Error(`Web build output is missing: ${indexFile}`);
    }

    await app.register(fastifyStatic, {
      root: webRoot,
      // Resolve each request from Web so newly deployed hashed files work without a restart.
      serve: false,
    });

    fastify.get("/*", { exposeHeadRoute: false }, (request, reply) => {
      if (!environment.ADMIN_WEB_ENABLED && isAdministratorWebPath(request.url)) {
        void reply.header("Cache-Control", "no-store");
        return reply.callNotFound();
      }
      const asset = staticWebPath(request.url);
      if (asset !== undefined) return sendWebFile(reply, asset);
      if (!isSpaFallbackPath(request.url)) {
        return reply.callNotFound();
      }

      return reply.sendFile(indexEntry);
    });
    fastify.head("/*", (request, reply) => {
      if (!environment.ADMIN_WEB_ENABLED && isAdministratorWebPath(request.url)) {
        void reply.header("Cache-Control", "no-store");
        return reply.callNotFound();
      }
      const asset = request.url.split("?", 1)[0] === "/" ? indexEntry : staticWebPath(request.url);
      return asset === undefined ? reply.callNotFound() : sendWebFile(reply, asset);
    });
  }

  if (environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED) {
    try {
      await assertNativeClassAssessmentQaReadiness(
        environment,
        app.get<ClassHubDatabase>(DATABASE),
      );
    } catch {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
      } catch {
        /* Startup fails without exposing driver diagnostics. */
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      throw new Error("반 연결 QA 데이터베이스 시작 검증에 실패했습니다.");
    }
  }
  await app.init();
  await fastify.ready();

  return { app, environment };
}

export async function createOpenApiApplication(
  environment: AppEnvironment,
): Promise<NestFastifyApplication> {
  const configuredModule = await AppModule.configure(environment);
  const app = await NestFactory.create<NestFastifyApplication>(
    configuredModule.module,
    new FastifyAdapter(),
    {
      logger: false,
      preview: true,
    },
  );

  configureGlobalPrefix(app);
  return app;
}

export function createOpenApiDocument(app: NestFastifyApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle("우리반 허브 API")
    .setDescription("우리반 허브 MVP-0 REST API")
    .setVersion("1.0.0")
    .build();

  return applyOpenApiContract(SwaggerModule.createDocument(app, configuration));
}
