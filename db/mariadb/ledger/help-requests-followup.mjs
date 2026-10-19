import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
// 통합순9 도움 요청. 일정 연결(80·81) 다음 원장 번호를 쓴다.
export const helpRequestArtifacts = Object.freeze([
  {
    id: "help-requests",
    ledger_version: 82,
    source_path: "db/mariadb/migrations/0050_help_requests.sql",
    byte_length: 2780,
    sha256: "c8a0ad5665db82b9f691838d23a00c9ddd61209a05dece2219a95e0d42740b98",
  },
  {
    id: "help-requests-acl",
    ledger_version: 83,
    source_path: "db/mariadb/permissions/0050_help_requests_acl.sql",
    byte_length: 288,
    sha256: "58454f81a98391e80bb2595a953d5d7a36c1d9e67a011afb80e990129fe7ccc3",
  },
]);
export function readHelpRequestSql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withHelpRequestPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 81));
  assert(!base.plan.steps.some((step) => [82, 83].includes(step.ledger_version)));
  assert(!base.final.tables.help_requests);
  const final = structuredClone(base.final);
  for (const artifact of helpRequestArtifacts)
    applySourcePostcondition(final, readHelpRequestSql(artifact), artifact.id);
  // 새 테이블 하나와 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  assert(reversed.tables.help_requests);
  delete reversed.tables.help_requests;
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(addedGrants.every((grant) => JSON.stringify(grant).includes("help_requests")));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the help request delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:help-requests:v1\0${base.plan.plan_sha256}\0${helpRequestArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...helpRequestArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
