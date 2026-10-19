import type { AppEnvironment } from "../../config/environment.js";

const COMMON_SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
} as const;

function createContentSecurityPolicy(development: boolean, productionHttps: boolean): string {
  const directives = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    development ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'",
    "script-src-attr 'none'",
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    development ? "img-src 'self' data: blob:" : "img-src 'self' data:",
    "font-src 'self'",
    development ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    "manifest-src 'self'",
    development ? "worker-src 'self' blob:" : "worker-src 'self'",
  ];

  if (productionHttps) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

export function createSecurityHeaders(
  environment: Pick<AppEnvironment, "NODE_ENV" | "PUBLIC_APP_ORIGIN"> &
    Partial<Pick<AppEnvironment, "PUBLIC_PREVIEW_ENABLED">>,
): Readonly<Record<string, string>> {
  const development = environment.NODE_ENV === "development";
  const productionHttps =
    (environment.NODE_ENV === "production" || environment.PUBLIC_PREVIEW_ENABLED === true) &&
    new URL(environment.PUBLIC_APP_ORIGIN).protocol === "https:";
  const headers: Record<string, string> = {
    ...COMMON_SECURITY_HEADERS,
    "Content-Security-Policy": createContentSecurityPolicy(development, productionHttps),
  };

  if (productionHttps) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }

  return headers;
}
