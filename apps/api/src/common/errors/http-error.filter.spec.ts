import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  UnauthorizedException,
  type ArgumentsHost,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PasswordWorkCapacityError } from "@classhub/db";
import { ApiMariaDbDatabaseError } from "../../database/mariadb-database.js";

import { AccountLockedException, InvalidCredentialsException } from "../../auth/auth.errors.js";
import {
  createHttpRequestCompletionLog,
  registerHttpRequestForLog,
} from "../logging/http-observability.js";
import { HttpErrorFilter } from "./http-error.filter.js";

function filterCode(exception: HttpException): string {
  let body: unknown;
  const reply = {
    send: vi.fn((nextBody: unknown) => {
      body = nextBody;
    }),
    status: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: "00000000-0000-4000-8000-000000000000" }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;

  new HttpErrorFilter().catch(exception, host);
  return (body as { error: { code: string } }).error.code;
}

function filterError(exception: HttpException): {
  code: string;
  message: string;
  request_id: string;
} {
  let body: unknown;
  const reply = {
    send: vi.fn((nextBody: unknown) => {
      body = nextBody;
    }),
    status: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: "00000000-0000-4000-8000-000000000000" }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;

  new HttpErrorFilter().catch(exception, host);
  return (body as { error: { code: string; message: string; request_id: string } }).error;
}

describe("HttpErrorFilter fallback codes", () => {
  it.each([
    new PasswordWorkCapacityError(),
    new ApiMariaDbDatabaseError("connection_queue_full"),
    new ApiMariaDbDatabaseError("connection_timeout"),
    new ApiMariaDbDatabaseError("query_timeout"),
  ])("returns retryable 503 without internal details for %s", (error) => {
    const logging = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const reply = {
      header: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ id: "synthetic-request" }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    try {
      new HttpErrorFilter().catch(error, host);
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(reply.header).toHaveBeenCalledWith("Retry-After", "2");
      expect(reply.send).toHaveBeenCalledWith({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "요청을 처리하지 못했습니다.",
          request_id: "synthetic-request",
          details: { retry_after_seconds: 2, retry_at: expect.any(String) },
        },
      });
      expect(JSON.stringify(reply.send.mock.calls)).not.toMatch(/Maria|argon|queue|capacity/iu);
    } finally {
      logging.mockRestore();
    }
  });

  it.each([
    [new UnauthorizedException(), "UNAUTHENTICATED"],
    [new ForbiddenException(), "ROLE_INSUFFICIENT"],
    [new ConflictException(), "CONFLICT"],
    [new HttpException("Locked", HttpStatus.LOCKED), "CLASS_SUSPENDED"],
    [
      new HttpException("Precondition Required", HttpStatus.PRECONDITION_REQUIRED),
      "IF_MATCH_REQUIRED",
    ],
    [new HttpException("Too Many Requests", HttpStatus.TOO_MANY_REQUESTS), "RATE_LIMITED"],
  ])("maps an unstructured %s without reporting INTERNAL_ERROR", (exception, expectedCode) => {
    expect(filterCode(exception)).toBe(expectedCode);
  });

  it("maps an adapter payload limit error to a stable Korean client error", () => {
    const error = filterError(
      new HttpException(
        { error: "Payload Too Large", message: "Request body is too large", statusCode: 413 },
        HttpStatus.PAYLOAD_TOO_LARGE,
      ),
    );

    expect(error).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "요청 내용이 너무 큽니다. 입력 내용을 줄여 다시 시도해 주세요.",
      request_id: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("replaces only the router's 'Cannot GET' 404 text with Korean (B4-03)", () => {
    const router = filterError(
      new HttpException(
        { error: "Not Found", message: "Cannot GET /api/v1/class-chat", statusCode: 404 },
        HttpStatus.NOT_FOUND,
      ),
    );
    expect(router).toMatchObject({ code: "NOT_FOUND", message: "찾는 화면이나 기능이 없어요." });
    const service = filterError(new HttpException("공지를 찾지 못했어요.", HttpStatus.NOT_FOUND));
    expect(service).toMatchObject({ code: "NOT_FOUND", message: "공지를 찾지 못했어요." });
  });

  it("maps an unsupported request media type without exposing the adapter message", () => {
    const adapterMessage = "Unsupported Media Type: application/x-www-form-urlencoded";
    const error = filterError(
      new HttpException(
        {
          code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
          error: "Unsupported Media Type",
          message: adapterMessage,
          statusCode: 415,
        },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ),
    );

    expect(error).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요.",
      request_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(JSON.stringify(error)).not.toContain(adapterMessage);
  });

  it("adds the stable failure code to the correlated request completion event", () => {
    const raw = {
      id: "00000000-0000-4000-8000-000000000000",
      method: "GET",
    };
    const request = {
      ...raw,
      raw,
      routeOptions: { url: "/api/v1/notices/:id" },
    };
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    registerHttpRequestForLog(request);

    new HttpErrorFilter().catch(new ForbiddenException(), host);

    expect(createHttpRequestCompletionLog(raw, { statusCode: 403 }, { responseTime: 4 })).toEqual(
      expect.objectContaining({
        failure_code: "ROLE_INSUFFICIENT",
        outcome: "denied",
        route: "/api/v1/notices/:id",
        user_impact: "access_denied",
      }),
    );
  });
});

describe("HttpErrorFilter 5xx logging", () => {
  it("logs only stable classification fields and never the exception message or stack", () => {
    const requestId = "00000000-0000-4000-8000-000000000000";
    const secret = "postgresql://user:password@db.internal/student@example.com";
    const exception = new HttpException(
      { code: "HOME_UNAVAILABLE", message: secret },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ id: requestId }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      new HttpErrorFilter().catch(exception, host);

      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith({
        exception_name: "HttpException",
        failure_code: "HOME_UNAVAILABLE",
        request_id: requestId,
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("exception_message");
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("stack");
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(reply.send).toHaveBeenCalledWith({
        error: {
          code: "HOME_UNAVAILABLE",
          message: "요청을 처리하지 못했습니다.",
          request_id: requestId,
        },
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("HttpErrorFilter security audit isolation", () => {
  function loginHost(reply: { send: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          id: "00000000-0000-4000-8000-000000000000",
          ip: "127.0.0.1",
          method: "POST",
          routeOptions: { url: "/api/v1/auth/login" },
          url: "/api/v1/auth/login?token=query-token-sentinel",
          headers: {
            cookie: "private-cookie-sentinel",
            "user-agent": "test-agent",
          },
          body: {
            email: "student.sentinel@example.com",
            password: "password-sentinel-never-pass",
            token: "body-token-sentinel",
            dsn: "postgresql://user:password@db/private",
            stack: "stack-sentinel",
          },
        }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
  }

  it("passes only the email string to immediate HMAC and only opaque context to the producer", () => {
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const opaqueIdentity = { hmac: "opaque-hmac", keyVersion: "v1" };
    const producer = {
      createEmailIdentity: vi.fn().mockReturnValue(opaqueIdentity),
      recordFailure: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
    };

    new HttpErrorFilter(producer as never).catch(
      new InvalidCredentialsException(),
      loginHost(reply),
    );

    expect(producer.createEmailIdentity).toHaveBeenCalledOnce();
    expect(producer.createEmailIdentity).toHaveBeenCalledWith("student.sentinel@example.com");
    expect(producer.recordFailure).toHaveBeenCalledOnce();
    expect(producer.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        sanitizedPath: "/api/v1/auth/login",
      }),
      "INVALID_CREDENTIALS",
      opaqueIdentity,
    );
    const serializedArguments = JSON.stringify(producer.recordFailure.mock.calls);
    expect(serializedArguments).not.toContain("password-sentinel-never-pass");
    expect(serializedArguments).not.toContain("body-token-sentinel");
    expect(serializedArguments).not.toContain("private-cookie-sentinel");
    expect(serializedArguments).not.toContain("postgresql://");
    expect(serializedArguments).not.toContain("stack-sentinel");
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledOnce();
  });

  it("audits a structured foreign-code 429 with the stable rate-limit classification", () => {
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const producer = {
      createEmailIdentity: vi.fn().mockReturnValue(null),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };

    new HttpErrorFilter(producer as never).catch(
      new HttpException(
        { code: "FRAMEWORK_THROTTLED", message: "Too Many Requests" },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      loginHost(reply),
    );

    expect(producer.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", sanitizedPath: "/api/v1/auth/login" }),
      "RATE_LIMITED",
      null,
    );
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "FRAMEWORK_THROTTLED" }) }),
    );
  });

  it("preserves the trusted account-lock audit classification for its structured 429", () => {
    const reply = {
      header: vi.fn().mockReturnThis(),
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const opaqueIdentity = { hmac: "opaque-hmac", keyVersion: "v1" };
    const producer = {
      createEmailIdentity: vi.fn().mockReturnValue(opaqueIdentity),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    };

    new HttpErrorFilter(producer as never).catch(new AccountLockedException(60), loginHost(reply));

    expect(producer.createEmailIdentity).toHaveBeenCalledWith("student.sentinel@example.com");
    expect(producer.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        sanitizedPath: "/api/v1/auth/login",
      }),
      "ACCOUNT_LOCKED",
      opaqueIdentity,
    );
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "ACCOUNT_LOCKED" }),
      }),
    );
  });

  it("preserves the original response when audit enrichment throws synchronously", () => {
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const producer = {
      createEmailIdentity: vi.fn(() => {
        throw new Error("audit config unavailable");
      }),
      recordFailure: vi.fn(),
    };

    expect(() =>
      new HttpErrorFilter(producer as never).catch(
        new InvalidCredentialsException(),
        loginHost(reply),
      ),
    ).not.toThrow();

    expect(producer.recordFailure).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledOnce();
  });

  it("handles a rejected fire-and-forget producer promise without changing the response", async () => {
    const reply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
    const producer = {
      createEmailIdentity: vi.fn().mockReturnValue(null),
      recordFailure: vi.fn().mockRejectedValue(new Error("audit rejected")),
    };

    new HttpErrorFilter(producer as never).catch(
      new InvalidCredentialsException(),
      loginHost(reply),
    );
    await Promise.resolve();

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledOnce();
  });
});
