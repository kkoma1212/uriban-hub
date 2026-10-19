import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 관리자 작업 기록(2년)·탈퇴·철회 동의 증빙(1년) 자동 삭제(2026-10-03 사용자 승인, 총검수 I3-01).
// 원장 105: 원장 104 위에 정리 계정의 두 표 SELECT·DELETE만 더한다. 운영 적용은 백업 뒤 사용자 승인.
export const auditConsentRetentionArtifacts = Object.freeze([
  {
    id: "audit-consent-retention-acl",
    ledger_version: 105,
    source_path: "db/mariadb/permissions/0062_policy_audit_consents_retention_acl.sql",
    byte_length: 682,
    sha256: "9c802b16d653c27508e3154b2f85d99d309421d156a86831c797401879aec3ea",
  },
]);
const TABLES = ["admin_operation_audit_logs", "user_consents"];

export function readAuditConsentRetentionSql(artifact) {
  assert(
    auditConsentRetentionArtifacts.includes(artifact),
    "Unrecognized audit/consent retention artifact",
  );
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withAuditConsentRetentionPostconditions(base) {
  for (const table of TABLES) assert(base.final.tables[table], `${table} must exist first`);
  assert(
    base.plan.steps.some((step) => step.ledger_version === 104),
    "Ledger 104 must come first",
  );
  assert(!base.plan.steps.some((step) => step.ledger_version === 105));
  const final = structuredClone(base.final);
  for (const artifact of auditConsentRetentionArtifacts)
    applySourcePostcondition(final, readAuditConsentRetentionSql(artifact), artifact.id);
  // 정리 계정의 두 표 권한(SELECT·DELETE) 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const addedGrants = final.grants.classhub_retention.filter(
    (grant) => !base.final.grants.classhub_retention.includes(grant),
  );
  assert.deepEqual(
    [...addedGrants].sort(),
    TABLES.flatMap((table) => [`table|${table}|DELETE|*`, `table|${table}|SELECT|*`]).sort(),
    "The retention account may only count and delete expired audit and consent rows",
  );
  const reversed = structuredClone(final);
  reversed.grants.classhub_retention = base.final.grants.classhub_retention;
  assert.deepEqual(
    reversed,
    base.final,
    "Unexpected change outside the audit/consent retention delta",
  );
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:audit-consent-retention:v1\0${base.plan.plan_sha256}\0${auditConsentRetentionArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...auditConsentRetentionArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + auditConsentRetentionArtifacts.length,
      },
    },
  };
}
