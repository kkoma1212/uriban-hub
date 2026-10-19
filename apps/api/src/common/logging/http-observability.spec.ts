import { describe, expect, it } from "vitest";

import {
  canonicalRouteForLog,
  classifyHttpRequest,
  createHttpRequestCompletionLog,
  httpRequestLogLevel,
  recordHttpRequestFailureForLog,
  registerHttpRequestForLog,
} from "./http-observability.js";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

describe("HTTP observability allowlist", () => {
  it("correlates a denial across the Fastify request and its raw request", () => {
    const raw = {
      id: REQUEST_ID,
      method: "post",
      url: "/api/v1/notices/998877?student=private-name",
    };
    const request = {
      ...raw,
      raw,
      routeOptions: { url: "/api/v1/notices/:id" },
      headers: { cookie: "private-cookie" },
      body: { email: "student@example.invalid" },
    };

    registerHttpRequestForLog(request);
    recordHttpRequestFailureForLog(request, "ROLE_INSUFFICIENT");

    expect(
      createHttpRequestCompletionLog(raw, { statusCode: 403 }, { responseTime: 12.6 }),
    ).toEqual({
      action: "http.request.completed",
      duration_ms: 13,
      failure_code: "ROLE_INSUFFICIENT",
      method: "POST",
      outcome: "denied",
      route: "/api/v1/notices/:id",
      status_code: 403,
      user_impact: "access_denied",
    });
  });

  it.each([
    [200, "success", "none"],
    [302, "success", "none"],
    [400, "rejected", "request_rejected"],
    [401, "denied", "access_denied"],
    [403, "denied", "access_denied"],
    [429, "rejected", "request_rejected"],
    [500, "failed", "request_failed"],
    [503, "failed", "request_failed"],
  ] as const)("classifies status %i", (statusCode, outcome, userImpact) => {
    expect(classifyHttpRequest(statusCode)).toEqual({ outcome, userImpact });
  });

  it("fails closed for untrusted identifiers, routes, methods, durations, and failure codes", () => {
    const request = {
      id: "student@example.invalid",
      method: "GET\nprivate",
      routeOptions: { url: "/students/private student" },
    };
    registerHttpRequestForLog(request);
    recordHttpRequestFailureForLog(request, "postgresql://private-dsn");

    expect(
      createHttpRequestCompletionLog(request, { statusCode: 999 }, { responseTime: -1 }),
    ).toEqual({
      action: "http.request.completed",
      duration_ms: 0,
      failure_code: "INTERNAL_ERROR",
      method: "UNKNOWN",
      outcome: "failed",
      route: "/unknown",
      status_code: 500,
      user_impact: "request_failed",
    });
  });

  it("records only a validated base media type for a 415 failure", () => {
    const raw = {
      id: REQUEST_ID,
      method: "post",
      url: "/api/v1/auth/sign-up?student=private-name",
    };
    const request = {
      ...raw,
      raw,
      routeOptions: { url: "/api/v1/auth/sign-up" },
      headers: {
        "content-type": "Multipart/Form-Data; boundary=private-boundary",
        cookie: "private-cookie",
      },
      body: { email: "student@example.invalid" },
    };

    registerHttpRequestForLog(request);
    recordHttpRequestFailureForLog(request, "UNSUPPORTED_MEDIA_TYPE");
    const completion = createHttpRequestCompletionLog(
      raw,
      { statusCode: 415 },
      { responseTime: 2 },
    );

    expect(completion).toEqual({
      action: "http.request.completed",
      content_type: "multipart/form-data",
      duration_ms: 2,
      failure_code: "UNSUPPORTED_MEDIA_TYPE",
      method: "POST",
      outcome: "rejected",
      route: "/api/v1/auth/sign-up",
      status_code: 415,
      user_impact: "request_rejected",
    });
    expect(JSON.stringify(completion)).not.toContain("private-boundary");
    expect(JSON.stringify(completion)).not.toContain("private-name");
    expect(JSON.stringify(completion)).not.toContain("student@example.invalid");
  });

  it("fails closed for an invalid 415 media type and omits it from other failures", () => {
    const unsupported = {
      headers: { "content-type": "student@example.invalid\nprivate" },
      method: "POST",
      routeOptions: { url: "/api/v1/notices" },
    };
    registerHttpRequestForLog(unsupported);
    recordHttpRequestFailureForLog(unsupported, "UNSUPPORTED_MEDIA_TYPE");
    expect(createHttpRequestCompletionLog(unsupported, { statusCode: 415 }, {})).toHaveProperty(
      "content_type",
      "unknown",
    );

    const ordinary = {
      headers: { "content-type": "application/json; student=private" },
      method: "POST",
      routeOptions: { url: "/api/v1/notices" },
    };
    registerHttpRequestForLog(ordinary);
    recordHttpRequestFailureForLog(ordinary, "VALIDATION_FAILED");
    expect(createHttpRequestCompletionLog(ordinary, { statusCode: 400 }, {})).not.toHaveProperty(
      "content_type",
    );
  });
});

describe("HTTP observability route and level policy", () => {
  it.each([
    ["/api/v1/notices/:id?token=secret#private", "/api/v1/notices/:id"],
    ["/healthz", "/healthz"],
    ["/*", "/*"],
    ["/students/private student", "/unknown"],
    ["private/path", "/unknown"],
    [undefined, "/unknown"],
  ])("canonicalizes %s", (route, expected) => {
    expect(canonicalRouteForLog(route)).toBe(expected);
  });

  it.each([
    [200, undefined, "info"],
    [403, undefined, "warn"],
    [503, undefined, "error"],
    [200, new Error("socket failed"), "error"],
  ] as const)("selects a level for status %i", (statusCode, error, expected) => {
    expect(httpRequestLogLevel({}, { statusCode }, error)).toBe(expected);
  });
});
