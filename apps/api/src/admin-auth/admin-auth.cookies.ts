import { readCookie } from "../auth/session-cookie.js";

export const ADMIN_CHALLENGE_COOKIE_NAME = "__Host-classhub_admin_challenge";
export const ADMIN_SESSION_COOKIE_NAME = "__Host-classhub_admin_session";
export const ADMIN_CSRF_COOKIE_NAME = "__Host-classhub_admin_csrf";

interface CookieOptions {
  expires: Date;
  httpOnly: boolean;
}

function serialize(name: string, value: string, options: CookieOptions): string {
  const maxAge = Math.max(0, Math.floor((options.expires.getTime() - Date.now()) / 1_000));
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    `Expires=${options.expires.toUTCString()}`,
    "Secure",
    "SameSite=Strict",
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function clear(name: string, httpOnly: boolean): string {
  return serialize(name, "", { expires: new Date(0), httpOnly });
}

export function createAdminChallengeCookie(token: string, expiresAt: Date): string {
  return serialize(ADMIN_CHALLENGE_COOKIE_NAME, token, { expires: expiresAt, httpOnly: true });
}

export function createAdminSessionCookies(
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): string[] {
  return [
    serialize(ADMIN_SESSION_COOKIE_NAME, sessionToken, { expires: expiresAt, httpOnly: true }),
    serialize(ADMIN_CSRF_COOKIE_NAME, csrfToken, { expires: expiresAt, httpOnly: false }),
  ];
}

export function clearAdminChallengeCookie(): string {
  return clear(ADMIN_CHALLENGE_COOKIE_NAME, true);
}

export function clearAdminSessionCookies(): string[] {
  return [clear(ADMIN_SESSION_COOKIE_NAME, true), clear(ADMIN_CSRF_COOKIE_NAME, false)];
}

export function readAdminCookie(
  cookieHeader: string | undefined,
  name:
    | typeof ADMIN_CHALLENGE_COOKIE_NAME
    | typeof ADMIN_CSRF_COOKIE_NAME
    | typeof ADMIN_SESSION_COOKIE_NAME,
): string | undefined {
  return readCookie(cookieHeader, name);
}
