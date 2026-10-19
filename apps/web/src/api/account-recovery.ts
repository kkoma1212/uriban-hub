import { apiFetch, parseResponse } from "./auth";

export async function requestAccountRecovery(email: string): Promise<{ request_accepted: true }> {
  const response = await apiFetch("/api/v1/auth/account-recovery-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  return parseResponse<{ request_accepted: true }>(response);
}
