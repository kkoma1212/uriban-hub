import type { AdminRole } from "@classhub/db";

export const ADMIN_SESSION_LIFETIME_MS = 30 * 60 * 1_000;
/** 연장 버튼으로 무한히 늘지 않게 로그인(2단계 인증)부터 최대 12시간(총검수 I1-12, 권고 8~12시간). */
export const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
export const ADMIN_STEP_UP_LIFETIME_MS = 5 * 60 * 1_000;

export interface AdminRequestMetadata {
  clientIp: string;
  requestId: string;
  userAgent: string | string[] | undefined;
}

export interface AdminChallengeResult {
  challengeExpiresAt: Date;
  challengeToken: string;
  nextStep: "enroll_totp" | "verify_totp";
  methods?: ("totp" | "passkey" | "recovery")[];
  setup?: {
    manualKey: string;
    otpAuthUri: string;
  };
}

export interface AuthenticatedAdminSession {
  absoluteExpiresAt: Date;
  adminAccountId: string;
  csrfTokenHash: Buffer;
  displayName: string;
  email: string;
  issuedAt: Date;
  lastSeenAt: Date;
  mfaVerifiedAt: Date;
  reauthenticatedAt: Date | null;
  roles: AdminRole[];
  sessionId: string;
}

export interface AdminSessionIssueResult {
  csrfToken: string;
  session: AuthenticatedAdminSession;
  sessionToken: string;
}
