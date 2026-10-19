import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
// 빌드된 DB 패키지(packages/db build)의 정리 계정 권한 묶음 — 정리 작업이 연결 때 요구하는 값.
import { requiredMariaDbRuntimeGrants } from "../../../packages/db/dist/mariadb/runtime-grant-extensions.js";

// 2026-10-03 이 PC 운영 DB에 설치된 확장(원장 103까지).
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
};

// 설치 기준표와 정리 작업 권한 묶음이 한 글자도 다르지 않아야 한다. 다르면 원장 104 적용 뒤
// 매일 정리 작업이 권한 검사에서 멈춘다.
test("ledger 104 grants equal retention_mail_logs_v1; without it they equal retention_v1", () => {
  const before = nativeInstalledCatalog(installed);
  const after = nativeInstalledCatalog({ ...installed, mailLogRetention: true });
  assert.deepEqual([...before.final.grants.classhub_retention].sort(), [
    ...requiredMariaDbRuntimeGrants("retention", "retention_v1"),
  ]);
  assert.deepEqual([...after.final.grants.classhub_retention].sort(), [
    ...requiredMariaDbRuntimeGrants("retention", "retention_mail_logs_v1"),
  ]);
  assert.deepEqual(after.final.grants.classhub_app, before.final.grants.classhub_app);
  assert.equal(after.plan.steps.at(-1).ledger_version, 104);
  assert.equal(after.plan.ledger.planned_record_count, before.plan.ledger.planned_record_count + 1);
});
