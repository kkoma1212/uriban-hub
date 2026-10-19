import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
// 빌드된 DB 패키지(packages/db build)의 앱 권한 묶음 — API가 연결 때 요구하는 값.
import {
  requiredMariaDbRuntimeGrants,
  selectAppRuntimeGrantProfile,
} from "../../../packages/db/dist/mariadb/runtime-grant-extensions.js";
import { POLL_EDIT_APP_GRANTS } from "./poll-edit-followup.mjs";

// 2026-10-04 이 PC 운영 DB에 설치된 확장(원장 106까지).
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
  adminRecordsRetention: true,
};
const apiInstalled = {
  classChat: true,
  profilePhotos: true,
  birthDates: true,
  adminAccessLogs: true,
  auth: "all",
};

// 설치 기준표와 API 권한 묶음이 한 글자도 다르지 않아야 한다. 다르면 원장 107·108 적용 뒤
// (또는 적용 전에 설정을 먼저 켜면) API가 권한 검사에서 시작을 거부한다.
test("ledger 107-108 app grants equal the *_polledit_v1 profile on top of ledger 106", () => {
  const before = nativeInstalledCatalog(installed);
  const after = nativeInstalledCatalog({ ...installed, pollEdit: true });
  const beforeProfile = selectAppRuntimeGrantProfile(apiInstalled);
  const afterProfile = selectAppRuntimeGrantProfile({ ...apiInstalled, pollEdit: true });
  assert.equal(afterProfile, beforeProfile.replace(/_v1$/u, "_polledit_v1"));
  assert.deepEqual([...before.final.grants.classhub_app].sort(), [
    ...requiredMariaDbRuntimeGrants("app", beforeProfile),
  ]);
  assert.deepEqual([...after.final.grants.classhub_app].sort(), [
    ...requiredMariaDbRuntimeGrants("app", afterProfile),
  ]);
  assert.deepEqual(after.final.grants.classhub_retention, before.final.grants.classhub_retention);
  assert.deepEqual(
    after.final.seeds.audit_log_actions.filter(
      (action) => !before.final.seeds.audit_log_actions.includes(action),
    ),
    ["poll.updated"],
  );
  assert.deepEqual(
    after.plan.steps.slice(-2).map((step) => step.ledger_version),
    [107, 108],
  );
  assert.equal(after.plan.ledger.planned_record_count, before.plan.ledger.planned_record_count + 2);
});

test("ledger 108 lets the app update only four poll columns and nothing on options or votes", () => {
  const before = nativeInstalledCatalog(installed);
  const after = nativeInstalledCatalog({ ...installed, pollEdit: true });
  const added = after.final.grants.classhub_app.filter(
    (grant) => !before.final.grants.classhub_app.includes(grant),
  );
  assert.deepEqual([...added].sort(), [...POLL_EDIT_APP_GRANTS]);
  // 공개 설정(ballot_visibility·results_policy)·만든 사람·반은 여전히 고칠 수 없다.
  for (const column of ["ballot_visibility", "results_policy", "class_id", "created_by_member_id"])
    assert(!after.final.grants.classhub_app.includes(`table|polls|UPDATE|${column}`), column);
  assert(
    !after.final.grants.classhub_app.some((grant) => grant.startsWith("table|poll_votes|UPDATE")),
  );
});

test("every poll-edit profile is its base profile plus exactly the four poll columns", () => {
  for (const auth of ["none", "passkeys", "social", "all"])
    for (const flags of [
      {},
      { classChat: true },
      { profilePhotos: true, birthDates: true },
      { adminAccessLogs: true },
    ]) {
      const base = selectAppRuntimeGrantProfile({ classChat: false, auth, ...flags });
      const edited = selectAppRuntimeGrantProfile({
        classChat: false,
        auth,
        ...flags,
        pollEdit: true,
      });
      const baseGrants = requiredMariaDbRuntimeGrants("app", base);
      assert.deepEqual(
        requiredMariaDbRuntimeGrants("app", edited),
        [...baseGrants, ...POLL_EDIT_APP_GRANTS].sort(),
        edited,
      );
    }
});

// 개발 묶음 DB(원장 103까지)처럼 보관 기간 104~106 없이도 투표 수정만 따로 깔 수 있다.
test("ledger 107-108 install on top of poll close without the retention ledgers", () => {
  const { mailLogRetention, auditConsentRetention, adminRecordsRetention, ...sandbox } = installed;
  assert(mailLogRetention && auditConsentRetention && adminRecordsRetention);
  const catalog = nativeInstalledCatalog({ ...sandbox, pollEdit: true });
  const versions = catalog.plan.steps.map((step) => step.ledger_version);
  assert.deepEqual(versions.slice(-3), [103, 107, 108]);
  assert(!versions.some((version) => [104, 105, 106].includes(version)));
});
