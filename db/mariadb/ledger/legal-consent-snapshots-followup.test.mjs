import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";

// 2026-10-03 이 PC 설치 상태(접속기록 101·102까지) 위에 원장 103을 올린다.
const pc = {
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
};

test("legal snapshot ledger 103 only adds the two snapshot columns and widens policy_version", () => {
  const before = nativeInstalledCatalog(pc);
  const after = nativeInstalledCatalog({ ...pc, legalSnapshots: true });
  const changed = Object.keys(after.final.tables).filter(
    (table) =>
      JSON.stringify(after.final.tables[table]) !== JSON.stringify(before.final.tables[table]),
  );
  assert.deepEqual(changed.sort(), ["guardian_consent_requests", "user_consents"]);
  assert.equal(Object.keys(after.final.tables).length, Object.keys(before.final.tables).length);
  for (const table of changed) assert(after.final.tables[table].columns.document_snapshot);
  assert.deepEqual(after.final.grants, before.final.grants);
  assert.deepEqual(after.final.triggers, before.final.triggers);
  assert.deepEqual(after.final.routines, before.final.routines);
  assert.equal(after.plan.ledger.planned_record_count, before.plan.ledger.planned_record_count + 1);
  assert.deepEqual(
    after.plan.steps.filter((step) => step.ledger_version === 103).map((step) => step.id),
    ["legal-consent-snapshots"],
  );
});
