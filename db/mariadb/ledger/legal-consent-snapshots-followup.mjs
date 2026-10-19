import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 법률 동의 문서 결속 칸(T-LEGAL-BINDING, 2026-10-03 사용자 결정 B안). 원장 103: 동의 기록과 보호자
// 동의 요청에 문서 묶음 칸(document_snapshot), 동의 버전 칸을 80자로. 기존 행은 채우지 않는다.
// 권한은 표 단위라 바뀌지 않는다. 결속을 켜는 것은 정식 문서 게시 뒤 별도 결정이다.
// 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const legalConsentSnapshotArtifacts = Object.freeze([
  {
    id: "legal-consent-snapshots",
    ledger_version: 103,
    source_path: "db/mariadb/migrations/0045_legal_consent_snapshots.sql",
    byte_length: 939,
    sha256: "45fd92a92c950c86bf04e427fdb1e6d0c416ab2426709e1025519c4a28e8b363",
  },
]);
const SNAPSHOT_CHECKS = {
  user_consents: "user_consents_snapshot_check",
  guardian_consent_requests: "guardian_consent_snapshot_check",
};

export function readLegalConsentSnapshotSql(artifact) {
  assert(
    legalConsentSnapshotArtifacts.includes(artifact),
    "Unrecognized legal consent snapshot artifact",
  );
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withLegalConsentSnapshotPostconditions(base) {
  for (const table of Object.keys(SNAPSHOT_CHECKS)) {
    assert(base.final.tables[table], `${table} must exist first`);
    assert(!base.final.tables[table].columns.document_snapshot);
  }
  assert(!base.plan.steps.some((step) => step.ledger_version === 103));
  const final = structuredClone(base.final);
  for (const artifact of legalConsentSnapshotArtifacts)
    applySourcePostcondition(final, readLegalConsentSnapshotSql(artifact), artifact.id);
  // 두 표의 묶음 칸·검사와 동의 버전 칸 길이 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  for (const [table, check] of Object.entries(SNAPSHOT_CHECKS)) {
    const target = reversed.tables[table];
    assert(target.columns.document_snapshot, `${table}.document_snapshot must be added`);
    delete target.columns.document_snapshot;
    assert(target.checks[check], `${check} must be added`);
    delete target.checks[check];
    // MariaDB가 JSON 칸에 자동으로 붙이는 json_valid 검사(칸 이름과 같은 이름).
    assert(target.checks.document_snapshot, `${table} JSON validity check must be added`);
    delete target.checks.document_snapshot;
  }
  const versionColumn = reversed.tables.user_consents.columns.policy_version;
  assert.notDeepEqual(
    versionColumn,
    base.final.tables.user_consents.columns.policy_version,
    "policy_version must be widened",
  );
  reversed.tables.user_consents.columns.policy_version =
    base.final.tables.user_consents.columns.policy_version;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the legal snapshot delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:legal-consent-snapshots:v1\0${base.plan.plan_sha256}\0${legalConsentSnapshotArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...legalConsentSnapshotArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + legalConsentSnapshotArtifacts.length,
      },
    },
  };
}
