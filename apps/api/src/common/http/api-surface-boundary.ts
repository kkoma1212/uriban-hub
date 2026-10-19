import { posix } from "node:path";

/*
 * 관리자 프로그램(API_SURFACE=admin)이 받는 API 주소(T-ADMIN-SPLIT 3단계, 2026-10-07).
 * 관리자 기능은 학생·교사 로그인 기반(AuthModule)을 함께 싣기 때문에 그 주소들도 등록된다.
 * 관리자 주소로 학생·교사 API가 열리지 않도록 요청 단계에서 이 목록 밖은 404로 돌린다.
 * 약관 읽기는 관리자 화면 아래 약관 링크, 화면 오류 기록은 관리자 화면 오류 수집이 쓴다.
 */
const ADMIN_SURFACE_API_PREFIXES = ["/api/v1/admin/", "/api/v1/legal/documents/"];
const ADMIN_SURFACE_API_PATHS = ["/api/v1/client-errors"];

/** 관리자 프로그램이 거절해야 하는 API 요청이면 true. 화면 파일·상태 확인 주소는 대상이 아니다. */
export function isOutsideAdminSurfaceApi(requestUrl: string): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.split("?", 1)[0] ?? "");
  } catch {
    // 잘못된 주소는 거절 쪽으로 둔다.
    return true;
  }
  const normalized = posix.normalize(pathname.replace(/\\/gu, "/")).toLowerCase();
  if (normalized !== "/api" && !normalized.startsWith("/api/")) return false;
  return !(
    ADMIN_SURFACE_API_PATHS.includes(normalized) ||
    ADMIN_SURFACE_API_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}
