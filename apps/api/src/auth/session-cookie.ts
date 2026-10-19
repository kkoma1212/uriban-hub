export const SESSION_COOKIE_NAME = "__Host-classhub_session";
export const CSRF_COOKIE_NAME = "__Host-classhub_csrf";

interface CookieOptions {
  expires: Date;
  httpOnly: boolean;
  maxAgeSeconds: number;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `Expires=${options.expires.toUTCString()}`,
    "Secure",
    "SameSite=Lax",
  ];

  if (options.httpOnly) {
    attributes.push("HttpOnly");
  }

  return attributes.join("; ");
}

export function createSessionCookies(
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): string[] {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));

  return [
    serializeCookie(SESSION_COOKIE_NAME, sessionToken, {
      expires: expiresAt,
      httpOnly: true,
      maxAgeSeconds,
    }),
    serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
      expires: expiresAt,
      httpOnly: false,
      maxAgeSeconds,
    }),
  ];
}

export function createCsrfCookie(csrfToken: string, expiresAt: Date): string {
  return serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
    expires: expiresAt,
    httpOnly: false,
    maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
  });
}

export function clearSessionCookies(): string[] {
  const expires = new Date(0);

  return [
    serializeCookie(SESSION_COOKIE_NAME, "", { expires, httpOnly: true, maxAgeSeconds: 0 }),
    serializeCookie(CSRF_COOKIE_NAME, "", { expires, httpOnly: false, maxAgeSeconds: 0 }),
  ];
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return undefined;
}
