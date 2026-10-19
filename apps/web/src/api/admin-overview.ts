import { adminFetch as apiFetch } from "./admin-request";
import { parseAdminResponse as parseResponse } from "./admin-auth";

/** 관리자 첫 화면 "한눈에 보기" — 숫자만 온다(이름·메일·내용 없음). */
export interface AdminOverview {
  generated_at: string;
  scale: {
    active_classes: number;
    active_users: number;
    schools: number;
    students: number;
    teachers: number;
  };
  server: {
    /** 구버전 응답은 범위 정보가 없어 현재 서비스로 표시한다. */
    api_surface?: "admin" | "user" | "all";
    database_ms: number | null;
    errors_last_hour: number;
    maintenance_mode: boolean | null;
    memory_mb: number;
    redis_ok: boolean;
    started_at: string;
  };
  signups: { new_last_7_days: number; pending_students: number; pending_teachers: number };
  support: {
    class_chat_reports_open: number | null;
    inquiries_in_progress: number;
    inquiries_open: number;
  };
}

export async function getAdminOverview(): Promise<AdminOverview> {
  const response = await apiFetch("/api/v1/admin/overview", { credentials: "include" });
  return parseResponse(response);
}

/** 오류·메모리·가동 시간은 응답한 한 서비스 프로세스의 지표다. */
export function adminOverviewServiceLabel(server: AdminOverview["server"]): string {
  switch (server.api_surface) {
    case "admin":
      return "관리자 서비스";
    case "user":
      return "학생·교사 서비스";
    case "all":
      return "통합 서비스";
    default:
      return "현재 서비스";
  }
}
