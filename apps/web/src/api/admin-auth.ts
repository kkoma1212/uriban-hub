import { ApiRequestError, apiFetch, parseResponse } from "./auth";
import { adminFetch } from "./admin-request";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  notifyAdminSessionEnded,
  rememberAdminSessionDeadline,
} from "../lib/admin-session-privacy";

const ADMIN_CSRF_COOKIE_NAME = "__Host-classhub_admin_csrf";
export { ADMIN_SESSION_EXPIRED_EVENT };

export async function parseAdminResponse<T>(
  response: Response,
  isCurrent: () => boolean = () => true,
): Promise<T> {
  try {
    if (!isCurrent()) throw new ApiRequestError("REQUEST_ABORTED", "요청이 취소되었습니다.", 0);
    const result = await parseResponse<T>(response);
    if (!isCurrent()) throw new ApiRequestError("REQUEST_ABORTED", "요청이 취소되었습니다.", 0);
    return result;
  } catch (error) {
    if (!isCurrent()) throw new ApiRequestError("REQUEST_ABORTED", "요청이 취소되었습니다.", 0);
    if (error instanceof ApiRequestError && error.code === "ADMIN_SESSION_REQUIRED") {
      window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
    }
    throw error;
  }
}

export type AdminRole = "account_manager" | "security_auditor" | "super_admin" | "support";

export interface AdminSessionResponse {
  server_now?: string;
  account: {
    display_name: string;
    email: string;
    id: string;
    roles: AdminRole[];
  };
  session: {
    absolute_expires_at: string;
    issued_at: string;
    last_seen_at: string;
    mfa_verified_at: string;
    reauthenticated_at: string | null;
  };
}

export interface AdminLoginResponse {
  methods?: ("totp" | "passkey" | "recovery")[];
  challenge_expires_at: string;
  next_step: "enroll_totp" | "verify_totp";
  setup?: {
    manual_key: string;
    otpauth_uri: string;
  };
}

export function readAdminCsrfCookie(): string {
  const prefix = `${ADMIN_CSRF_COOKIE_NAME}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (value === undefined || value.length === 0) {
    throw new Error("관리자 보안 쿠키가 없습니다. 다시 로그인해 주세요.");
  }
  return value;
}

export async function beginAdminLogin(
  identifier: string,
  password: string,
): Promise<AdminLoginResponse> {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  // Keep the existing email-backed account and MFA flow for the owner's short login ID.
  const email = normalizedIdentifier === "admin" ? "admin@classhub.local" : normalizedIdentifier;
  const response = await apiFetch("/api/v1/admin/auth/login", {
    body: JSON.stringify({ email, password }),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return parseResponse<AdminLoginResponse>(response);
}

export async function completeAdminTotp(totpCode: string): Promise<AdminSessionResponse> {
  const response = await apiFetch("/api/v1/admin/auth/totp", {
    body: JSON.stringify({ totp_code: totpCode }),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return parseResponse<AdminSessionResponse>(response);
}

export async function getAdminSession(signal?: AbortSignal): Promise<AdminSessionResponse> {
  const startedAt = performance.now();
  const response = await apiFetch("/api/v1/admin/auth/session", {
    credentials: "include",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  const session = await parseAdminResponse<AdminSessionResponse>(response);
  rememberAdminSessionDeadline(session, startedAt);
  return session;
}

export async function logoutAdmin(): Promise<void> {
  const response = await apiFetch("/api/v1/admin/auth/logout", {
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Admin-CSRF": readAdminCsrfCookie() },
    method: "POST",
    body: "{}",
  });
  await parseAdminResponse<{ logged_out: true }>(response);
  notifyAdminSessionEnded();
}

export async function renewAdminSession(): Promise<AdminSessionResponse> {
  const startedAt = performance.now();
  const response = await apiFetch("/api/v1/admin/auth/renew", {
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Admin-CSRF": readAdminCsrfCookie() },
    method: "POST",
    body: "{}",
  });
  const session = await parseAdminResponse<AdminSessionResponse>(response);
  rememberAdminSessionDeadline(session, startedAt);
  return session;
}

export async function stepUpAdmin(
  password: string,
  totpCode: string,
  signal?: AbortSignal,
): Promise<{
  reauthenticated_at: string;
  valid_until: string;
}> {
  const response = await apiFetch("/api/v1/admin/auth/step-up", {
    ...(signal === undefined ? {} : { signal }),
    body: JSON.stringify({ password, totp_code: totpCode }),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-CSRF": readAdminCsrfCookie(),
    },
    method: "POST",
  });
  return parseAdminResponse(response);
}

export async function changeAdminPassword(newPassword: string): Promise<void> {
  const response = await adminFetch("/api/v1/admin/auth/change-password", {
    body: JSON.stringify({ new_password: newPassword }),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-CSRF": readAdminCsrfCookie(),
    },
    method: "POST",
  });
  await parseAdminResponse<{ password_changed: true }>(response);
}
