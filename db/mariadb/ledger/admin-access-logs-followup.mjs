import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 관리자 개인정보 조회 접속기록(2026-10-03 사용자 결정). 원장 101: 새 표 하나, 원장 102: 앱의 SELECT·INSERT.
// 자동 적용하지 않는다 — 운영 적용은 백업·복구 확인 뒤 사용자 승인.
export const adminAccessLogArtifacts = Object.freeze([
  {
    id: "admin-access-logs",
    ledger_version: 101,
    source_path: "db/mariadb/migrations/0060_admin_access_logs.sql",
    byte_length: 2172,
    sha256: "a31e8d6303e32c133819ca5a320d3ad2edc768e7e77026026df082ae5b585fa7",
  },
  {
    id: "admin-access-logs-acl",
    ledger_version: 102,
    source_path: "db/mariadb/permissions/0060_admin_access_logs_acl.sql",
    byte_length: 405,
    sha256: "c1f5fe3797092b27125cafbed46c655593d6180a909a9d35858b680714300994",
  },
]);
const TABLE = "admin_access_logs";

export function readAdminAccessLogSql(artifact) {
  assert(adminAccessLogArtifacts.includes(artifact), "Unrecognized admin access log artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withAdminAccessLogPostconditions(base) {
  assert(base.final.tables.admin_accounts, "Admin accounts table must exist first");
  assert(!base.plan.steps.some((step) => [101, 102].includes(step.ledger_version)));
  assert(!base.final.tables[TABLE]);
  const final = structuredClone(base.final);
  for (const artifact of adminAccessLogArtifacts)
    applySourcePostcondition(final, readAdminAccessLogSql(artifact), artifact.id);
  // 새 표 하나와 앱의 그 표 권한(SELECT·INSERT) 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables[TABLE], `${TABLE} must be created`);
  delete reversed.tables[TABLE];
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert.deepEqual(
    [...addedGrants].sort(),
    [`table|${TABLE}|INSERT|*`, `table|${TABLE}|SELECT|*`],
    "The app may only read and add access logs",
  );
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the admin access log delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:admin-access-logs:v1\0${base.plan.plan_sha256}\0${adminAccessLogArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...adminAccessLogArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + adminAccessLogArtifacts.length,
      },
    },
  };
}
