import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildMariaDbInstallPlan,
  buildMariaDbLegacyEvidencePlan,
  verifyMariaDbInstallPlan,
} from "./install-plan.mjs";
import {
  currentApplicationArtifactCatalog,
  currentApplicationFollowupIds,
} from "./current-application-followups.mjs";

test("current application steps extend the active plan without changing historical artifacts or inferring user roles", () => {
  const baseline = buildMariaDbInstallPlan();
  const plan = buildMariaDbInstallPlan({ followups: currentApplicationFollowupIds });
  assert.deepEqual(plan.steps.slice(0, 46), baseline.steps);
  assert.deepEqual(plan.product_tables, baseline.product_tables);
  assert.deepEqual(
    plan.steps.slice(46).map((step) => step.ledger_version),
    [59, 60, 61, 62, 63],
  );
  assert.equal(plan.ledger.planned_record_count, 50);
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.runtimeActivationApplied, false);
  assert.equal(verifyMariaDbInstallPlan(plan).status, "install_plan_candidate_pass");
  assert.deepEqual(
    buildMariaDbInstallPlan({ followups: [...currentApplicationFollowupIds].reverse() }),
    plan,
  );
  assert.equal(buildMariaDbLegacyEvidencePlan().steps.length, 55);
  const signup = readFileSync(plan.steps[46].source_path, "utf8");
  assert.match(signup, /signup_role VARCHAR\(7\).*NULL/u);
  assert.doesNotMatch(signup, /UPDATE\s+users\s+SET/iu);
});

test("source or mapping changes cannot silently enter a current plan", () => {
  for (const target of [
    currentApplicationArtifactCatalog,
    "db/mariadb/migrations/0037_signup_role.sql",
    "db/mariadb/migrations/0038_admin_user_status.sql",
    "db/mariadb/permissions/0038_admin_user_status_execute.sql",
    "db/mariadb/migrations/0040_admin_member_status.sql",
    "db/mariadb/permissions/0040_admin_member_status_execute.sql",
  ]) {
    assert.throws(
      () =>
        buildMariaDbInstallPlan({
          followups: currentApplicationFollowupIds,
          readRepoFile: (path) =>
            Buffer.concat([
              readFileSync(path),
              Buffer.from(path === target ? "\n-- unreviewed drift" : ""),
            ]),
        }),
      /current application artifact/u,
    );
  }
  assert.throws(
    () => buildMariaDbInstallPlan({ followups: ["signup_role", "signup_role"] }),
    /duplicate/u,
  );
  assert.throws(
    () => buildMariaDbInstallPlan({ followups: ["missing_followup"] }),
    /unknown follow-up/u,
  );
});
