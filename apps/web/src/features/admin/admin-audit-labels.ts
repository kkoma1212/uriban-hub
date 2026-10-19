/*
 * 감사·보안 기록의 작업 코드를 한국어로 보여 준다(총검수 C3-12: member.approved 같은 영문 내부
 * 코드가 검색칸과 기록에 그대로 보였다). 코드는 검색 값·근거로 쓰이므로 괄호로 함께 남긴다.
 * 모르는 새 코드는 코드 그대로 보인다.
 */
export type AuditView = "auth" | "operations" | "security";

export const AUDIT_ACTION_LABELS: Record<AuditView, Readonly<Record<string, string>>> = {
  security: {
    "auth.login_failed": "로그인 실패",
    "auth.csrf_failed": "요청 위조 차단",
    "auth.logout": "로그아웃",
    "auth.password_reset_requested": "비밀번호 재설정 요청",
    "authz.denied": "권한 없음 차단",
    rate_limited: "요청 횟수 제한",
    "security_audit.producer_failed": "보안 기록 전달 실패",
    "security_audit.publish_failed": "보안 기록 저장 실패",
  },
  auth: {
    "admin.auth.login_failed": "관리자 로그인 실패",
    "admin.auth.login_succeeded": "관리자 로그인",
    "admin.auth.logout": "관리자 로그아웃",
    "admin.auth.mfa_enrolled": "2단계 인증 등록",
    "admin.auth.password_verified": "비밀번호 확인",
    "admin.auth.session_expired": "로그인 시간 만료",
    "admin.auth.step_up_failed": "중요 작업 보안 확인 실패",
    "admin.auth.step_up_succeeded": "중요 작업 보안 확인",
  },
  operations: {
    "admin.account.created": "관리자 계정 생성",
    "admin.account.credentials_reset": "관리자 인증 정보 초기화",
    "admin.account.mfa_reset": "관리자 2단계 인증 초기화",
    "admin.account.password_changed": "관리자 비밀번호 변경",
    "admin.account.roles_changed": "관리자 역할 변경",
    "admin.account.status_changed": "관리자 계정 상태 변경",
    "admin.inquiry.updated": "문의 처리",
    "admin.member.status_changed": "반 구성원 상태 변경",
    "admin.session.revoked": "로그인 세션 강제 종료",
    "admin.signup_approval.issued": "가입 승인번호 발급",
    "admin.signup_approval.reissued": "가입 승인번호 재발급",
    "admin.signup_approval.revoked": "가입 승인번호 폐기",
    "admin.system_state.updated": "운영 설정 변경",
    "admin.terms.created": "약관 초안 등록",
    "admin.terms.published": "약관 게시",
    "admin.terms.retired": "약관 폐기",
    "admin.user.password_reset_issued": "비밀번호 재설정 링크 발송",
    "admin.user.status_changed": "사용자 계정 상태 변경",
  },
};

/** '구성원 승인 (member.approved)'처럼 한국어 이름과 코드를 함께. */
export function auditActionLabel(view: AuditView, code: string): string {
  const label = AUDIT_ACTION_LABELS[view][code];
  return label === undefined ? code : `${label} (${code})`;
}
