import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";
import {
  buildMariaDbLegacyEvidencePlan as buildMariaDbInstallPlan,
  installArtifactCatalog,
  verifyMariaDbLegacyEvidencePlan as verifyMariaDbInstallPlan,
} from "./install-plan.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const allFollowups = ["class_access_approval", "archive_reason", "transaction_lock_keys"];
const changedRead = (target, change) => (path) =>
  path === target ? change(read(path)) : read(path);
const catalog = JSON.parse(read(installArtifactCatalog));

test("legacy evidence retains all 55 ordered SQL artifacts and the legacy one-file version-1 checksum", () => {
  const plan = buildMariaDbInstallPlan();
  assert.equal(plan.baseline_artifact_count, 55);
  assert.equal(plan.selected_artifact_count, 55);
  assert.equal(plan.ledger.planned_record_count, 54);
  assert.equal(plan.product_tables.length, 65);
  assert.deepEqual(plan.operational_tables, ["classhub_schema_migrations"]);
  assert.equal(plan.expected_base_table_count, 66);
  assert.deepEqual(plan.steps, catalog.baseline);
  assert.equal(plan.steps[0].kind, "provisioning");
  assert.equal(plan.steps[0].ledger_version, null);
  assert.equal(plan.steps[1].ledger_version, 1);
  assert.equal(plan.steps[1].source_path, "db/mariadb/migrations/0001_identity_foundation.sql");
  assert.equal(plan.steps[1].byte_length, 8231);
  assert.equal(
    plan.steps[1].sha256,
    "8dd18cce674a69209e2cd96df27796ddb22681dfb21a769669fc8f821611987a",
  );
  assert.equal(plan.ledger.source_checksum_scope, "one_exact_source_file_bytes");
  assert.notEqual(plan.plan_sha256, plan.steps[1].sha256);
  assert.match(
    read(plan.ledger.phase_one_record.source_path).toString(),
    new RegExp(`UNHEX\\('${plan.steps[1].sha256}'\\)`),
  );
  for (const step of plan.steps) {
    assert.equal(step.byte_length, read(step.source_path).length);
    assert.equal(step.sha256, sha256(read(step.source_path)));
  }
  const phaseTwo = plan.steps.filter((step) =>
    step.source_path.split("/").at(-1).startsWith("0002_"),
  );
  assert.equal(phaseTwo.length, 12);
  assert.equal(new Set(phaseTwo.map((step) => step.ledger_version)).size, 12);
  assert.deepEqual(
    phaseTwo.map((step) => step.ledger_version),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.equal(verifyMariaDbInstallPlan(plan).status, "legacy_install_evidence_pass");
});

test("the frozen compose contracts retain driver 55 automatic and semantic 51 plus 4 manual files", () => {
  const plan = buildMariaDbInstallPlan();
  for (const [index, artifact] of plan.baseline_composes.entries()) {
    const sql = read(artifact.source_path).toString("utf8");
    const mounts = [...sql.matchAll(/^\s+- \.\/([^:]+\.sql):([^:]+):ro$/gmu)];
    assert.equal(mounts.length, 55);
    assert.deepEqual(
      mounts.map((match) => match[1]),
      plan.steps.map((step) => step.source_path),
    );
    assert.equal(
      mounts.filter((match) => match[2].startsWith("/docker-entrypoint-initdb.d/")).length,
      index === 0 ? 55 : 51,
    );
    assert.equal(
      mounts.filter((match) => match[2].startsWith("/opt/classhub/semantic/")).length,
      index === 0 ? 0 : 4,
    );
  }
  assert.equal(plan.steps.filter((step) => step.kind === "provisioning").length, 2);
  assert.equal(plan.steps.filter((step) => step.kind === "schema").length, 40);
  assert.equal(plan.steps.filter((step) => step.kind === "runtime_grant").length, 1);
  assert.equal(plan.steps.filter((step) => step.kind === "owner_grant").length, 12);
});

test("selected follow-ups preserve owner-before-routines dependencies, SQL mode and operational seeds", () => {
  const plan = buildMariaDbInstallPlan({ followups: allFollowups });
  assert.equal(plan.selected_artifact_count, 59);
  assert.equal(plan.ledger.planned_record_count, 58);
  assert.deepEqual(
    plan.steps.slice(55).map((step) => step.ledger_version),
    [55, 56, 57, 58],
  );
  assert.deepEqual(
    plan.steps.slice(55).map((step) => step.id),
    [
      "class-access-approval-owner",
      "class-access-approval-routines",
      "archive-reason",
      "transaction-lock-keys",
    ],
  );
  assert.ok(plan.steps[56].requires.includes(plan.steps[55].id));
  assert.deepEqual(plan.steps[56].routine_targets, [
    "create_class_with_teacher_and_invite",
    "request_class_membership",
  ]);
  assert.deepEqual(plan.steps[57].routine_targets, ["archive_class"]);
  assert.equal(plan.steps[56].session_mode, "preserve_existing_routine_sql_mode");
  assert.equal(plan.steps[57].session_mode, "preserve_existing_routine_sql_mode");
  assert.equal(plan.steps[58].kind, "operational_schema");
  assert.equal(plan.steps[58].required_committed_seed_rows, 5);
  assert.equal(plan.steps[58].runtime_grants_included, false);
  assert.deepEqual(plan.operational_tables, [
    "classhub_schema_migrations",
    "transaction_lock_keys",
  ]);
  assert.equal(plan.expected_base_table_count, 67);
  assert.equal(plan.product_tables.includes("transaction_lock_keys"), false);
  assert.equal(verifyMariaDbInstallPlan(plan).status, "legacy_install_evidence_pass");
  assert.deepEqual(buildMariaDbInstallPlan({ followups: [...allFollowups].reverse() }), plan);
});

test("each variant is opt-in, retains its explicit versions and has a distinct plan checksum", () => {
  const variants = [[], ...allFollowups.map((id) => [id]), allFollowups].map((followups) =>
    buildMariaDbInstallPlan({ followups }),
  );
  assert.equal(new Set(variants.map((plan) => plan.plan_sha256)).size, variants.length);
  assert.deepEqual(variants[0].selected_followups, []);
  assert.deepEqual(
    variants[1].steps.slice(55).map((step) => step.ledger_version),
    [55, 56],
  );
  assert.deepEqual(
    variants[2].steps.slice(55).map((step) => step.ledger_version),
    [57],
  );
  assert.deepEqual(
    variants[3].steps.slice(55).map((step) => step.ledger_version),
    [58],
  );
  assert.equal(variants[2].expected_base_table_count, 66);
  assert.equal(variants[3].expected_base_table_count, 67);
  assert.throws(() => buildMariaDbInstallPlan({ followups: "all" }), /explicit array/u);
  assert.throws(() => buildMariaDbInstallPlan({ followups: ["unknown"] }), /unknown follow-up/u);
  assert.throws(
    () => buildMariaDbInstallPlan({ followups: [allFollowups[0], allFollowups[0]] }),
    /duplicate follow-up/u,
  );
});

test("source byte drift, same-length edits, CRLF conversion and missing artifacts fail closed", () => {
  const path = catalog.baseline[1].source_path;
  for (const change of [
    (bytes) => Buffer.concat([bytes, Buffer.from("\n")]),
    (bytes) => Buffer.from(bytes.toString("utf8").replaceAll("\n", "\r\n")),
    (bytes) => {
      const edited = Buffer.from(bytes);
      edited[10] ^= 1;
      return edited;
    },
  ])
    assert.throws(
      () => buildMariaDbInstallPlan({ readRepoFile: changedRead(path, change) }),
      /artifact byte(?:s| length) changed/u,
    );
  assert.throws(
    () =>
      buildMariaDbInstallPlan({
        readRepoFile: (target) => {
          if (target === path) throw new Error("missing source fixture");
          return read(target);
        },
      }),
    /missing source fixture/u,
  );
  for (const target of [
    catalog.ledger_controls[0].source_path,
    catalog.ledger_controls[1].source_path,
    catalog.baseline_composes[0].source_path,
  ])
    assert.throws(
      () =>
        buildMariaDbInstallPlan({
          readRepoFile: changedRead(target, (bytes) => Buffer.concat([bytes, Buffer.from("\n")])),
        }),
      /artifact byte length changed/u,
    );
  const followupPath = catalog.followups[2].steps[0].source_path;
  const readRepoFile = changedRead(followupPath, (bytes) =>
    Buffer.concat([bytes, Buffer.from("\n")]),
  );
  assert.equal(buildMariaDbInstallPlan({ readRepoFile }).selected_artifact_count, 55);
  assert.throws(
    () => buildMariaDbInstallPlan({ followups: ["transaction_lock_keys"], readRepoFile }),
    /artifact byte length changed/u,
  );
});

test("reviewed mapping changes cannot silently reassign versions, order or source checksums", () => {
  for (const change of [
    (value) => value.baseline.pop(),
    (value) => value.baseline.splice(2, 0, value.baseline[2]),
    (value) => value.baseline.reverse(),
    (value) => {
      value.baseline[1].ledger_version = 2;
    },
    (value) => {
      value.baseline[1].sha256 = "0".repeat(64);
    },
  ]) {
    const readRepoFile = changedRead(installArtifactCatalog, (bytes) => {
      const value = JSON.parse(bytes);
      change(value);
      return Buffer.from(JSON.stringify(value));
    });
    assert.throws(
      () => buildMariaDbInstallPlan({ readRepoFile }),
      /reviewed install artifact mapping changed/u,
    );
  }
});

test("plan verification rejects omissions, duplicates, order changes, activation claims and stale checksums", () => {
  const original = buildMariaDbInstallPlan({ followups: allFollowups });
  for (const change of [
    (plan) => plan.steps.pop(),
    (plan) => plan.steps.splice(4, 0, plan.steps[4]),
    (plan) => {
      [plan.steps[55], plan.steps[56]] = [plan.steps[56], plan.steps[55]];
    },
    (plan) => {
      plan.steps[1].sha256 = plan.plan_sha256;
    },
    (plan) => {
      plan.baseline_artifact_count = 54;
    },
    (plan) => {
      plan.product_tables.push("transaction_lock_keys");
    },
    (plan) => {
      plan.runtimeActivationApplied = true;
    },
    (plan) => {
      plan.execution_requirements.automatic_resume = true;
    },
    (plan) => {
      plan.plan_sha256 = "0".repeat(64);
    },
  ]) {
    const plan = JSON.parse(JSON.stringify(original));
    change(plan);
    assert.throws(
      () => verifyMariaDbInstallPlan(plan),
      /differs from the reviewed source contract/u,
    );
  }
  for (const plan of [buildMariaDbInstallPlan(), original]) {
    assert.equal(plan.candidateOnly, true);
    assert.equal(plan.runtimeActivationApplied, false);
    assert.equal(plan.executionEnabled, false);
    assert.equal(plan.execution_requirements.durable_started_journal, true);
    assert.equal(plan.execution_requirements.journal_and_executor_implemented, false);
    assert.equal(plan.execution_requirements.final_runtime_acl_activation_included, false);
  }
});
