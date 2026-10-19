import type { LegalConsentSnapshot } from "../legal/legal-consent-snapshot.js";

export interface AuthConfig {
  agePolicyVersion: string;
  emailHmacKey: string;
  emailHmacKeyVersion: string;
  privacyPolicyVersion: string;
  termsPolicyVersion: string;
}

export interface SignUpCommand {
  legal_documents?: LegalConsentSnapshot;
  age_route: "guardian_consent" | "over_14";
  /** YYYY-MM-DD. 생년월일 칸이 설치된 환경(USER_BIRTH_DATES_DATABASE_INSTALLED)에서만 받는다. */
  birth_date?: string;
  /** Compatibility with clients that already received an approval before registration. */
  approval_code?: string;
  consents: {
    privacy: true;
    terms: true;
  };
  display_name: string;
  email: string;
  guardian_consent?: GuardianConsentReference;
  password: string;
  role: "student" | "teacher";
}

export interface GuardianConsentReference {
  completion_token: string;
  request_id: string;
}

export interface GuardianConsentRequestResult {
  completion_token: string;
  consent_delivery_status: "failed" | "sent";
  expires_at: string;
  request_id: string;
}

export interface GuardianConsentConfirmResult {
  guardian_consent: true;
}

export interface GuardianConsentStatusResult {
  status: "approved" | "expired" | "pending";
}

export interface SignUpResult {
  next_action: "LOGIN";
  signup_delivery_status: "failed" | "sent";
}

export interface AuthRequestContext {
  requestId: string;
  userAgent: string | undefined;
}

export interface ConfirmEmailResult {
  email_verified: true;
  next_action: "LOGIN";
}

export interface ResendEmailResult {
  verification_delivery_status: "failed" | "sent";
}

export interface LoginCommand {
  email: string;
  password: string;
}

export interface LoginResult {
  next_action: "BOOTSTRAP";
}

export interface LoginSession extends LoginResult {
  csrfToken: string;
  expiresAt: Date;
  sessionToken: string;
}

export interface RefreshedCsrf {
  csrfToken: string;
  expiresAt: Date;
}

export interface SecurityAuditSessionIdentity {
  currentClassId: string | null;
  userId: string;
}

export interface AuthenticatedSession extends SecurityAuditSessionIdentity {
  expiresAt: Date;
  sessionId: string;
}

export interface AuthenticationOptions {
  allowUnverifiedEmail?: boolean;
  onSecurityAuditIdentity?: (identity: SecurityAuditSessionIdentity) => void;
}
