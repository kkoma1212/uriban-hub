import { describe, expect, it } from "vitest";

import { registerHttpRequestForLog } from "./http-observability.js";
import { requestPathForLog, serializeRequestForLog } from "./request-log-url.js";

describe("requestPathForLog", () => {
  it.each([
    ["/verify-email?token=secret", "/verify-email"],
    ["/reset-password?token=secret#ignored", "/reset-password"],
    ["/api/v1/notices?cursor=opaque&query=student", "/api/v1/notices"],
    ["https://classhub.example/search?q=private", "/search"],
    ["//classhub.example/supplies?scope=past", "/supplies"],
    ["/encoded%2Fpath?token=secret", "/encoded%2Fpath"],
    ["*", "*"],
  ])("keeps only the request path for %s", (requestUrl, expected) => {
    expect(requestPathForLog(requestUrl)).toBe(expected);
  });

  it.each([undefined, null, "", "http://["])(
    "fails closed for malformed request targets",
    (requestUrl) => {
      expect(requestPathForLog(requestUrl)).toBe("/");
    },
  );
});

describe("serializeRequestForLog", () => {
  it("allowlists request metadata and removes query values from the serialized JSON", () => {
    const request = {
      id: "request-id",
      method: "GET",
      routeOptions: { url: "/search" },
      url: "/search?token=query-secret&q=private-student-name",
      headers: {
        accept: "application/json",
        baggage: "student=private-student-name",
        "proxy-authorization": "Bearer proxy-secret",
        "x-api-key": "api-secret",
      },
      remoteAddress: "127.0.0.1",
      remotePort: 43210,
      query: { token: "query-secret", q: "private-student-name" },
      body: { password: "body-secret" },
    };
    registerHttpRequestForLog(request);
    const serialized = serializeRequestForLog(request);
    const json = JSON.stringify(serialized);

    expect(serialized).toEqual({
      method: "GET",
      request_id: "unknown",
      route: "/search",
    });
    expect(serialized).not.toHaveProperty("headers");
    expect(serialized).not.toHaveProperty("remoteAddress");
    expect(serialized).not.toHaveProperty("remotePort");
    expect(json).not.toContain("query-secret");
    expect(json).not.toContain("private-student-name");
    expect(json).not.toContain("body-secret");
    expect(json).not.toContain("proxy-secret");
    expect(json).not.toContain("api-secret");
  });
});
