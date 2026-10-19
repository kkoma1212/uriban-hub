export interface PublicSystemState {
  maintenance: boolean;
  announcement: string | null;
}

export function publicSystemState(
  rows: ReadonlyArray<{ key: string; value_json: unknown }>,
): PublicSystemState {
  const value = (key: string): Record<string, unknown> | undefined => {
    const matches = rows.filter((row) => row.key === key);
    if (matches.length > 1) throw new Error("DUPLICATE_SYSTEM_STATE");
    if (matches.length === 0) return undefined;
    const raw = matches[0]!.value_json;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("INVALID_SYSTEM_STATE");
    const result = parsed as Record<string, unknown>;
    if (typeof result.enabled !== "boolean") throw new Error("INVALID_SYSTEM_STATE");
    return result;
  };
  const maintenance = value("maintenance_mode");
  const notice = value("announcement");
  if (
    notice?.enabled &&
    (typeof notice.message !== "string" ||
      notice.message.trim().length === 0 ||
      [...notice.message].length > 500)
  )
    throw new Error("INVALID_ANNOUNCEMENT");
  return {
    maintenance: maintenance?.enabled === true,
    announcement: notice?.enabled ? (notice.message as string).trim() : null,
  };
}

const recoveryRoutes = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/csrf-token",
  "/api/v1/auth/password-reset-requests",
  "/api/v1/auth/password-resets/confirm",
  "/api/v1/auth/account-recovery-requests",
  "/api/v1/auth/email-verifications/confirm",
  "/api/v1/auth/email-verifications/resend",
  "/api/v1/auth/social/signup/cancel",
  "/api/v1/account/deletion",
]);

/** New proposed maintenance contract; matched route templates avoid encoded-path bypasses. */
export function requiresMaintenanceCheck(method: string, route: string, body?: unknown): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
  const path = route.replace(/\/+$/, "");
  if (!path.startsWith("/api/v1/") || path.startsWith("/api/v1/admin/") || path === "/api/v1/admin")
    return false;
  if (recoveryRoutes.has(path)) return false;
  if (
    path === "/api/v1/auth/social/:provider/start" &&
    typeof body === "object" &&
    body !== null &&
    ((body as Record<string, unknown>).intent === "login" ||
      (body as Record<string, unknown>).intent === undefined)
  )
    return false;
  return true;
}
