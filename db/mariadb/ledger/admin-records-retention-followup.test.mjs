import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
// 빌드된 DB 패키지(packages/db build)의 정리 계정 권한 묶음 — 정리 작업이 연결 때 요구하는 값.
import { requiredMariaDbRuntimeGrants } from "../../../packages/db/dist/mariadb/runtime-grant-extensions.js";

// 2026-10-04 이 PC 운영 DB에 설치된 확장(원장 105까지).
const installed = {
  operatorCommands: true,
  archiveReason: true,
  pollClose: true,
  pushSubscriptions: true,
  pushDeliveries: true,
  scheduleLinks: true,
  helpRequests: true,
  helpChat: true,
  adminPasskeys: true,
  classChat: true,
  profilePhotos: true,
  sessionRevoke: true,
  birthDates: true,
  socialLogin: true,
  adminAccessLogs: true,
  legalSnapshots: true,
  mailLogRetention: true,
  auditConsentRetention: true,
};

// 설치 기준표와 정리 작업 권한 묶음이 한 글자도 다르지 않아야 한다. 다르면 원장 106 적용 뒤
// 매일 정리 작업이 권한 검사에서 멈춘다.
test("ledger 106 grants equal retention_admin_records_v1 on top of ledger 105", () => {
  const before = nativeInstalledCatalog(installed);
  const after = nativeInstalledCatalog({ ...installed, adminRecordsRetention: true });
  assert.deepEqual([...before.final.grants.classhub_retention].sort(), [
    ...requiredMariaDbRuntimeGrants("retention", "retention_audit_consents_v1"),
  ]);
  assert.deepEqual([...after.final.grants.classhub_retention].sort(), [
    ...requiredMariaDbRuntimeGrants("retention", "retention_admin_records_v1"),
  ]);
  assert.deepEqual(after.final.grants.classhub_app, before.final.grants.classhub_app);
  assert.equal(after.plan.steps.at(-1).ledger_version, 106);
  assert.equal(after.plan.ledger.planned_record_count, before.plan.ledger.planned_record_count + 1);
  // 106만 켜도 104·105가 함께 깔린다(쌓인 권한).
  const alone = nativeInstalledCatalog({
    ...installed,
    mailLogRetention: false,
    auditConsentRetention: false,
    adminRecordsRetention: true,
  });
  assert.deepEqual(alone.final.grants.classhub_retention, after.final.grants.classhub_retention);
});

test("ledger 106 lets the retention account update only the two approval contact columns", () => {
  const before = nativeInstalledCatalog(installed);
  const after = nativeInstalledCatalog({ ...installed, adminRecordsRetention: true });
  // 원래 있던 수정 권한(임시 비밀번호 안내 시각)은 그대로 두고, 106이 새로 더한 것만 본다.
  const updates = after.final.grants.classhub_retention.filter(
    (grant) =>
      grant.includes("|UPDATE|") && !before.final.grants.classhub_retention.includes(grant),
  );
  assert.deepEqual(updates, [
    "table|admin_signup_approvals|UPDATE|code_encrypted",
    "table|admin_signup_approvals|UPDATE|recipient_email",
  ]);
});
