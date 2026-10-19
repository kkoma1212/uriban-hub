import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 통합순7 웹 푸시 대기열(수업 시간 보류·묶음). 구독 테이블(76·77) 다음 원장 번호를 쓴다.
export const pushDeliveryArtifacts = Object.freeze([
  {
    id: "push-deliveries",
    ledger_version: 78,
    source_path: "db/mariadb/migrations/0048_push_deliveries.sql",
    byte_length: 1772,
    sha256: "4f7d3969b8055ff3acd80d465114d2a4cc503614c92cb6e0c576e627c3bd8fd4",
  },
  {
    id: "push-deliveries-acl",
    ledger_version: 79,
    source_path: "db/mariadb/permissions/0048_push_deliveries_acl.sql",
    byte_length: 347,
    sha256: "7a35ee81c79a495dffa1e348f7590b4d62c990e53a3291c8048a57b2788e56dc",
  },
]);
export function readPushDeliverySql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withPushDeliveryPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 77));
  assert(!base.plan.steps.some((step) => [78, 79].includes(step.ledger_version)));
  assert(!base.final.tables.push_deliveries);
  const final = structuredClone(base.final);
  for (const artifact of pushDeliveryArtifacts)
    applySourcePostcondition(final, readPushDeliverySql(artifact), artifact.id);
  // 새 테이블 하나와 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables.push_deliveries);
  delete reversed.tables.push_deliveries;
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => JSON.stringify(grant).includes("push_deliveries")));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the push delivery delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:push-deliveries:v1\0${base.plan.plan_sha256}\0${pushDeliveryArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...pushDeliveryArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
