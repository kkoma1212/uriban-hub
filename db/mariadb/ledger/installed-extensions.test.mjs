import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInstalledCatalog } from "../../../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
// 빌드된 DB 패키지(packages/db build)의 권한 프로필 — API가 기동 때 요구하는 것과 같은 값.
import {
  requiredMariaDbRuntimeGrants,
  selectAppRuntimeGrantProfile,
} from "../../../packages/db/dist/mariadb/runtime-grant-extensions.js";

// 설치·백업 복원 기준표(원장 SQL에서 계산)와 API 권한 프로필이 한 글자도 다르지 않아야 한다.
// 다르면 운영 DB에 확장을 적용한 뒤 API가 권한 검사에서 멈추거나 복원 검증이 실패한다.
const installedBase = {
  accountExperience: true,
  mailManagement: true,
  auditHistory: true,
  operatorCommands: true,
  archiveReason: true,
  helpChat: true,
};

for (const adminAccessLogs of [false, true]) {
  for (const birthDates of [false, true]) {
    for (const profilePhotos of [false, true]) {
      for (const classChat of [false, true]) {
        for (const auth of ["none", "passkeys", "social", "all"]) {
          test(`catalog grants equal the runtime profile: accessLogs=${adminAccessLogs} birthDates=${birthDates} photos=${profilePhotos} classChat=${classChat} auth=${auth}`, () => {
            const passkeys = auth === "passkeys" || auth === "all";
            const social = auth === "social" || auth === "all";
            const catalog = nativeInstalledCatalog({
              ...installedBase,
              classChat,
              profilePhotos,
              birthDates,
              adminAccessLogs,
              adminPasskeys: passkeys,
              socialLogin: social,
            });
            const profile = selectAppRuntimeGrantProfile({
              classChat,
              auth,
              profilePhotos,
              birthDates,
              adminAccessLogs,
            });
            assert.deepEqual([...catalog.final.grants.classhub_app].sort(), [
              ...requiredMariaDbRuntimeGrants("app", profile),
            ]);
            assert.deepEqual(
              catalog.plan.steps
                .map((step) => step.ledger_version)
                .filter((version) => version !== null && version >= 84),
              [
                84,
                85,
                ...(passkeys ? [90, 91] : []),
                ...(social ? [92, 93] : []),
                ...(classChat ? [94, 95] : []),
                ...(profilePhotos ? [96, 97] : []),
                ...(birthDates ? [99, 100] : []),
                ...(adminAccessLogs ? [101, 102] : []),
              ],
            );
          });
        }
      }
    }
  }
}

test("authentication and class chat foreign keys are recorded as named constraints", () => {
  const catalog = nativeInstalledCatalog({
    ...installedBase,
    classChat: true,
    adminPasskeys: true,
    socialLogin: true,
  });
  const foreignKeys = (table) => Object.keys(catalog.final.tables[table].foreign_keys ?? {});
  assert.deepEqual(foreignKeys("admin_passkeys"), ["admin_passkeys_account_fk"]);
  assert.deepEqual(foreignKeys("admin_recovery_codes"), ["admin_recovery_codes_account_fk"]);
  assert.deepEqual(foreignKeys("admin_webauthn_challenges"), [
    "admin_webauthn_challenges_account_fk",
  ]);
  assert.deepEqual(foreignKeys("admin_mfa_stepups"), ["admin_mfa_stepups_session_fk"]);
  assert.deepEqual(foreignKeys("social_identities"), ["social_identities_user_fk"]);
  assert(foreignKeys("class_chat_messages").length > 0);
});

test("the default catalog (live restore features) is unchanged by the prepared extensions", () => {
  const plain = nativeInstalledCatalog(installedBase);
  assert(!plain.plan.steps.some((step) => step.ledger_version >= 90));
  for (const table of ["admin_passkeys", "social_identities", "class_chat_messages"])
    assert.equal(plain.final.tables[table], undefined);
});
