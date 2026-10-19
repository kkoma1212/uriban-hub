import { adminFetch as apiFetch } from "./admin-request";
import { parseAdminResponse as parseResponse, readAdminCsrfCookie } from "./admin-auth";

/** 운영 상태 — 숫자·시각·통과 여부만 온다. 확인할 수 없으면 null. */
export interface AdminOperationsStatus {
  audit_queue: {
    conditions: string[];
    latest_quarantined_at: string | null;
    pending_entries: number | null;
    quarantine_reviewed_through: string | null;
    quarantine_entries: number | null;
    sampled_at: string | null;
    status: "attention" | "degraded" | "ok" | "unknown";
  } | null;
  backup: { at: string; verified: boolean } | null;
  generated_at: string;
  restore_check: {
    at: string;
    expected_ledger_rows: number;
    expected_tables: number;
    ledger_rows: number;
    passed: boolean;
    tables: number;
  } | null;
  status_source_configured: boolean;
  /** PC 밖(USB) 반출: 마지막 반출 시각과 그때 담은 백업 시각. 반출한 적 없으면 null */
  offline_backup: { at: string; backup_at: string } | null;
}

export async function getAdminOperationsStatus(): Promise<AdminOperationsStatus> {
  const response = await apiFetch("/api/v1/admin/operations-status", { credentials: "include" });
  return parseResponse(response);
}

/** 최근 24시간 화면 오류 — 화면 모양·오류 이름·역할·기기·건수만 온다(Redis 한 시간 묶음, 25시간 뒤 지워짐). */
export interface AdminClientErrorSummary {
  kinds: Array<{
    count: number;
    device: "desktop" | "phone";
    first_seen_at: string;
    last_seen_at: string;
    name: string;
    role: "student" | "teacher" | "unknown";
    route: string;
    source: "chunk" | "promise" | "render" | "script";
  }>;
  total: number;
  window_hours: number;
}

export async function getAdminClientErrors(): Promise<AdminClientErrorSummary> {
  const response = await apiFetch("/api/v1/admin/client-errors", { credentials: "include" });
  return parseResponse(response);
}

/** 로그인 중인 세션 — 접속 주소·토큰 없이 이름·가린 메일·기기 요약·시각만 온다. */
export interface AdminSessionList {
  admin_sessions: Array<{
    absolute_expires_at: string;
    device: string;
    display_name: string;
    id: string;
    is_current: boolean;
    issued_at: string;
    last_seen_at: string;
  }>;
  page: number;
  page_size: number;
  user_sessions: Array<{
    device: string;
    display_name: string;
    email_masked: string;
    expires_at: string;
    id: string;
    issued_at: string;
  }>;
  user_total: number;
  /** 운영 DB에 종료 기록값이 설치돼 강제 종료를 쓸 수 있는지 */
  revoke_enabled: boolean;
}

export type AdminSessionKind = "admin" | "user";

/** 세션 하나를 끝낸다(최고 관리자·보안 확인 필요). 사유는 관리자 작업 기록에 남는다. */
export async function revokeAdminSession(
  id: string,
  input: { kind: AdminSessionKind; reason: string },
): Promise<{ id: string; kind: AdminSessionKind; revoked: true }> {
  const response = await apiFetch(`/api/v1/admin/sessions/${encodeURIComponent(id)}/revoke`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Admin-CSRF": readAdminCsrfCookie() },
    method: "POST",
  });
  return parseResponse(response);
}

export async function listAdminSessions(page: number): Promise<AdminSessionList> {
  const response = await apiFetch(`/api/v1/admin/sessions?page=${page}`, {
    credentials: "include",
  });
  return parseResponse(response);
}
