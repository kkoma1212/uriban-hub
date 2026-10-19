import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInstallPostconditionCatalog } from "./install-postconditions.mjs";
import { withAccountExperiencePostconditions } from "./account-experience-followup.mjs";
import { withMailManagementPostconditions } from "./mail-management-followup.mjs";

test("mail follow-up adds two product tables and scoped app privileges without rewriting history", () => {
  const previous = withAccountExperiencePostconditions(
    buildInstallPostconditionCatalog({ archiveReason: false }),
  );
  const current = withMailManagementPostconditions(previous);
  assert.equal(Object.keys(current.final.tables).length, 59);
  assert.equal(current.plan.product_tables.length, 56);
  assert.deepEqual(current.plan.steps.slice(0, -1), previous.plan.steps);
  assert.equal(
    current.final.grants.classhub_app.length - previous.final.grants.classhub_app.length,
    11,
  );
  assert.deepEqual(current.final.routines, previous.final.routines);
  assert.equal(current.plan.ledger.planned_record_count, 59);
});
