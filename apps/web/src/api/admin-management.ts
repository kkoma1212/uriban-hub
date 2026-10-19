import { adminFetch as apiFetch } from "./admin-request";
import {
  parseAdminResponse as parseResponse,
  readAdminCsrfCookie,
  type AdminRole,
} from "./admin-auth";

export type AdminMemberStatus = "approved" | "pending" | "rejected" | "rejoin_allowed" | "removed";
export type AdminInquiryStatus = "closed" | "in_progress" | "open" | "resolved";
export type AdminSignupRole = "student" | "teacher";
export type AdminTermsConsentType = "privacy" | "terms";
export type AdminTermsDocumentType =
  "guardian_consent" | "privacy_consent" | "privacy_policy" | "terms";
export type AdminSystemStateKey = "announcement" | "maintenance_mode" | "request_limits";
export type AdminAccountStatus = "active" | "pending_mfa" | "revoked" | "suspended";

export interface ManagedAdminAccount {
  created_at: string;
  display_name: string;
  email: string;
  id: string;
  last_login_at: string | null;
  roles: AdminRole[];
  status: AdminAccountStatus;
  updated_at: string;
}

export interface AdminMember {
  account_active: boolean;
  class_id: string;
  /** 예: 2026학년도 2학년 3반 (총검수 C2-08) */
  class_label?: string;
  display_name: string;
  email: string;
  id: string;
  role: AdminSignupRole;
  status: AdminMemberStatus;
  school_name?: string | null;
  status_changed_at: string;
  student_number: number | null;
}

export interface AdminUser {
  created_at: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  id: string;
  is_active: boolean;
  signup_approved: boolean;
  updated_at: string;
}

export interface AdminAuditLog {
  action: string;
  created_at: string;
  deny_reason: string | null;
  event_id: string;
  failure_code: string | null;
  id: string;
  method: string;
  request_id: string;
  resource: string;
  sanitized_path: string;
  target_class_id: string | null;
}

export interface AdminAuthAuditLog {
  action: string;
  admin_account_id: string | null;
  actor_display_name?: string | null;
  created_at: string;
  deny_reason: string | null;
  event_id: string;
  id: string;
  request_id: string;
}

export interface AdminOperationAuditLog {
  action: string;
  actor_admin_account_id: string;
  actor_display_name?: string | null;
  after_json: unknown;
  before_json: unknown;
  created_at: string;
  event_id: string;
  id: string;
  reason: string | null;
  request_id: string;
  target_id: string;
  target_type: string;
}

export interface AdminInquiry {
  assigned_admin_account_id: string | null;
  body: string;
  created_at: string;
  id: string;
  internal_note: string | null;
  requester_user_id: string | null;
  responded_at: string | null;
  responded_by_admin_account_id: string | null;
  response: string | null;
  resolved_at: string | null;
  status: AdminInquiryStatus;
  subject: string;
  updated_at: string;
}

export interface AdminTermsVersion {
  content: string;
  content_sha256: string;
  created_at: string;
  created_by_admin_account_id: string;
  document_type: AdminTermsDocumentType;
  effective_at: string | null;
  id: string;
  policy_version: string;
  published_at: string | null;
  status: "draft" | "published" | "retired";
  title: string;
}

export interface AdminTermsConsent {
  accepted_at: string;
  consent_type: AdminTermsConsentType;
  id: string;
  policy_version: string;
  retention_expires_at: string | null;
  user_id: string;
  withdrawn_at: string | null;
}

export interface AdminSystemState {
  key: AdminSystemStateKey;
  updated_at: string;
  updated_by_admin_account_id: string;
  value_json: unknown;
}

function mutationHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Admin-CSRF": readAdminCsrfCookie(),
  };
}

function optionalSearch(values: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value.length > 0) search.set(key, value);
  }
  const query = search.toString();
  return query.length === 0 ? "" : `?${query}`;
}

export async function issueAdminSignupApproval(input: {
  email: string;
  role: AdminSignupRole;
}): Promise<{
  code: string;
  expires_at: string;
  id: string;
  email_delivery_status: "sent" | "failed" | "unknown";
}> {
  const response = await apiFetch("/api/v1/admin/signup-approvals", {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  const result = await parseResponse<{
    code: string;
    email_delivery_status?: "sent" | "failed";
    expiresAt?: string;
    expires_at?: string;
    id: string;
  }>(response);
  const expiresAt = result.expires_at ?? result.expiresAt;
  if (expiresAt === undefined) throw new Error("승인번호 만료 시각을 확인하지 못했습니다.");
  return {
    code: result.code,
    expires_at: expiresAt,
    id: result.id,
    email_delivery_status:
      result.email_delivery_status === "sent" || result.email_delivery_status === "failed"
        ? result.email_delivery_status
        : "unknown",
  };
}

export async function revokeAdminSignupApproval(id: string): Promise<{ revoked: boolean }> {
  const response = await apiFetch("/api/v1/admin/signup-approvals/revoke", {
    body: JSON.stringify({ id }),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  return parseResponse(response);
}

export interface SignupApprovalAccount {
  email_verified: boolean;
  user_id: string;
  display_name: string;
  email: string;
  signup_role: AdminSignupRole;
}

export async function findAdminSignupAccount(
  email: string,
  role: AdminSignupRole,
): Promise<{ account: SignupApprovalAccount | null }> {
  const query = optionalSearch({ email: email.trim().toLowerCase(), role });
  const response = await apiFetch(`/api/v1/admin/signup-approvals/account${query}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export async function listAdminMembers(filters: {
  search: string;
  status?: AdminMemberStatus;
}): Promise<{ members: AdminMember[]; truncated?: boolean }> {
  const query = optionalSearch(filters);
  const response = await apiFetch(`/api/v1/admin/members${query}`, { credentials: "include" });
  return parseResponse(response);
}

export async function updateAdminMemberStatus(
  id: string,
  input: { reason?: string; status: Exclude<AdminMemberStatus, "pending"> },
): Promise<{ member: Pick<AdminMember, "id" | "status" | "status_changed_at"> }> {
  const response = await apiFetch(`/api/v1/admin/members/${encodeURIComponent(id)}/status`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function listAdminUsers(
  search: string,
): Promise<{ users: AdminUser[]; truncated?: boolean }> {
  const normalizedSearch = search.trim();
  if (normalizedSearch.length < 2) {
    throw new Error("사용자 검색어를 2자 이상 입력해 주세요.");
  }
  const query = optionalSearch({ search: normalizedSearch });
  const response = await apiFetch(`/api/v1/admin/users${query}`, { credentials: "include" });
  return parseResponse(response);
}

export async function updateAdminUserStatus(
  id: string,
  input: { reason: string; status: "active" | "inactive" },
): Promise<{ user: AdminUser }> {
  const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}/status`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function resetAdminUserPassword(
  id: string,
  reason: string,
): Promise<{ expires_at: string; mail: "sent" | "failed"; email_masked: string }> {
  const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}/reset-password`, {
    body: JSON.stringify({ reason }),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  return parseResponse(response);
}

/** 감사 기록 공통 조건: 기간은 한국 날짜(YYYY-MM-DD), offset은 '더 보기'로 건너뛸 건수. */
export type AdminAuditPageFilters = {
  action?: string;
  from?: string;
  offset?: string;
  to?: string;
};
export interface AdminAuditPage<T> {
  has_more: boolean;
  logs: T[];
}

export async function listAdminAuditLogs(
  filters: AdminAuditPageFilters & { resource?: string; target?: string } = {},
): Promise<AdminAuditPage<AdminAuditLog>> {
  const query = optionalSearch(filters);
  const response = await apiFetch(`/api/v1/admin/audit-logs${query}`, { credentials: "include" });
  return parseResponse(response);
}

export async function listAdminAuthAuditLogs(
  filters: AdminAuditPageFilters & { actor?: string } = {},
): Promise<AdminAuditPage<AdminAuthAuditLog>> {
  const query = optionalSearch(filters);
  const response = await apiFetch(`/api/v1/admin/auth-audit-logs${query}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export async function listAdminOperationAuditLogs(
  filters: AdminAuditPageFilters & { actor?: string; target?: string } = {},
): Promise<AdminAuditPage<AdminOperationAuditLog>> {
  const query = optionalSearch(filters);
  const response = await apiFetch(`/api/v1/admin/operation-audit-logs${query}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export async function listAdminInquiries(
  status?: AdminInquiryStatus,
): Promise<{ inquiries: AdminInquiry[] }> {
  const query = optionalSearch({ status });
  const response = await apiFetch(`/api/v1/admin/inquiries${query}`, { credentials: "include" });
  return parseResponse(response);
}

export async function updateAdminInquiry(
  id: string,
  input: {
    assigned_admin_account_id?: string | null;
    internal_note?: string;
    response?: string;
    status: AdminInquiryStatus;
  },
): Promise<{ inquiry: AdminInquiry }> {
  const response = await apiFetch(`/api/v1/admin/inquiries/${encodeURIComponent(id)}`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function listAdminTermsVersions(): Promise<{ versions: AdminTermsVersion[] }> {
  const response = await apiFetch("/api/v1/admin/terms/versions", { credentials: "include" });
  return parseResponse(response);
}

export async function createAdminTermsVersion(input: {
  content: string;
  document_type: AdminTermsDocumentType;
  policy_version: string;
  title: string;
}): Promise<{ version: AdminTermsVersion }> {
  const response = await apiFetch("/api/v1/admin/terms/versions", {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  return parseResponse(response);
}

export async function updateAdminTermsVersionStatus(
  id: string,
  input:
    | { effective_at: string; reason: string; status: "published" }
    | { reason: string; status: "retired" },
): Promise<{ version: AdminTermsVersion }> {
  const response = await apiFetch(`/api/v1/admin/terms/versions/${encodeURIComponent(id)}/status`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function listAdminTermsConsents(filters: {
  consent_type: AdminTermsConsentType;
  policy_version: string;
}): Promise<{ consents: AdminTermsConsent[] }> {
  const query = optionalSearch(filters);
  const response = await apiFetch(`/api/v1/admin/terms/consents${query}`, {
    credentials: "include",
  });
  return parseResponse(response);
}

export async function getAdminSystemState(): Promise<{ states: AdminSystemState[] }> {
  const response = await apiFetch("/api/v1/admin/system-state", { credentials: "include" });
  return parseResponse(response);
}

export async function updateAdminSystemState(
  key: AdminSystemStateKey,
  value: unknown,
): Promise<{ state: AdminSystemState }> {
  const response = await apiFetch(`/api/v1/admin/system-state/${key}`, {
    body: JSON.stringify({ value }),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function listAdminAccounts(): Promise<{ accounts: ManagedAdminAccount[] }> {
  const response = await apiFetch("/api/v1/admin/accounts", { credentials: "include" });
  return parseResponse(response);
}

export async function createAdminAccount(input: {
  display_name: string;
  email: string;
  roles: AdminRole[];
}): Promise<{
  account: { id: string; roles: AdminRole[]; status: AdminAccountStatus };
  created: boolean;
  initial_password: string | null;
}> {
  const response = await apiFetch("/api/v1/admin/accounts", {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  return parseResponse(response);
}

export async function updateAdminAccountStatus(
  id: string,
  input: { reason: string; status: Exclude<AdminAccountStatus, "pending_mfa"> },
): Promise<{ account: Pick<ManagedAdminAccount, "id" | "status" | "updated_at"> }> {
  const response = await apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(id)}/status`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PATCH",
  });
  return parseResponse(response);
}

export async function replaceAdminAccountRoles(
  id: string,
  input: { reason: string; roles: AdminRole[] },
): Promise<{ account: { id: string; roles: AdminRole[] } }> {
  const response = await apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(id)}/roles`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: mutationHeaders(),
    method: "PUT",
  });
  return parseResponse(response);
}

export async function resetAdminAccountCredentials(
  id: string,
  reason: string,
): Promise<{
  account_id: string;
  initial_password: string;
  status: "pending_mfa";
}> {
  const response = await apiFetch(
    `/api/v1/admin/accounts/${encodeURIComponent(id)}/reset-credentials`,
    {
      body: JSON.stringify({ reason }),
      credentials: "include",
      headers: mutationHeaders(),
      method: "POST",
    },
  );
  return parseResponse(response);
}

export async function resetAdminAccountMfa(
  id: string,
  reason: string,
): Promise<{ account_id: string; status: "pending_mfa" }> {
  const response = await apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(id)}/reset-mfa`, {
    body: JSON.stringify({ reason }),
    credentials: "include",
    headers: mutationHeaders(),
    method: "POST",
  });
  return parseResponse(response);
}
