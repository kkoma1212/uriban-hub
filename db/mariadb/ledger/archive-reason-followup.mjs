import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
export const archiveReasonFollowup = Object.freeze({
  id: "archive-reason",
  ledger_version: 57,
  source_path: "db/mariadb/migrations/0031_archive_reason.sql",
  byte_length: 9262,
  sha256: "371ccc51aef70cf2f95ff3a24e452a04d845d99472f5f2e435cf6fd72a9cc8e5",
});
export function readArchiveReasonSql() {
  const bytes = readFileSync(new URL(archiveReasonFollowup.source_path, root));
  assert.equal(bytes.length, archiveReasonFollowup.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), archiveReasonFollowup.sha256);
  return bytes.toString("utf8");
}

/** Explicitly select the existing, previously omitted archive compatibility delta. */
export function assertArchiveReasonDelta(before, final) {
  const reversed = structuredClone(final);
  assert.equal(final.routines.archive_class.body.split("'반 운영 종료'").length, 3);
  reversed.routines.archive_class.body = reversed.routines.archive_class.body.replaceAll(
    "'반 운영 종료'",
    "'반 아카이브'",
  );
  assert.deepEqual(reversed, before, "Only two archive reason literals may change");
}

export function withArchiveReasonPostconditions(base) {
  assert.ok(!base.plan.steps.some((step) => step.ledger_version === 57));
  const final = structuredClone(base.final);
  applySourcePostcondition(final, readArchiveReasonSql(), archiveReasonFollowup.id);
  assertArchiveReasonDelta(base.final, final);
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:archive-reason:v1\0${base.plan.plan_sha256}\0${archiveReasonFollowup.sha256}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, archiveReasonFollowup],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 1,
      },
    },
  };
}
