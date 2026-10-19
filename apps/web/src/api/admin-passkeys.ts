import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { apiFetch } from "./auth";
import { parseAdminResponse, readAdminCsrfCookie, type AdminSessionResponse } from "./admin-auth";
import { adminFetch } from "./admin-request";

export type AdminFactors =
  | { enabled: false }
  | {
      enabled: true;
      passkeys: { id: string; label: string; created_at: string; used_at: string | null }[];
      recovery_codes_remaining: number;
      totp_enabled: boolean;
    };

async function post<T>(
  path: string,
  body: unknown,
  authenticated: boolean,
  prompt = false,
  signal?: AbortSignal,
): Promise<T> {
  const fetcher = prompt ? adminFetch : apiFetch;
  const response = await fetcher(`/api/v1/admin/auth/${path}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    ...(signal ? { signal } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { "X-Admin-CSRF": readAdminCsrfCookie() } : {}),
    },
    body: JSON.stringify(body),
  });
  return parseAdminResponse<T>(response);
}

export async function getAdminFactors(signal?: AbortSignal): Promise<AdminFactors> {
  return parseAdminResponse(
    await apiFetch("/api/v1/admin/auth/factors", {
      credentials: "include",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    }),
  );
}
export async function completeAdminPasskey(): Promise<AdminSessionResponse> {
  const { ceremony_id, options } = await post<{
    ceremony_id: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("passkeys/login/options", {}, false);
  const response = await startAuthentication({ optionsJSON: options });
  return post("passkeys/login/verify", { ceremony_id, response }, false);
}
export function completeAdminRecovery(code: string): Promise<AdminSessionResponse> {
  return post("recovery/login", { recovery_code: code.trim() }, false);
}
export async function stepUpAdminPasskey(password: string, signal?: AbortSignal): Promise<void> {
  const { ceremony_id, options } = await post<{
    ceremony_id: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("passkeys/step-up/options", {}, true, false, signal);
  if (signal?.aborted) throw new DOMException("취소됨", "AbortError");
  const response = await startAuthentication({ optionsJSON: options });
  if (signal?.aborted) throw new DOMException("취소됨", "AbortError");
  await post("passkeys/step-up/verify", { password, ceremony_id, response }, true, false, signal);
}
export async function stepUpAdminRecovery(
  password: string,
  code: string,
  signal?: AbortSignal,
): Promise<void> {
  await post("recovery/step-up", { password, recovery_code: code.trim() }, true, false, signal);
}
export async function registerAdminPasskey(label: string): Promise<void> {
  const { ceremony_id, options } = await post<{
    ceremony_id: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>("passkeys/registration/options", {}, true, true);
  const response = await startRegistration({ optionsJSON: options });
  // A consumed ceremony must never be automatically replayed.
  await post("passkeys/registration/verify", { ceremony_id, response, label: label.trim() }, true);
}
export async function revokeAdminPasskey(credentialId: string): Promise<void> {
  await post("passkeys/revoke", { credential_id: credentialId }, true, true);
}
export function issueAdminRecoveryCodes(): Promise<{ codes: string[] }> {
  return post("recovery-codes", {}, true, true);
}
