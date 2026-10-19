import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 관리자 로그인 세션 강제 종료(2026-09-30). 원장 98: 관리자 작업 기록의 동작·대상 검사에 값 하나씩만 더한다.
// 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const adminSessionRevokeArtifacts = Object.freeze([
  {
    id: "admin-session-revoke",
    ledger_version: 98,
    source_path: "db/mariadb/migrations/0058_admin_session_revoke.sql",
    byte_length: 1408,
    sha256: "69111f07e132c8bf91f47406b6b160e07ae7ace2aa8d3a1acc6aca591c91f963",
  },
]);
const TABLE = "admin_operation_audit_logs";

export function readAdminSessionRevokeSql(artifact) {
  assert(adminSessionRevokeArtifacts.includes(artifact), "Unrecognized session revoke artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withAdminSessionRevokePostconditions(base) {
  assert(base.final.tables[TABLE], "Admin operation audit table must exist first");
  assert(!base.plan.steps.some((step) => step.ledger_version === 98));
  const final = structuredClone(base.final);
  for (const artifact of adminSessionRevokeArtifacts)
    applySourcePostcondition(final, readAdminSessionRevokeSql(artifact), artifact.id);
  // 두 검사식(action·target_type) 말고는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const table = final.tables[TABLE];
  assert.notDeepEqual(table.checks.action, base.final.tables[TABLE].checks.action);
  assert.notDeepEqual(table.checks.target_type, base.final.tables[TABLE].checks.target_type);
  const reversed = structuredClone(final);
  reversed.tables[TABLE].checks.action = base.final.tables[TABLE].checks.action;
  reversed.tables[TABLE].checks.target_type = base.final.tables[TABLE].checks.target_type;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the session revoke delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:admin-session-revoke:v1\0${base.plan.plan_sha256}\0${adminSessionRevokeArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...adminSessionRevokeArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + adminSessionRevokeArtifacts.length,
      },
    },
  };
}
