import { type BootstrapOperatorResult } from "./operator-bootstrap.js";
import {
  type ProvisionTeacherResult,
  type ResetTeacherPasswordResult,
} from "./teacher-provision.js";
import type { ProvisionAdminResult } from "./admin-provision.js";

export const INTERACTIVE_SECRET_OUTPUT_REQUIRED =
  "비밀을 생성하거나 변경하는 명령은 stdout이 연결된 대화형 터미널에서만 실행할 수 있습니다. 파이프 또는 리다이렉트 환경에서는 데이터베이스를 변경하지 않습니다.";

export function renderBootstrapSecretOutput(result: BootstrapOperatorResult): string {
  return [
    "최초 운영자 생성 완료",
    `OPERATOR_ID=${result.operatorId}`,
    `OPERATOR_EMAIL=${result.email}`,
    `OPERATOR_TOKEN=${result.rawToken}`,
    "이 token은 다시 표시되지 않습니다.",
    "",
  ].join("\n");
}

export function renderTeacherProvisionOutput(result: ProvisionTeacherResult): string {
  if (!result.created) {
    return [
      "이미 개통된 active 교사 계정입니다.",
      `TEACHER_USER_ID=${result.userId}`,
      `TEACHER_EMAIL=${result.email}`,
      "멱등 no-op이며 임시 비밀번호를 재발급하지 않았습니다.",
      "",
    ].join("\n");
  }
  return [
    "교사 계정 생성 완료",
    `RUN_ID=${result.runId}`,
    `TEACHER_USER_ID=${result.userId}`,
    `TEACHER_EMAIL=${result.email}`,
    `TEMPORARY_PASSWORD=${result.rawTemporaryPassword}`,
    `TEMPORARY_PASSWORD_EXPIRES_AT=${result.temporaryPasswordExpiresAt.toISOString()}`,
    "임시 비밀번호는 다시 표시되지 않습니다. 확인된 시스템 밖 채널로 전달하세요.",
    "",
  ].join("\n");
}

export function renderTeacherPasswordResetOutput(result: ResetTeacherPasswordResult): string {
  return [
    "교사 임시 비밀번호 재발급 완료",
    `RUN_ID=${result.runId}`,
    `TEACHER_USER_ID=${result.userId}`,
    `TEACHER_EMAIL=${result.email}`,
    `TEMPORARY_PASSWORD=${result.rawTemporaryPassword}`,
    `TEMPORARY_PASSWORD_EXPIRES_AT=${result.temporaryPasswordExpiresAt.toISOString()}`,
    `REVOKED_SESSIONS=${result.revokedSessionCount}`,
    "기존 세션을 모두 끊었습니다. 교사는 다음 로그인에서 비밀번호를 바꿔야 합니다.",
    "임시 비밀번호는 다시 표시되지 않습니다. 확인된 시스템 밖 채널로 전달하세요.",
    "",
  ].join("\n");
}

export function renderAdminProvisionOutput(result: ProvisionAdminResult): string {
  if (!result.created) {
    return [
      "이미 개통된 관리자 계정입니다.",
      `ADMIN_ACCOUNT_ID=${result.adminAccountId}`,
      `ADMIN_EMAIL=${result.email}`,
      `ADMIN_ROLE=${result.role}`,
      `ADMIN_STATUS=${result.status}`,
      "멱등 no-op이며 초기 비밀번호를 재발급하지 않았습니다.",
      "",
    ].join("\n");
  }

  return [
    "관리자 계정 생성 완료",
    `RUN_ID=${result.runId}`,
    `ADMIN_ACCOUNT_ID=${result.adminAccountId}`,
    `ADMIN_EMAIL=${result.email}`,
    `ADMIN_ROLE=${result.role}`,
    `ADMIN_STATUS=${result.status}`,
    `INITIAL_PASSWORD=${result.rawInitialPassword}`,
    "관리자는 첫 로그인에서 TOTP를 등록해야 합니다.",
    "초기 비밀번호는 다시 표시되지 않습니다. 확인된 시스템 밖 채널로 전달하세요.",
    "",
  ].join("\n");
}

export async function runInteractiveSecretCommand<Result>(
  mutate: () => Promise<Result>,
  renderOutput: (result: Result) => string,
): Promise<void> {
  if (process.stdout.isTTY !== true) {
    throw new Error(INTERACTIVE_SECRET_OUTPUT_REQUIRED);
  }

  const result = await mutate();
  process.stdout.write(renderOutput(result));
}
