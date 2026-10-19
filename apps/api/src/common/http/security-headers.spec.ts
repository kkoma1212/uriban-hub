import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createSecurityHeaders } from "./security-headers.js";

const COMMON_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
};

describe("security response headers", () => {
  it("hardens explicit public preview HTTPS without subdomain or preload scope", () => {
    const headers = createSecurityHeaders({
      NODE_ENV: "test",
      PUBLIC_PREVIEW_ENABLED: true,
      PUBLIC_APP_ORIGIN: "https://synthetic-preview.trycloudflare.com",
    });
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(headers["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-");
  });
  it("keeps development HMR capabilities without enabling HSTS", () => {
    expect(
      createSecurityHeaders({
        NODE_ENV: "development",
        PUBLIC_APP_ORIGIN: "http://localhost:5173",
      }),
    ).toEqual({
      ...COMMON_HEADERS,
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' 'unsafe-eval'",
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' ws: wss:",
        "manifest-src 'self'",
        "worker-src 'self' blob:",
      ].join("; "),
    });
  });

  it("uses a strict production policy and HSTS without subdomain scope", () => {
    expect(
      createSecurityHeaders({
        NODE_ENV: "production",
        PUBLIC_APP_ORIGIN: "https://classhub.example",
      }),
    ).toEqual({
      ...COMMON_HEADERS,
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self'",
        "script-src-attr 'none'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "upgrade-insecure-requests",
      ].join("; "),
      "Strict-Transport-Security": "max-age=31536000",
    });
  });
});

it("keeps test responses strict without development allowances or HSTS", () => {
  const headers = createSecurityHeaders({
    NODE_ENV: "test",
    PUBLIC_APP_ORIGIN: "http://localhost:5173",
  });

  const policy = headers["Content-Security-Policy"];
  expect(policy).toContain("style-src 'self'");
  expect(policy).not.toContain("'unsafe-inline'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain("ws:");
  expect(headers["Strict-Transport-Security"]).toBeUndefined();
});

// Cloudflare Pages로 Web/만 올리면 API가 붙이던 헤더가 빠진다. apps/web/public/_headers가 운영 HTTPS
// 정책과 같아야 한다(총검수 I4-05).
it("keeps the Pages _headers file identical to the production HTTPS policy", () => {
  const file = readFileSync(new URL("../../../../web/public/_headers", import.meta.url), "utf8");
  const lines = file.split(/\r?\n/u).filter((line) => line.trim() !== "" && !line.startsWith("#"));
  expect(lines[0]).toBe("/*");
  const fromFile = Object.fromEntries(
    lines.slice(1).map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
  expect(fromFile).toEqual(
    createSecurityHeaders({
      NODE_ENV: "production",
      PUBLIC_APP_ORIGIN: "https://app.example.invalid",
    }),
  );
});
