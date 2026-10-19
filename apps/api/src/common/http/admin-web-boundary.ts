import { posix } from "node:path";

/** Match before static resolution, including Windows case and path aliases. */
export function isAdministratorWebPath(requestUrl: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.split("?", 1)[0] ?? "");
  } catch {
    // Malformed paths are rejected by the existing static/SPA path validators.
    return false;
  }
  const normalized = posix.normalize(pathname.replace(/\\/gu, "/"));
  return /^\/admin(?:\/|$)|^\/assets\/admin(?:[-/.]|$)/iu.test(normalized);
}
