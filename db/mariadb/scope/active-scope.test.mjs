import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import {
  readMariaDbActiveScope,
  mariaDbMigrationTables,
  activeMariaDbScopePath,
} from "./active-scope.mjs";
import {
  buildMariaDbInstallPlan,
  buildMariaDbLegacyEvidencePlan,
  verifyMariaDbInstallPlan,
} from "../ledger/install-plan.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const changedRead = (target, change) => (path) =>
  path === target ? change(read(path)) : read(path);
const followups = ["class_access_approval", "archive_reason", "transaction_lock_keys"];
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
function rehash(plan) {
  const value = { ...plan };
  delete value.plan_sha256;
  plan.plan_sha256 = hash("classhub:mariadb:install-plan:v1\0" + JSON.stringify(canonical(value)));
}

test("default installation and migration inventory retain exactly 54 tables and 46 original artifacts", () => {
  const scope = readMariaDbActiveScope(),
    plan = buildMariaDbInstallPlan();
  const historical = buildMariaDbLegacyEvidencePlan();
  assert.equal(historical.legacyEvidenceOnly, true);
  assert.equal(historical.status, "mariadb_legacy_install_evidence");
  assert.equal(historical.product_tables.length, 65);
  assert.equal(historical.steps.length, 55);
  assert.equal(plan.product_tables.length, 54);
  assert.deepEqual(mariaDbMigrationTables(), plan.product_tables);
  assert.deepEqual(plan.migration_tables, plan.product_tables);
  assert.deepEqual(
    [...plan.product_tables, ...scope.retired_tables].sort(),
    historical.product_tables,
  );
  assert.equal(plan.steps.length, 46);
  assert.equal(plan.ledger.planned_record_count, 45);
  assert.equal(plan.expected_base_table_count, 55);
  assert.deepEqual(plan.operational_tables, ["classhub_schema_migrations"]);
  assert.deepEqual(plan.baseline_composes, []);
  assert.equal(plan.legacy_evidence.status, "legacy_evidence_only");
  assert.equal(plan.legacy_evidence.baseline_composes.length, 2);
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    scope.baseline_artifact_ids,
  );
  for (const step of plan.steps) {
    const original = historical.steps.find((item) => item.id === step.id);
    for (const field of [
      "source_path",
      "sha256",
      "byte_length",
      "ledger_version",
      "mount_file",
      "kind",
    ])
      assert.equal(step[field], original[field]);
    assert.equal(hash(read(step.source_path)), step.sha256);
  }
  assert.equal(plan.steps[1].ledger_version, 1);
  assert.equal(
    plan.steps[1].sha256,
    "8dd18cce674a69209e2cd96df27796ddb22681dfb21a769669fc8f821611987a",
  );
  assert.deepEqual(plan.ledger.retired_unapplied_versions, [29, 30, 31, 32, 33, 34, 35, 40, 41]);
  assert.equal(verifyMariaDbInstallPlan(plan).status, "install_plan_candidate_pass");
  assert.throws(() => verifyMariaDbInstallPlan(historical), /reviewed active source contract/u);
});

test("after is ordering only; retained semantic prerequisites and opt-in followups remain explicit", () => {
  const plan = buildMariaDbInstallPlan({ followups });
  assert.equal(plan.steps.length, 50);
  assert.equal(plan.ledger.planned_record_count, 49);
  assert.equal(plan.expected_base_table_count, 56);
  const audit = plan.steps.find((step) => step.id === "audit-action-catalog");
  assert.equal(audit.after, "polls");
  assert.deepEqual(audit.requires, ["audit-import-logs", "polls"]);
  const holiday = plan.steps.find((step) => step.id === "public-holidays");
  assert.equal(holiday.after, "election-tie-break-trigger");
  assert.deepEqual(holiday.requires, []);
  assert.equal(plan.dependency_semantics.complete_semantic_dependency_review, false);
  assert.deepEqual(
    plan.steps.slice(46).map((step) => step.ledger_version),
    [55, 56, 57, 58],
  );
  const routines = plan.steps.find((step) => step.id === "class-access-approval-routines");
  assert.ok(routines.requires.includes("class-access-approval-owner"));
  assert.ok(routines.requires.includes("class-transition-lifecycle-routines"));
  assert.equal(routines.session_mode, "preserve_existing_routine_sql_mode");
  assert.equal(plan.product_tables.includes("transaction_lock_keys"), false);
  assert.deepEqual(buildMariaDbInstallPlan({ followups: [...followups].reverse() }), plan);
});

test("retired tables and artifacts cannot be injected even with a recomputed plan checksum", () => {
  const original = buildMariaDbInstallPlan(),
    historical = buildMariaDbLegacyEvidencePlan();
  const retired = historical.steps.find((step) => step.id === "seat-draws");
  for (const change of [
    (plan) => plan.product_tables.push("seat_draws"),
    (plan) => plan.migration_tables.push("layout_draft_autosaves"),
    (plan) => plan.steps.splice(29, 0, retired),
    (plan) => {
      plan.steps[29].source_path = retired.source_path;
    },
    (plan) => {
      plan.steps[29].requires.push("duty-rosters");
    },
    (plan) => {
      plan.steps[29].after = "duty-rosters";
    },
    (plan) => {
      plan.baseline_composes = historical.baseline_composes;
    },
    (plan) => {
      plan.executionEnabled = true;
    },
    (plan) => {
      plan.execution_blockers = [];
    },
    (plan) => {
      plan.dependency_semantics.complete_semantic_dependency_review = true;
    },
    (plan) => {
      plan.ledger.retired_unapplied_versions = [];
    },
  ]) {
    const plan = globalThis.structuredClone(original);
    change(plan);
    rehash(plan);
    assert.throws(() => verifyMariaDbInstallPlan(plan), /reviewed active source contract/u);
  }
});

test("active profile and historical byte drift remain distinct fail-closed contracts", () => {
  for (const change of [
    (scope) => scope.retired_tables.pop(),
    (scope) => scope.product_tables.push("team_draws"),
    (scope) => scope.retired_artifact_paths.pop(),
    (scope) => scope.baseline_artifact_ids.reverse(),
    (scope) => {
      scope.executionEnabled = true;
    },
  ]) {
    const readRepoFile = changedRead(activeMariaDbScopePath, (bytes) => {
      const scope = JSON.parse(bytes);
      change(scope);
      return Buffer.from(JSON.stringify(scope));
    });
    assert.throws(
      () => buildMariaDbInstallPlan({ readRepoFile }),
      /reviewed active scope bytes changed/u,
    );
  }
  for (const path of [
    "db/mariadb/manifest.json",
    "db/mariadb/ledger/install-artifacts.json",
    "db/mariadb/migrations/0035_retention_lock_keys.sql",
  ])
    assert.throws(
      () =>
        buildMariaDbInstallPlan({
          readRepoFile: changedRead(path, (bytes) => Buffer.concat([bytes, Buffer.from("\n")])),
        }),
      /legacy evidence bytes changed/u,
    );
});

test("three retained retention lock seeds are attested but are not falsely installed or granted", () => {
  const plan = buildMariaDbInstallPlan();
  assert.equal(plan.pending_operational_artifacts.length, 1);
  const pending = plan.pending_operational_artifacts[0];
  const source = read(pending.source_path).toString("utf8");
  const expected = [
    "attendance_notifications",
    "guardian_consent_requests",
    "student_assessment_records",
  ]
    .map((table) =>
      hash(`classhub:mariadb:transaction-lock:v1:pg-hashtext\0classhub.${table}.retention.v1`),
    )
    .sort();
  assert.deepEqual(
    [...source.matchAll(/0x([a-f0-9]{64})/gu)].map((match) => match[1]).sort(),
    expected,
  );
  assert.equal(pending.required_committed_seed_rows, 3);
  assert.equal(pending.ledger_version, null);
  assert.equal(pending.execution_included, false);
  assert.equal(pending.runtime_grants_included, false);
  assert.ok(
    plan.execution_blockers.includes("retained_retention_lock_artifact_not_assigned_or_mounted"),
  );
  assert.ok(!plan.steps.some((step) => step.source_path === pending.source_path));
  assert.ok(!plan.operational_tables.includes("retention_lock_keys"));
  assert.throws(
    () =>
      buildMariaDbInstallPlan({
        readRepoFile: changedRead(pending.source_path, (bytes) =>
          Buffer.from(bytes.toString().replace("e967e982", "f967e982")),
        ),
      }),
    /pending operational artifact bytes changed/u,
  );
});

test("scope readiness remains blocked for concrete integration work", () => {
  const plan = buildMariaDbInstallPlan();
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.runtimeActivationApplied, false);
  assert.equal(plan.execution_requirements.existing_databases_are_not_modified, true);
  assert.equal(plan.execution_requirements.active_scope_runtime_acl_prepared, true);
  assert.equal(plan.execution_requirements.active_scope_compose_prepared, true);
  assert.equal(plan.execution_requirements.active_scope_installation_and_restore_verified, false);
  assert.equal(plan.execution_requirements.journal_and_executor_implemented, false);
  assert.deepEqual(plan.execution_blockers, [
    "retired_cleanup_callers_and_retention_not_verified_on_active_schema",
    "active_schema_restore_not_verified",
    "semantic_dependencies_not_exhaustively_reviewed",
    "durable_journal_and_executor_unimplemented",
    "retained_retention_lock_artifact_not_assigned_or_mounted",
  ]);
});
