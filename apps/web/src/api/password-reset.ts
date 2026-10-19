import { apiFetch, parseResponse } from "./auth";
import { clearAuthenticatedClientState } from "../lib/authenticated-client-state";

export interface PasswordResetRequest {
  email: string;
}

export interface PasswordResetRequestResponse {
  request_accepted: true;
}

export interface ConfirmPasswordResetRequest {
  new_password: string;
  token: string;
}

export interface ConfirmPasswordResetResponse {
  next_action: "LOGIN";
  password_reset: true;
}

export async function requestPasswordReset(
  request: PasswordResetRequest,
): Promise<PasswordResetRequestResponse> {
  const response = await apiFetch("/api/v1/auth/password-reset-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseResponse<PasswordResetRequestResponse>(response);
}

export async function confirmPasswordReset(
  request: ConfirmPasswordResetRequest,
): Promise<ConfirmPasswordResetResponse> {
  const response = await apiFetch("/api/v1/auth/password-resets/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const result = await parseResponse<ConfirmPasswordResetResponse>(response);
  clearAuthenticatedClientState();
  return result;
}
