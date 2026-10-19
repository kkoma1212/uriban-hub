import { apiFetch, parseResponse } from "./auth";

// 학급 감사는 365일 보관하므로 조회 상한도 거기까지다(T-HUB-13).
// 서버의 AUDIT_LOG_DAY_OPTIONS와 같은 목록이다 — 화면과 URL 파싱이 이 하나를 본다.
export const AUDIT_LOG_DAY_OPTIONS = [7, 30, 90, 180, 365] as const;
export const DEFAULT_AUDIT_LOG_DAYS = 90;

export type AuditLogDays = (typeof AUDIT_LOG_DAY_OPTIONS)[number];

export function parseAuditLogDays(value: string | null): AuditLogDays {
  const parsed = Number(value);
  return AUDIT_LOG_DAY_OPTIONS.find((option) => option === parsed) ?? DEFAULT_AUDIT_LOG_DAYS;
}
export type AuditSafeValue = boolean | number | string | null;
export type AuditSafeSnapshot = Record<string, AuditSafeValue>;

export interface AuditLogItem {
  action: string;
  actor: {
    display_name: string;
    role: "operator" | "student" | "teacher";
  };
  after: AuditSafeSnapshot | null;
  before: AuditSafeSnapshot | null;
  created_at: string;
  reason: string | null;
  target: {
    id: string;
    snapshot: AuditSafeSnapshot | null;
    type: string;
  };
}

export interface AuditLogListResponse {
  items: AuditLogItem[];
  next_cursor: string | null;
}

export interface AuditLogListOptions {
  action: string | null;
  cursor?: string;
  days: AuditLogDays;
}

export async function getAuditLogs(options: AuditLogListOptions): Promise<AuditLogListResponse> {
  const search = new URLSearchParams({ days: String(options.days) });
  if (options.action !== null) search.set("action", options.action);
  if (options.cursor !== undefined) search.set("cursor", options.cursor);
  const response = await apiFetch(`/api/v1/audit-logs?${search.toString()}`, {
    credentials: "include",
  });
  return parseResponse<AuditLogListResponse>(response);
}
