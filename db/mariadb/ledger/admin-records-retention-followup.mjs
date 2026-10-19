import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 관리자 기록 보관 기간(2026-10-04 사용자 결정, 처리방침 4장). 원장 106: 원장 105 위에 정리 계정의
// 가입 승인(두 연락처 칸 UPDATE 포함)·승인 처리 기록·패스키·복구 코드·문의 권한만 더한다.
// 운영 적용은 백업 뒤 사용자 승인.
export const adminRecordsRetentionArtifacts = Object.freeze([
  {
    id: "admin-records-retention-acl",
    ledger_version: 106,
    source_path: "db/mariadb/permissions/0063_admin_records_retention_acl.sql",
    byte_length: 1177,
    sha256: "eb17875851961b36c2e42a4f4928a30bfaca8cccabebd5c5b0077d35b0154dfe",
  },
]);
const TABLES = [
  "admin_signup_approvals",
  "admin_signup_approval_events",
  "admin_passkeys",
  "admin_recovery_codes",
  "admin_inquiries",
];
const EXPECTED_GRANTS = [
  ...TABLES.flatMap((table) => [`table|${table}|DELETE|*`, `table|${table}|SELECT|*`]),
  "table|admin_signup_approvals|UPDATE|code_encrypted",
  "table|admin_signup_approvals|UPDATE|recipient_email",
].sort();

export function readAdminRecordsRetentionSql(artifact) {
  assert(
    adminRecordsRetentionArtifacts.includes(artifact),
    "Unrecognized admin records retention artifact",
  );
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withAdminRecordsRetentionPostconditions(base) {
  for (const table of TABLES) assert(base.final.tables[table], `${table} must exist first`);
  assert(
    base.plan.steps.some((step) => step.ledger_version === 105),
    "Ledger 105 must come first",
  );
  assert(!base.plan.steps.some((step) => step.ledger_version === 106));
  const final = structuredClone(base.final);
  for (const artifact of adminRecordsRetentionArtifacts)
    applySourcePostcondition(final, readAdminRecordsRetentionSql(artifact), artifact.id);
  // 정리 계정의 다섯 표 권한(연락처 두 칸 UPDATE 포함) 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const addedGrants = final.grants.classhub_retention.filter(
    (grant) => !base.final.grants.classhub_retention.includes(grant),
  );
  assert.deepEqual(
    [...addedGrants].sort(),
    EXPECTED_GRANTS,
    "The retention account may only count, clear the two contact columns and delete expired admin records",
  );
  const reversed = structuredClone(final);
  reversed.grants.classhub_retention = base.final.grants.classhub_retention;
  assert.deepEqual(
    reversed,
    base.final,
    "Unexpected change outside the admin records retention delta",
  );
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:admin-records-retention:v1\0${base.plan.plan_sha256}\0${adminRecordsRetentionArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...adminRecordsRetentionArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + adminRecordsRetentionArtifacts.length,
      },
    },
  };
}
