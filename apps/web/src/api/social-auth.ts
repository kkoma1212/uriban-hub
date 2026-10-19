import { apiFetch, parseResponse, withCsrfRecovery, type SignUpRequest } from "./auth";

export type SocialProvider = "google" | "naver" | "kakao";
export const socialProviderLabels: Record<SocialProvider, string> = {
  google: "구글",
  naver: "네이버",
  kakao: "카카오",
};
export function isSocialProvider(value: string): value is SocialProvider {
  return Object.hasOwn(socialProviderLabels, value);
}
export interface PendingSocialSignup {
  provider: SocialProvider;
  email: string | null;
  email_verified: boolean;
  /** 회사 프로필 이름(닉네임) — 기본 이름을 미리 채운다. */
  display_name?: string | null;
  /** 회사 프로필 사진이 있고 이 서버에서 사진 기능이 켜져 있을 때만 true. */
  has_picture?: boolean;
}
export interface SocialConnections {
  enabled: boolean;
  providers?: SocialProvider[];
  connections: SocialProvider[];
  /** 연결 전에 현재 비밀번호로 본인을 확인해야 하는 계정(소셜로만 가입한 계정은 false). */
  password_required?: boolean;
}
export async function getSocialProviders(signal?: AbortSignal): Promise<SocialProvider[]> {
  const result = await parseResponse<{ providers: SocialProvider[] }>(
    await apiFetch("/api/v1/auth/social/providers", { signal: signal ?? null }),
  );
  return Array.isArray(result?.providers)
    ? result.providers.filter((provider) => Object.hasOwn(socialProviderLabels, provider))
    : [];
}
export async function beginSocialLogin(
  provider: SocialProvider,
  intent: "login" | "signup_over_14",
): Promise<string> {
  const result = await parseResponse<{ authorization_url: string }>(
    await apiFetch(`/api/v1/auth/social/${provider}/start`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent }),
    }),
  );
  return result.authorization_url;
}
export async function getPendingSocialSignup(signal?: AbortSignal): Promise<PendingSocialSignup> {
  return parseResponse(
    await apiFetch("/api/v1/auth/social/signup", {
      credentials: "include",
      signal: signal ?? null,
    }),
  );
}
/**
 * 'LOGIN'이면 서버가 일반 가입처럼 중립 응답을 준 것(이미 가입된 이메일 등, 총검수 I1-05).
 * 화면은 일반 가입과 똑같이 로그인 안내로 보낸다.
 */
export async function socialSignUp(
  request: SignUpRequest & { use_provider_picture?: boolean },
): Promise<{ next_action: "BOOTSTRAP" | "LOGIN" }> {
  // Reuse the complete age/guardian/consent contract, but never send a password for social signup.
  const { password: _password, ...body } = request;
  return parseResponse(
    await apiFetch("/api/v1/auth/social/signup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
export async function cancelPendingSocialSignup(): Promise<void> {
  await parseResponse(
    await apiFetch("/api/v1/auth/social/signup/cancel", { method: "POST", credentials: "include" }),
  );
}
export async function getSocialConnections(signal?: AbortSignal): Promise<SocialConnections> {
  return parseResponse(
    await apiFetch("/api/v1/account/social", { credentials: "include", signal: signal ?? null }),
  );
}
async function mutateConnection<T>(
  provider: SocialProvider,
  action: "link" | "unlink",
  body?: Record<string, string>,
): Promise<T> {
  return withCsrfRecovery<T>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/account/social/${provider}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
export async function linkSocialAccount(
  provider: SocialProvider,
  currentPassword?: string,
): Promise<string> {
  return (
    await mutateConnection<{ authorization_url: string }>(
      provider,
      "link",
      currentPassword === undefined ? {} : { current_password: currentPassword },
    )
  ).authorization_url;
}
export async function unlinkSocialAccount(provider: SocialProvider): Promise<void> {
  await mutateConnection(provider, "unlink");
}
