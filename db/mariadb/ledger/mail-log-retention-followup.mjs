import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 메일 발송 기록 1년 자동 삭제(2026-10-03 사용자 승인, 총검수 I5-04). 원장 104: 정리 계정의
// mail_delivery_logs SELECT·DELETE만 더한다. 자동 적용하지 않는다 — 운영 적용은 백업 뒤 사용자 승인.
export const mailLogRetentionArtifacts = Object.freeze([
  {
    id: "mail-log-retention-acl",
    ledger_version: 104,
    source_path: "db/mariadb/permissions/0061_mail_delivery_logs_retention_acl.sql",
    byte_length: 544,
    sha256: "be29982654fd84efdf6cbc5489f93b9729a06c72b216fbb1b1756732d3429359",
  },
]);
const TABLE = "mail_delivery_logs";

export function readMailLogRetentionSql(artifact) {
  assert(mailLogRetentionArtifacts.includes(artifact), "Unrecognized mail log retention artifact");
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}

export function withMailLogRetentionPostconditions(base) {
  assert(base.final.tables[TABLE], "Mail delivery log table must exist first");
  assert(!base.plan.steps.some((step) => step.ledger_version === 104));
  const final = structuredClone(base.final);
  for (const artifact of mailLogRetentionArtifacts)
    applySourcePostcondition(final, readMailLogRetentionSql(artifact), artifact.id);
  // 정리 계정의 그 표 권한(SELECT·DELETE) 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const addedGrants = final.grants.classhub_retention.filter(
    (grant) => !base.final.grants.classhub_retention.includes(grant),
  );
  assert.deepEqual(
    [...addedGrants].sort(),
    [`table|${TABLE}|DELETE|*`, `table|${TABLE}|SELECT|*`],
    "The retention account may only count and delete mail delivery logs",
  );
  const reversed = structuredClone(final);
  reversed.grants.classhub_retention = base.final.grants.classhub_retention;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the mail log retention delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:mail-log-retention:v1\0${base.plan.plan_sha256}\0${mailLogRetentionArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...mailLogRetentionArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count:
          base.plan.ledger.planned_record_count + mailLogRetentionArtifacts.length,
      },
    },
  };
}
