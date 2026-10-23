import type { HttpException } from "@nestjs/common";

/*
 * 관리자 화면 오류 문구(2026-10-03 총검수 C3-01). 코드만 던지면 공통 오류 변환기가 400은
 * '요청 형식을 확인해 주세요'로 뭉개고 404·409는 영문 코드를 그대로 보내, 관리자가 무엇을
 * 고칠지 알 수 없었다. 응답 본문은 {code, 한국어 message}로 보내고, 예외의 message는 코드로
 * 남겨 로그·시험은 지금처럼 코드로 본다.
 */
export const ADMIN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ADMIN_ACCOUNT_NOT_FOUND: "관리자 계정을 찾지 못했어요.",
  ADMIN_ACCOUNT_REVOKED: "이미 폐기된 관리자 계정이에요.",
  ADMIN_ACCOUNT_ROLE_CONFLICT: "역할이 다른 변경과 겹쳤어요. 새로고침한 뒤 다시 시도해 주세요.",
  ADMIN_ACCOUNT_STATUS_CONFLICT:
    "계정 상태가 다른 변경과 겹쳤어요. 새로고침한 뒤 다시 시도해 주세요.",
  ADMIN_ACCOUNT_STATUS_TRANSITION_INVALID:
    "지금 계정 상태에서는 그렇게 바꿀 수 없어요. 새로고침한 뒤 다시 확인해 주세요.",
  ADMIN_ACTIVE_TEACHER_TRANSFER_REQUIRED: "운영 중인 반의 담임이라 먼저 담임을 넘겨야 해요.",
  ADMIN_AUDIT_PERIOD_INVALID: "기간 날짜를 확인해 주세요.",
  ADMIN_CANNOT_DISABLE_SELF: "자기 계정은 정지하거나 폐기할 수 없어요.",
  ADMIN_CLIENT_ERRORS_UNAVAILABLE:
    "화면 오류 기록을 지금 읽을 수 없어요. 잠시 뒤 다시 시도해 주세요.",
  ADMIN_MEMBER_ACCOUNT_INACTIVE: "사용이 정지된 계정이라 구성원 상태를 바꿀 수 없어요.",
  ADMIN_MEMBER_CLASS_NOT_ACTIVE: "운영 중인 반이 아니라 구성원 상태를 바꿀 수 없어요.",
  ADMIN_MEMBER_FILTER_REQUIRED: "찾을 조건을 하나 이상 넣어 주세요.",
  ADMIN_MEMBER_REASON_REQUIRED: "사유를 적어 주세요.",
  ADMIN_REPORT_PERIOD_INVALID:
    "기간은 실제 날짜로, 시작일이 끝날보다 늦지 않게, 120일 이내로 골라 주세요.",
  ADMIN_MEMBER_STATUS_TRANSITION_INVALID:
    "지금 구성원 상태에서는 그렇게 바꿀 수 없어요. 새로고침한 뒤 다시 확인해 주세요.",
  ADMIN_SESSION_NOT_FOUND: "이미 끝났거나 없는 세션이에요.",
  ADMIN_SESSION_REVOKE_NOT_INSTALLED: "세션 강제 종료 기능이 아직 이 서버 DB에 설치되지 않았어요.",
  ADMIN_SYSTEM_STATE_INVALID: "운영 설정 값이 올바르지 않아요.",
  ADMIN_TERMS_CONSENT_FILTER_REQUIRED: "동의 기록을 찾을 조건을 넣어 주세요.",
  ADMIN_USER_ACCOUNT_INACTIVE: "이미 사용이 정지된 계정이에요.",
  ADMIN_USER_SEARCH_REQUIRED: "찾을 이메일이나 이름을 넣어 주세요.",
  INQUIRY_NOT_FOUND: "문의를 찾지 못했어요.",
  LAST_SUPER_ADMIN_REQUIRED: "마지막 최고 관리자는 정지·폐기하거나 권한을 뺄 수 없어요.",
  MEMBER_NOT_FOUND: "반 구성원을 찾지 못했어요.",
  TERMS_VERSION_EFFECTIVE_AT_FUTURE: "시행일은 오늘보다 뒤로 정할 수 없어요.",
  TERMS_VERSION_EFFECTIVE_AT_INVALID: "시행일을 확인해 주세요.",
  TERMS_VERSION_EXISTS: "같은 종류·같은 버전의 문서가 이미 있어요. 버전 이름을 바꿔 주세요.",
  TERMS_VERSION_HAS_UNRESOLVED_PLACEHOLDER:
    "문서에 채우지 않은 빈칸([게시 전 확정] 등)이나 '개발 정본' 표시가 남아 있어 게시할 수 없어요.",
  TERMS_VERSION_NOT_FOUND: "문서 버전을 찾지 못했어요.",
  TERMS_VERSION_REPLACEMENT_REQUIRED:
    "이 문서를 폐기하면 신규 가입이 막혀요. 새 버전을 게시하면 지금 게시본은 자동으로 폐기돼요.",
  TERMS_VERSION_TRANSITION_INVALID: "초안만 게시하고, 게시본만 폐기할 수 있어요.",
  USER_NOT_FOUND: "사용자를 찾지 못했어요.",
});

export function adminError(
  Exception: new (response: { code: string; message: string }) => HttpException,
  code: string,
): HttpException {
  const error = new Exception({
    code,
    message:
      ADMIN_ERROR_MESSAGES[code] ?? "요청을 처리하지 못했어요. 새로고침한 뒤 다시 시도해 주세요.",
  });
  error.message = code;
  return error;
}
