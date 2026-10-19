import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildMariaDbInstallPlan } from "./install-plan.mjs";
import { applyActiveSemanticDependencies } from "./active-semantic-dependencies.mjs";
import {
  buildOptionalMaintenanceSelection,
  assertOptionalMaintenanceActivationOrder,
} from "./optional-maintenance-dependencies.mjs";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (plan) =>
  createHash("sha256")
    .update("classhub:mariadb:runtime-install-plan:v1\0" + JSON.stringify(canonical(plan)))
    .digest("hex");

/** Complete selected SQL inventory for an independently attested fresh-target rehearsal. */
export function buildRuntimeInstallPlan({ readRepoFile, archiveReason = true } = {}) {
  assert.equal(typeof archiveReason, "boolean");
  const followups = [
    "class_access_approval",
    "signup_role",
    "admin_user_status",
    "admin_member_status",
  ];
  const sourcePlan = buildMariaDbInstallPlan({
    followups,
    ...(readRepoFile ? { readRepoFile } : {}),
  });
  const semantic = applyActiveSemanticDependencies(sourcePlan, { readRepoFile });
  assert.equal(semantic.review.status, "selected_static_dependencies_complete");
  const selection = buildOptionalMaintenanceSelection(sourcePlan, {
    profiles: ["worker_security_audit_v1", "retention_v1"],
    readRepoFile,
  });
  assertOptionalMaintenanceActivationOrder(
    selection,
    selection.activation_order.map((action) => action.id),
    { readRepoFile },
  );
  const plan = {
    schema_version: 1,
    status: "fresh_runtime_install_rehearsal_plan",
    scope_id: sourcePlan.scope_id,
    source_plan_sha256: sourcePlan.plan_sha256,
    automatic_resume: false,
    static_dependencies_complete: true,
    production_activation_authorized: false,
    product_tables: selection.product_tables,
    operational_tables: selection.operational_tables,
    expected_base_table_count: selection.expected_base_table_count,
    ledger: { ...sourcePlan.ledger, planned_record_count: selection.planned_record_count },
    steps: selection.steps.map((step) => ({
      ...step,
      requires: [
        ...(semantic.steps.find((base) => base.id === step.id)?.requires ?? step.requires),
      ],
    })),
    static_review: semantic.review,
    optional_review: selection.review,
    activation_order: selection.activation_order,
    lock_contracts: selection.lock_contracts,
    final_runtime_grants: selection.final_runtime_grants,
    runtime_grant_profiles: selection.runtime_grant_profiles,
    selected_profiles: selection.selected_profiles,
    runtimeActivationApplied: false,
    target_preparation: {
      database: "classhub_mariadb_phase1_dev",
      existing_schema_allowed: false,
      real_user_data_allowed: false,
      native_default_public_privileges_sql: "REVOKE ALL PRIVILEGES, GRANT OPTION FROM PUBLIC",
      create_database_sql:
        "CREATE DATABASE classhub_mariadb_phase1_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    },
  };
  assert.equal(plan.steps.length, 58);
  assert.equal(plan.ledger.planned_record_count, 57);
  if (archiveReason) {
    // The maintenance review pins the original inventory. Append this already
    // reviewed compatibility delta without rewriting any installed checksum.
    const delta = buildMariaDbInstallPlan({
      followups: [...followups, "archive_reason"],
      ...(readRepoFile ? { readRepoFile } : {}),
    }).steps.find((step) => step.ledger_version === 57);
    assert.equal(delta.id, "archive-reason");
    plan.steps.push({ ...delta, after: plan.steps.at(-1).id });
    plan.ledger.planned_record_count++;
    plan.compatibility_followups = ["archive-reason"];
  }
  return { ...plan, plan_sha256: digest(plan) };
}

export function verifyRuntimeInstallPlan(plan, options) {
  assert.deepEqual(
    plan,
    buildRuntimeInstallPlan(options),
    "Runtime install plan differs from reviewed inputs",
  );
  return true;
}
