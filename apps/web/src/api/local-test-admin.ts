import { apiFetch, parseResponse } from "./auth";

const CSRF_COOKIE_NAME = "__Host-classhub_local_admin_csrf";

export interface LocalTestAccount {
  created_at: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  id: string;
  membership_count: number;
  session_count: number;
}

export interface CreateLocalTestAccountRequest {
  display_name: string;
  email: string;
  email_verified: boolean;
  password: string;
}

function readCsrfCookie(): string {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  if (value === undefined) throw new Error("관리자 CSRF cookie를 찾을 수 없습니다.");
  return value;
}

export async function loginLocalAdmin(username: string, password: string): Promise<void> {
  const response = await apiFetch("/api/v1/local-test-admin/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, username }),
  });
  await parseResponse<{ logged_in: true }>(response);
}

export async function logoutLocalAdmin(): Promise<void> {
  const response = await apiFetch("/api/v1/local-test-admin/logout", {
    method: "POST",
    credentials: "include",
  });
  await parseResponse<{ logged_out: true }>(response);
}

export async function listLocalTestAccounts(): Promise<LocalTestAccount[]> {
  const response = await apiFetch("/api/v1/local-test-admin/accounts", {
    credentials: "include",
  });
  const body = await parseResponse<{ accounts: LocalTestAccount[] }>(response);
  return body.accounts;
}

export async function createLocalTestAccount(
  request: CreateLocalTestAccountRequest,
): Promise<LocalTestAccount> {
  const response = await apiFetch("/api/v1/local-test-admin/accounts", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Admin-CSRF": readCsrfCookie(),
    },
    body: JSON.stringify(request),
  });
  return parseResponse<LocalTestAccount>(response);
}

export async function deleteLocalTestAccount(account: LocalTestAccount): Promise<void> {
  const response = await apiFetch(`/api/v1/local-test-admin/accounts/${account.id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Local-Admin-CSRF": readCsrfCookie(),
    },
    body: JSON.stringify({ email: account.email }),
  });
  await parseResponse(response);
}
