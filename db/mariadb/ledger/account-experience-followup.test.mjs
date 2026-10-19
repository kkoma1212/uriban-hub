import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import { buildInstallPostconditionCatalog } from "./install-postconditions.mjs";
import {
  accountExperienceFollowup,
  readAccountExperienceSql,
  withAccountExperiencePostconditions,
} from "./account-experience-followup.mjs";

test("the account update keeps installed history, privileges and unrelated domain rules", () => {
  const base = buildInstallPostconditionCatalog({ archiveReason: false });
  const next = withAccountExperiencePostconditions(base);
  assert.equal(base.plan.ledger.planned_record_count, 57);
  assert.equal(next.plan.ledger.planned_record_count, 58);
  assert.equal(next.plan.steps.at(-1).ledger_version, 69);
  assert.deepEqual(next.plan.steps.slice(0, -1), base.plan.steps);
  for (const [table, state] of Object.entries(base.final.tables)) {
    if (!["admin_system_state", "admin_signup_approvals"].includes(table))
      assert.deepEqual(next.final.tables[table], state);
  }
  for (const [routine, state] of Object.entries(base.final.routines)) {
    if (routine !== "request_class_membership")
      assert.deepEqual(next.final.routines[routine], state);
  }
  assert.match(JSON.stringify(next.final.tables.admin_system_state.checks), /request_limits/u);
  assert.doesNotMatch(
    JSON.stringify(next.final.tables.admin_signup_approvals.checks),
    /between 0 and 5/iu,
  );
  assert.match(JSON.stringify(next.final.routines.request_class_membership), /'removed'/u);
  assert.doesNotMatch(
    JSON.stringify(next.final.routines.request_class_membership),
    /requires teacher rejoin allowance/u,
  );
});

test("changed SQL bytes cannot pass the pinned follow-up contract", () => {
  assert.throws(() => readAccountExperienceSql(() => Buffer.from("SELECT 1")));
  const source = Buffer.from(readAccountExperienceSql());
  source[0] = source[0] ^ 1;
  assert.equal(source.length, accountExperienceFollowup.byte_length);
  assert.throws(() => readAccountExperienceSql(() => source));
});
