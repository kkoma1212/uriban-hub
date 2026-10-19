import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 통합순7 웹 푸시 구독 테이블. 투표 수동 마감(74·75) 다음 원장 번호를 쓴다.
export const pushSubscriptionArtifacts = Object.freeze([
  {
    id: "push-subscriptions",
    ledger_version: 76,
    source_path: "db/mariadb/migrations/0047_push_subscriptions.sql",
    byte_length: 1031,
    sha256: "cd29813b03492d973df5244f62a498014545d7d6aa00628e87891d889ad17ba8",
  },
  {
    id: "push-subscriptions-acl",
    ledger_version: 77,
    source_path: "db/mariadb/permissions/0047_push_subscriptions_acl.sql",
    byte_length: 320,
    sha256: "d1a4e3cc3e3ac675f10d60e7a7dc15d9fec9748014511234b359a8624704e4a6",
  },
]);
export function readPushSubscriptionSql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withPushSubscriptionPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 75));
  assert(!base.plan.steps.some((step) => [76, 77].includes(step.ledger_version)));
  assert(!base.final.tables.push_subscriptions);
  const final = structuredClone(base.final);
  for (const artifact of pushSubscriptionArtifacts)
    applySourcePostcondition(final, readPushSubscriptionSql(artifact), artifact.id);
  // 새 테이블 하나와 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables.push_subscriptions);
  delete reversed.tables.push_subscriptions;
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => JSON.stringify(grant).includes("push_subscriptions")));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the push subscription delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:push-subscriptions:v1\0${base.plan.plan_sha256}\0${pushSubscriptionArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...pushSubscriptionArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
