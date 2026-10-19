import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  activeMariaDbScopeSha256,
  readMariaDbActiveScope,
  assertMariaDbActiveSelection,
} from "../scope/active-scope.mjs";
import {
  currentApplicationFollowupIds,
  readCurrentApplicationFollowups,
} from "./current-application-followups.mjs";

const root = new URL("../../../", import.meta.url);
export const installArtifactCatalog = "db/mariadb/ledger/install-artifacts.json";
const catalogSha256 = "ba16d89ac7b1b66aa2f5dc0944605fb21215c67275b09dc3e7ac92dcd646756b";
const phaseOneSha256 = "8dd18cce674a69209e2cd96df27796ddb22681dfb21a769669fc8f821611987a";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const defaultRead = (path) => readFileSync(new URL(path, root));
const manualSemanticIds = new Set([
  "identity-school",
  "checked-transfer",
  "checked-transfer-owner",
  "retention-actor",
]);
const kinds = new Set([
  "provisioning",
  "schema",
  "runtime_grant",
  "owner_grant",
  "routine_replacement",
  "operational_schema",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function planChecksum(plan) {
  return sha256("classhub:mariadb:install-plan:v1\0" + JSON.stringify(canonical(plan)));
}
function collectSqlMounts(source) {
  const declarations = source.split(/\r?\n/u).filter((line) => /^\s+- .*\.sql:/u.test(line));
  return declarations.map((line) => {
    const match = /^\s+- \.\/([^:]+\.sql):([^:]+):ro$/u.exec(line);
    assert.ok(match, "SQL mount must be one exact read-only repository artifact");
    return { source_path: match[1], destination: match[2] };
  });
}

/**
 * Historical evidence only: no connection, SQL execution, ledger writes or automatic resume.
 * Versions come from the reviewed JSON mapping, never a SQL filename prefix.
 * The bootstrap identity script is outside the ledger; the remaining baseline artifacts
 * have explicit versions 1..54. Operational ledger DDL is a separate precondition.
 */
export function buildMariaDbLegacyEvidencePlan({
  followups = [],
  readRepoFile = defaultRead,
} = {}) {
  assert.ok(Array.isArray(followups), "followups must be an explicit array");
  assert.equal(new Set(followups).size, followups.length, "duplicate follow-up selection");
  const captured = new Map();
  const read = (path) => {
    assert.match(path, /^[a-zA-Z0-9_./-]+$/u, "invalid repository artifact path");
    assert.ok(
      !path.startsWith("/") && !path.split("/").includes(".."),
      "artifact escapes repository",
    );
    if (!captured.has(path)) {
      const input = readRepoFile(path);
      assert.ok(
        typeof input === "string" || input instanceof Uint8Array,
        "artifact reader must return bytes or UTF-8 text",
      );
      captured.set(path, Buffer.from(input));
    }
    return captured.get(path);
  };
  const catalogBytes = read(installArtifactCatalog);
  assert.equal(sha256(catalogBytes), catalogSha256, "reviewed install artifact mapping changed");
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.candidateOnly, true);
  assert.equal(catalog.runtimeActivationApplied, false);
  const checkArtifact = (artifact) => {
    const bytes = read(artifact.source_path);
    assert.equal(
      bytes.length,
      artifact.byte_length,
      `artifact byte length changed: ${artifact.source_path}`,
    );
    assert.equal(sha256(bytes), artifact.sha256, `artifact bytes changed: ${artifact.source_path}`);
    return bytes;
  };
  const baseline = catalog.baseline;
  assert.equal(baseline.length, 55, "expected the complete reviewed baseline");
  const mountOrder = baseline.map((step) => step.mount_file);
  assert.deepEqual(
    mountOrder,
    [...mountOrder].sort(),
    "entrypoint filename execution order differs from the reviewed plan",
  );
  for (const artifact of [...catalog.baseline_composes, ...catalog.ledger_controls, ...baseline])
    checkArtifact(artifact);
  for (const compose of catalog.baseline_composes) {
    const semantic = compose.source_path === "compose.mariadb-semantic-qa.yaml";
    const expected = baseline.map((step) => ({
      source_path: step.source_path,
      destination: `${semantic && manualSemanticIds.has(step.id) ? "/opt/classhub/semantic/" : "/docker-entrypoint-initdb.d/"}${step.mount_file}`,
    }));
    assert.deepEqual(
      collectSqlMounts(read(compose.source_path).toString("utf8")),
      expected,
      "ordered SQL mount inventory changed",
    );
  }
  const available = catalog.followups.map((group) => group.id);
  for (const selected of followups)
    assert.ok(available.includes(selected), "unknown follow-up selection");
  const selectedGroups = catalog.followups.filter((group) => followups.includes(group.id));
  const steps = [...baseline, ...selectedGroups.flatMap((group) => group.steps)];
  const seen = new Set(),
    paths = new Set(),
    versions = new Set(),
    hashes = new Set();
  for (const [index, step] of steps.entries()) {
    assert.match(step.id, /^[a-z][a-z0-9-]+$/u);
    assert.ok(
      !seen.has(step.id) && !paths.has(step.source_path),
      "duplicate installation artifact",
    );
    assert.ok(kinds.has(step.kind), "unreviewed installation artifact kind");
    checkArtifact(step);
    assert.ok(
      !hashes.has(step.sha256),
      "duplicate source checksum conflicts with the ledger UNIQUE constraint",
    );
    for (const dependency of step.requires ?? (step.after === null ? [] : [step.after]))
      assert.ok(
        seen.has(dependency),
        `installation dependency is absent or out of order: ${step.id}`,
      );
    if (step.ledger_version === null)
      assert.ok(
        index === 0 && step.kind === "provisioning",
        "only initial identity provisioning is outside the ledger",
      );
    else {
      assert.ok(Number.isSafeInteger(step.ledger_version) && step.ledger_version > 0);
      assert.ok(!versions.has(step.ledger_version), "duplicate ledger version");
      versions.add(step.ledger_version);
    }
    seen.add(step.id);
    paths.add(step.source_path);
    hashes.add(step.sha256);
  }
  const phaseOne = steps.find((step) => step.ledger_version === 1);
  assert.equal(phaseOne.source_path, "db/mariadb/migrations/0001_identity_foundation.sql");
  assert.equal(phaseOne.sha256, phaseOneSha256);
  assert.equal(phaseOne.byte_length, 8231);
  assert.ok(
    read(catalog.ledger_controls[1].source_path)
      .toString("utf8")
      .includes(`UNHEX('${phaseOneSha256}')`),
  );
  const productTables = baseline
    .flatMap((step) =>
      [
        ...read(step.source_path)
          .toString("utf8")
          .matchAll(/^CREATE TABLE ([a-z_]+)\s*\(/gmu),
      ].map((match) => match[1]),
    )
    .sort();
  assert.equal(productTables.length, 65);
  assert.equal(new Set(productTables).size, 65);
  const operationalTables = [
    "classhub_schema_migrations",
    ...steps.filter((step) => step.operational_table).map((step) => step.operational_table),
  ];
  const plan = {
    schema_version: 1,
    status: "mariadb_legacy_install_evidence",
    legacyEvidenceOnly: true,
    candidateOnly: true,
    runtimeActivationApplied: false,
    executionEnabled: false,
    selected_followups: selectedGroups.map((group) => group.id),
    artifact_catalog_sha256: catalogSha256,
    baseline_composes: catalog.baseline_composes,
    ledger: {
      table: "classhub_schema_migrations",
      bootstrap: catalog.ledger_controls[0],
      bootstrap_after: baseline[0].id,
      bootstrap_before: phaseOne.id,
      phase_one_record: catalog.ledger_controls[1],
      source_checksum_scope: "one_exact_source_file_bytes",
      aggregate_checksum_storage: "plan_sha256_only_not_source_sha256",
      planned_record_count: versions.size,
    },
    product_tables: productTables,
    operational_tables: operationalTables,
    expected_base_table_count: productTables.length + operationalTables.length,
    baseline_artifact_count: baseline.length,
    selected_artifact_count: steps.length,
    steps,
    execution_requirements: {
      isolated_fresh_target_only: true,
      exclusive_installer: true,
      durable_started_journal: true,
      automatic_resume: false,
      verify_before_ledger_insert: true,
      expected_ledger_insert_rows: 1,
      uncertain_ledger_result_requires_stop: true,
      verify_definer_lock_and_exact_acl: true,
      verify_routine_parameters_mode_charset_and_trigger_order: true,
      final_runtime_acl_activation_included: false,
      journal_and_executor_implemented: false,
    },
  };
  return { ...plan, plan_sha256: planChecksum(plan) };
}

/** Legacy verification cannot select or authorize this inventory for a new installation. */
export function verifyMariaDbLegacyEvidencePlan(plan, options = {}) {
  assert.ok(plan !== null && typeof plan === "object", "installation plan is missing");
  const expected = buildMariaDbLegacyEvidencePlan({
    followups: plan.selected_followups,
    ...options,
  });
  assert.deepEqual(plan, expected, "installation plan differs from the reviewed source contract");
  return {
    status: "legacy_install_evidence_pass",
    plan_sha256: expected.plan_sha256,
    candidateOnly: true,
    runtimeActivationApplied: false,
  };
}

/** New installations and migration inventories use only the approved 54-table scope. */
export function buildMariaDbInstallPlan({ followups = [], readRepoFile = defaultRead } = {}) {
  assert.ok(Array.isArray(followups), "followups must be an explicit array");
  assert.equal(new Set(followups).size, followups.length, "duplicate follow-up selection");
  const captured = new Map();
  const read = (path) => {
    if (!captured.has(path)) captured.set(path, Buffer.from(readRepoFile(path)));
    return captured.get(path);
  };
  const scope = readMariaDbActiveScope({ readRepoFile: read });
  const historical = buildMariaDbLegacyEvidencePlan({
    followups: followups.filter((id) => !currentApplicationFollowupIds.includes(id)),
    readRepoFile: read,
  });
  const current = readCurrentApplicationFollowups(followups, read);
  const retained = historical.steps.filter(
    (step) => !scope.retired_artifact_paths.includes(step.source_path),
  );
  const steps = retained.map((step, index) => {
    const after = scope.after_overrides[step.id] ?? step.after ?? retained[index - 1]?.id ?? null;
    return {
      ...step,
      after,
      // An ordering predecessor is not evidence of a semantic prerequisite.
      requires: [...(step.requires ?? scope.requires_overrides[step.id] ?? [])],
    };
  });
  const versions = new Set(steps.map((step) => step.ledger_version));
  for (const step of current.steps) {
    assert.ok(!versions.has(step.ledger_version), "duplicate current application ledger version");
    assert.ok(
      !steps.some(
        (previous) =>
          previous.id === step.id ||
          previous.source_path === step.source_path ||
          previous.sha256 === step.sha256,
      ),
      "duplicate current application artifact",
    );
    steps.push({ ...step, after: steps.at(-1).id });
    versions.add(step.ledger_version);
  }
  const baseline = steps.slice(0, scope.baseline_artifact_count);
  const productTables = baseline
    .flatMap((step) =>
      [
        ...read(step.source_path)
          .toString("utf8")
          .matchAll(/^CREATE TABLE ([a-z_]+)\s*\(/gmu),
      ].map((match) => match[1]),
    )
    .sort();
  const { plan_sha256: legacyDigest, legacyEvidenceOnly, ...legacyFields } = historical;
  assert.equal(legacyEvidenceOnly, true);
  const plan = {
    ...legacyFields,
    selected_followups: [...historical.selected_followups, ...current.ids],
    ...(current.catalogSha256
      ? { current_application_artifact_catalog_sha256: current.catalogSha256 }
      : {}),
    status: "mariadb_install_plan_candidate",
    scope_id: scope.id,
    scope_sha256: activeMariaDbScopeSha256,
    // The preserved compose files still contain retired artifacts and cannot execute this plan.
    baseline_composes: [],
    legacy_evidence: {
      status: "legacy_evidence_only",
      plan_sha256: legacyDigest,
      source_hashes: scope.legacy_evidence,
      baseline_composes: historical.baseline_composes,
      product_table_count: 65,
      baseline_artifact_count: 55,
    },
    product_tables: productTables,
    migration_tables: [...scope.product_tables],
    retired_tables: scope.retired_tables,
    retired_artifact_paths: scope.retired_artifact_paths,
    pending_operational_artifacts: scope.pending_operational_artifacts,
    baseline_artifact_count: baseline.length,
    selected_artifact_count: steps.length,
    expected_base_table_count: productTables.length + historical.operational_tables.length,
    ledger: {
      ...historical.ledger,
      planned_record_count: steps.filter((step) => step.ledger_version !== null).length,
      version_policy: "retained_explicit_versions_with_retired_gaps_no_renumbering",
      retired_unapplied_versions: [29, 30, 31, 32, 33, 34, 35, 40, 41],
    },
    steps,
    executionEnabled: false,
    runtimeActivationApplied: false,
    dependency_semantics: scope.dependency_semantics,
    execution_blockers: scope.execution_blockers,
    execution_requirements: {
      ...historical.execution_requirements,
      active_scope_compose_prepared: true,
      active_scope_runtime_acl_prepared: true,
      active_scope_installation_and_restore_verified: false,
      existing_databases_are_not_modified: true,
    },
  };
  assertMariaDbActiveSelection(plan, scope);
  return { ...plan, plan_sha256: planChecksum(plan) };
}

/** Retired artifacts, missing tables and recomputed checksums cannot alter the active contract. */
export function verifyMariaDbInstallPlan(plan, options = {}) {
  assert.ok(plan !== null && typeof plan === "object", "installation plan is missing");
  const expected = buildMariaDbInstallPlan({ followups: plan.selected_followups, ...options });
  assert.deepEqual(
    plan,
    expected,
    "installation plan differs from the reviewed active source contract",
  );
  return {
    status: "install_plan_candidate_pass",
    plan_sha256: expected.plan_sha256,
    scope_id: expected.scope_id,
    candidateOnly: true,
    runtimeActivationApplied: false,
    executionEnabled: false,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"),
    "only --check is supported; this module cannot execute SQL",
  );
  const plan = buildMariaDbInstallPlan();
  process.stdout.write(
    JSON.stringify({
      ...verifyMariaDbInstallPlan(plan),
      baselineArtifacts: plan.baseline_artifact_count,
      productTables: plan.product_tables.length,
      ledgerRowsIfApplied: plan.ledger.planned_record_count,
    }) + "\n",
  );
}
