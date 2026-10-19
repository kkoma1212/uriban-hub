import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const LINK_TABLES = Object.freeze(["schedule_notice_links", "schedule_supply_links"]);
// 통합순8 일정↔공지·준비물 영구 연결. 웹 푸시 대기열(78·79) 다음 원장 번호를 쓴다.
export const scheduleLinkArtifacts = Object.freeze([
  {
    id: "schedule-links",
    ledger_version: 80,
    source_path: "db/mariadb/migrations/0049_schedule_links.sql",
    byte_length: 2060,
    sha256: "08db8c5cb09823d2676c00fa9d9b8b6a33398f5b229cccd41e170e9b89a90e5b",
  },
  {
    id: "schedule-links-acl",
    ledger_version: 81,
    source_path: "db/mariadb/permissions/0049_schedule_links_acl.sql",
    byte_length: 302,
    sha256: "848f885a9424dbbd055d01ea1e45251cdcdcee1a423696ef5e62d2aa162789be",
  },
]);
export function readScheduleLinkSql(artifact) {
  const bytes = readFileSync(new URL(artifact.source_path, root));
  assert.equal(bytes.length, artifact.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  return bytes.toString("utf8");
}
export function withScheduleLinkPostconditions(base) {
  assert(base.plan.steps.some((step) => step.ledger_version === 79));
  assert(!base.plan.steps.some((step) => [80, 81].includes(step.ledger_version)));
  for (const table of LINK_TABLES) assert(!base.final.tables[table]);
  const final = structuredClone(base.final);
  for (const artifact of scheduleLinkArtifacts)
    applySourcePostcondition(final, readScheduleLinkSql(artifact), artifact.id);
  // 새 연결 테이블 둘과 그 권한 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  for (const table of LINK_TABLES) {
    assert(reversed.tables[table]);
    delete reversed.tables[table];
  }
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  assert(
    addedGrants.every((grant) =>
      LINK_TABLES.some((table) => JSON.stringify(grant).includes(table)),
    ),
  );
  assert.equal(
    reversed.seeds.audit_log_actions.filter((action) => action === "schedule.links_updated").length,
    1,
  );
  reversed.seeds.audit_log_actions = reversed.seeds.audit_log_actions.filter(
    (action) => action !== "schedule.links_updated",
  );
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, "Unexpected change outside the schedule link delta");
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:schedule-links:v1\0${base.plan.plan_sha256}\0${scheduleLinkArtifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...scheduleLinkArtifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 2,
      },
    },
  };
}
