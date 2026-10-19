export const LOCAL_ADMIN_SESSION_COOKIE = "__Host-classhub_local_admin";
export const LOCAL_ADMIN_CSRF_COOKIE = "__Host-classhub_local_admin_csrf";

function serialize(
  name: string,
  value: string,
  expires: Date,
  maxAgeSeconds: number,
  httpOnly: boolean,
): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Expires=${expires.toUTCString()}`,
    "Secure",
    "SameSite=Strict",
  ];
  if (httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

export function createLocalAdminCookies(
  sessionToken: string,
  csrfToken: string,
  expiresAt: Date,
): string[] {
  const maxAge = Math.max(0, (expiresAt.getTime() - Date.now()) / 1_000);
  return [
    serialize(LOCAL_ADMIN_SESSION_COOKIE, sessionToken, expiresAt, maxAge, true),
    serialize(LOCAL_ADMIN_CSRF_COOKIE, csrfToken, expiresAt, maxAge, false),
  ];
}

export function clearLocalAdminCookies(): string[] {
  const expired = new Date(0);
  return [
    serialize(LOCAL_ADMIN_SESSION_COOKIE, "", expired, 0, true),
    serialize(LOCAL_ADMIN_CSRF_COOKIE, "", expired, 0, false),
  ];
}
