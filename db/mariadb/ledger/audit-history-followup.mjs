import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
export const auditHistoryFollowup = Object.freeze({
  id: "preserved-audit-history",
  ledger_version: 71,
  source_path: "db/mariadb/migrations/0043_preserved_audit_history.sql",
  byte_length: 10006,
  sha256: "98f837eb32c642517e7dc9743601c88186a93f9d3e59a3b6f189e4ce97b88a59",
});
export function readAuditHistorySql(readRepoFile = defaultRead) {
  const source = readRepoFile(auditHistoryFollowup.source_path);
  assert.equal(source.length, auditHistoryFollowup.byte_length);
  assert.equal(createHash("sha256").update(source).digest("hex"), auditHistoryFollowup.sha256);
  return source.toString("utf8");
}
export function withAuditHistoryPostconditions(base, readRepoFile = defaultRead) {
  assert.ok(base.plan.steps.some((step) => step.ledger_version === 70));
  assert.ok(!base.plan.steps.some((step) => step.ledger_version === 71));
  const final = structuredClone(base.final);
  applySourcePostcondition(final, readAuditHistorySql(readRepoFile), auditHistoryFollowup.id);
  assert.deepEqual(final.grants, base.final.grants);
  assert.deepEqual(final.routines, base.final.routines);
  assert.deepEqual(final.triggers, base.final.triggers);
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:audit-history:v1\0${base.plan.plan_sha256}\0${auditHistoryFollowup.sha256}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, auditHistoryFollowup],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 1,
      },
    },
  };
}
