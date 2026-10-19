import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";

const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
export const accountExperienceFollowup = Object.freeze({
  id: "account-experience",
  ledger_version: 69,
  source_path: "db/mariadb/migrations/0041_account_experience.sql",
  byte_length: 6618,
  sha256: "0d42bb122a44ba4ac949e5ae3cd8e132452a07f430d8324f4e7ce66782a97535",
});

export function readAccountExperienceSql(readRepoFile = defaultRead) {
  const source = readRepoFile(accountExperienceFollowup.source_path);
  assert.equal(source.length, accountExperienceFollowup.byte_length);
  assert.equal(createHash("sha256").update(source).digest("hex"), accountExperienceFollowup.sha256);
  return source.toString("utf8");
}

/** A separate, explicit follow-up preserves the already installed 57 ledger checksums. */
export function withAccountExperiencePostconditions(base, readRepoFile = defaultRead) {
  const final = structuredClone(base.final);
  assert.ok(
    !base.plan.steps.some(
      (step) => step.ledger_version === accountExperienceFollowup.ledger_version,
    ),
  );
  applySourcePostcondition(
    final,
    readAccountExperienceSql(readRepoFile),
    accountExperienceFollowup.id,
  );
  assert.deepEqual(final.grants, base.final.grants);
  assert.deepEqual(Object.keys(final.tables), Object.keys(base.final.tables));
  assert.deepEqual(Object.keys(final.routines), Object.keys(base.final.routines));
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      installation_plan_sha256: base.plan.plan_sha256,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:account-experience:v1\0${base.plan.plan_sha256}\0${accountExperienceFollowup.sha256}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, accountExperienceFollowup],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + 1,
      },
    },
  };
}
