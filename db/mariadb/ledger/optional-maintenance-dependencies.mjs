import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import {
  activeSemanticDependencySha256,
  applyActiveSemanticDependencies,
  readActiveSemanticDependencies,
} from "./active-semantic-dependencies.mjs";
import { inspectMariaDbSemanticSql } from "./active-semantic-sql.mjs";
import {
  inspectOptionalLockSchema,
  inspectOptionalRuntimeAcl,
} from "./optional-maintenance-sql.mjs";

export const optionalMaintenanceArtifactPath =
  "db/mariadb/ledger/optional-maintenance-artifacts.json";
export const optionalMaintenanceArtifactSha256 =
  "487388d1c4a6995f4757d4c85527e4e3341a0e17d8b2eab1a1fdd506f7657d15";
export const optionalMaintenanceProfileIds = Object.freeze([
  "worker_security_audit_v1",
  "retention_v1",
]);
const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const referenceKey = (ref) =>
  `${["definer", "grantee"].includes(ref.kind) ? "principal" : ref.kind === "grant_execute" ? "procedure" : "table"}:${ref.object}`;

function cachedReader(reader) {
  const captured = new Map();
  const read = (path) => {
    assert.match(path, /^[a-zA-Z0-9_./-]+$/u);
    assert.ok(
      !path.startsWith("/") && !path.split("/").includes(".."),
      "Optional source escapes repository",
    );
    if (!captured.has(path)) {
      const input = reader(path);
      assert.ok(typeof input === "string" || input instanceof Uint8Array);
      captured.set(path, Buffer.from(input));
    }
    return captured.get(path);
  };
  return { read, captured };
}

/** Immutable source review only: no connection, SQL execution, account reset or ledger writes. */
export function readOptionalMaintenanceArtifacts({ readRepoFile = defaultRead } = {}) {
  const { read, captured } = cachedReader(readRepoFile);
  const bytes = read(optionalMaintenanceArtifactPath);
  assert.equal(
    digest(bytes),
    optionalMaintenanceArtifactSha256,
    "Optional maintenance mapping changed",
  );
  const document = JSON.parse(bytes.toString("utf8"));
  const base = readActiveSemanticDependencies({ readRepoFile: read });
  assert.equal(document.schema_version, 1);
  assert.equal(document.scope_id, base.scope_id);
  assert.equal(document.scope_sha256, base.scope_sha256);
  assert.equal(document.semantic_review_sha256, activeSemanticDependencySha256);
  for (const field of [
    "execution_enabled",
    "runtime_activation_applied",
    "actual_database_verified",
  ])
    assert.equal(document[field], false);
  const historical = JSON.parse(read("db/mariadb/ledger/install-artifacts.json").toString("utf8"));
  const current = JSON.parse(
    read("db/mariadb/ledger/current-application-artifacts.json").toString("utf8"),
  );
  const known = [
    ...historical.baseline,
    ...historical.followups.flatMap((group) => group.steps),
    ...current.followups.flatMap((group) => group.steps),
  ];
  const baseMapping = base.artifacts.map((artifact) => {
    const mapped = known.find((step) => step.id === artifact.id);
    assert.ok(mapped, "Optional base artifact is unmapped");
    return clone(mapped);
  });
  assert.equal(Math.max(...known.map((step) => step.ledger_version ?? 0)), 63);
  assert.deepEqual(
    document.artifacts.map((step) => step.ledger_version),
    [64, 65, 66, 67, 68],
  );
  assert.deepEqual(
    document.profiles.map((profile) => profile.id),
    optionalMaintenanceProfileIds,
  );
  const checkSource = (artifact) => {
    const source = read(artifact.source_path);
    assert.equal(
      source.length,
      artifact.byte_length,
      `Optional source length changed: ${artifact.source_path}`,
    );
    assert.equal(
      digest(source),
      artifact.sha256,
      `Optional source checksum changed: ${artifact.source_path}`,
    );
    return source.toString("utf8");
  };
  for (const source of document.support_sources) checkSource(source);
  const providers = new Map();
  for (const artifact of base.artifacts)
    for (const definition of artifact.definitions)
      providers.set(`${definition.kind}:${definition.object}`, artifact.id);
  const seen = new Set(baseMapping.map((step) => step.id));
  const sourcePaths = new Set(baseMapping.map((step) => step.source_path));
  for (const artifact of document.artifacts) {
    assert.ok(
      !seen.has(artifact.id) && !sourcePaths.has(artifact.source_path),
      "Duplicate optional artifact",
    );
    assert.ok(seen.has(artifact.after), "Optional ordering predecessor missing");
    const source = checkSource(artifact),
      inspection = inspectMariaDbSemanticSql(source);
    const local = new Set(
      inspection.definitions.map((definition) => `${definition.kind}:${definition.object}`),
    );
    for (const definition of inspection.definitions)
      assert.ok(
        !base.retired_tables.includes(definition.object),
        "Retired table defined by optional source",
      );
    const references = inspection.references.map((reference) => {
      assert.ok(
        !base.retired_tables.includes(reference.object),
        "Retired object referenced by optional source",
      );
      const provider = local.has(referenceKey(reference))
        ? artifact.id
        : providers.get(referenceKey(reference));
      assert.ok(provider, "Unresolved optional SQL object");
      return { ...reference, provider };
    });
    assert.deepEqual(inspection.definitions, artifact.definitions);
    assert.deepEqual(inspection.mutations, artifact.mutations);
    assert.deepEqual(references, artifact.references, "Optional direct SQL reference changed");
    const required = [
      ...new Set([
        ...references.filter((ref) => ref.provider !== artifact.id).map((ref) => ref.provider),
        ...artifact.supplemental_dependencies.map((dependency) => dependency.id),
      ]),
    ].sort();
    assert.deepEqual(required, artifact.requires, "Optional prerequisite coverage changed");
    for (const dependency of required)
      assert.ok(seen.has(dependency), "Optional prerequisite missing or late");
    if (artifact.kind === "operational_schema") {
      assert.deepEqual(
        inspectOptionalLockSchema(source, artifact.operational_table),
        artifact.lock_contract,
      );
    } else {
      assert.equal(artifact.kind, "runtime_grant");
      assert.deepEqual(
        inspectOptionalRuntimeAcl(source),
        artifact.grant_entries,
        "Optional exact grant envelope changed",
      );
    }
    for (const definition of inspection.definitions)
      providers.set(`${definition.kind}:${definition.object}`, artifact.id);
    seen.add(artifact.id);
    sourcePaths.add(artifact.source_path);
  }
  const catalog = JSON.parse(
    read("packages/db/src/mariadb/runtime-grant-catalog.json").toString("utf8"),
  );
  assert.equal(catalog.productScope, document.scope_id);
  assert.equal(catalog.productTableCount, 54);
  assert.equal(catalog.activationApproved, false);
  assert.deepEqual(
    document.artifacts[0].grant_entries,
    catalog.roles,
    "Current SQL and driver baseline disagree",
  );
  for (const [role, contract] of Object.entries(document.runtime_roles))
    assert.equal(catalog.roles[role].length, contract.baseline_entries);
  for (const profile of document.profiles) {
    const grant = document.artifacts.find((artifact) => artifact.id === profile.artifact_ids[1]);
    assert.deepEqual(grant.grant_entries[profile.role], profile.delta_entries);
    for (const [role, entries] of Object.entries(grant.grant_entries))
      if (role !== profile.role)
        assert.deepEqual(entries, [], "Optional grant changes another runtime role");
    assert.equal(
      catalog.roles[profile.role].length + profile.delta_entries.length,
      profile.final_entries,
    );
    for (const target of profile.runtime_table_dependencies) {
      assert.ok(!base.retired_tables.includes(target.table));
      assert.equal(providers.get(`table:${target.table}`), target.provider);
    }
  }
  return {
    ...document,
    review_sha256: optionalMaintenanceArtifactSha256,
    base_artifact_mapping: baseMapping,
    base_review: base,
    checked_sources: [...captured.keys()],
  };
}

/** Compose before the parent calculates its aggregate checksum; never inherit a stale checksum.
 * profiles must be explicit driver profile IDs. The baseline-only choice remains distinct.
 */
export function buildOptionalMaintenanceSelection(
  plan,
  { profiles = [], readRepoFile = defaultRead } = {},
) {
  assert.ok(Array.isArray(profiles), "Optional profiles must be an explicit array");
  assert.equal(new Set(profiles).size, profiles.length, "Duplicate optional profile");
  for (const profile of profiles)
    assert.ok(optionalMaintenanceProfileIds.includes(profile), "Unknown optional profile");
  const { read } = cachedReader(readRepoFile);
  const document = readOptionalMaintenanceArtifacts({ readRepoFile: read });
  const reviewed = applyActiveSemanticDependencies(plan, { readRepoFile: read });
  assert.equal(
    reviewed.review.status,
    "selected_static_dependencies_complete",
    "Optional selection requires a complete reviewed base",
  );
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    document.base_artifact_mapping.map((step) => step.id),
    "Optional selection requires exactly the 53 reviewed base artifacts",
  );
  for (const [index, step] of plan.steps.entries()) {
    assert.equal(
      step.after,
      plan.steps[index - 1]?.id ?? null,
      "Optional base execution order changed",
    );
    for (const field of ["ledger_version", "kind", "source_path", "sha256", "byte_length"])
      assert.equal(
        step[field],
        document.base_artifact_mapping[index][field],
        `Optional base mapping changed: ${step.id}/${field}`,
      );
  }
  assert.deepEqual(
    plan.operational_tables,
    ["classhub_schema_migrations"],
    "Unreviewed operational table in optional base",
  );
  const selected = document.profiles.filter((profile) => profiles.includes(profile.id));
  const artifacts = document.artifacts.filter(
    (artifact) => artifact.profile === null || profiles.includes(artifact.profile),
  );
  const steps = clone(reviewed.steps),
    seen = new Set(steps.map((step) => step.id));
  for (const artifact of artifacts) {
    for (const dependency of artifact.requires)
      assert.ok(seen.has(dependency), "Selected optional prerequisite missing");
    const {
      id,
      ledger_version,
      kind,
      source_path,
      sha256,
      byte_length,
      requires,
      operational_table,
      lock_contract,
    } = artifact;
    steps.push({
      id,
      ledger_version,
      kind,
      source_path,
      sha256,
      byte_length,
      requires: [...requires],
      after: steps.at(-1).id,
      ...(operational_table
        ? {
            operational_table,
            required_committed_seed_rows: lock_contract.committed_seed_rows,
            runtime_grants_included: false,
          }
        : {}),
    });
    seen.add(id);
  }
  const finalGrants = clone(document.artifacts[0].grant_entries);
  const roleProfiles = Object.fromEntries(Object.keys(finalGrants).map((role) => [role, null]));
  for (const profile of selected) {
    finalGrants[profile.role] = [...finalGrants[profile.role], ...profile.delta_entries].sort();
    roleProfiles[profile.role] = profile.id;
  }
  const operationalTables = [
    "classhub_schema_migrations",
    ...artifacts
      .filter((artifact) => artifact.operational_table)
      .map((artifact) => artifact.operational_table),
  ];
  const activationOrder = [
    { id: "verify-base53-owner-contracts-and-quiescent-runtime", kind: "external_precondition" },
    {
      id: "reset-four-runtime-privileges-preserving-credentials",
      kind: "external_privileged_action",
    },
    ...artifacts.map((artifact) => ({
      id: artifact.id,
      kind: "source_artifact",
      source_path: artifact.source_path,
    })),
    {
      id: "verify-selected-profile-acl-and-committed-lock-contracts",
      kind: "external_postcondition",
    },
  ];
  return {
    status: "optional_maintenance_selection_candidate",
    scope_id: document.scope_id,
    review_sha256: document.review_sha256,
    selected_profiles: selected.map((profile) => profile.id),
    steps,
    selected_optional_artifacts: artifacts.map((artifact) => artifact.id),
    product_tables: [...plan.product_tables],
    operational_tables: operationalTables,
    expected_base_table_count: 54 + operationalTables.length,
    planned_record_count: steps.filter((step) => step.ledger_version !== null).length,
    final_runtime_grants: finalGrants,
    runtime_grant_profiles: roleProfiles,
    expected_runtime_grant_counts: Object.fromEntries(
      Object.entries(finalGrants).map(([role, entries]) => [role, entries.length]),
    ),
    acl_application_contract: clone(document.acl_application_contract),
    activation_order: activationOrder,
    lock_contracts: artifacts
      .filter((artifact) => artifact.lock_contract)
      .map((artifact) => clone(artifact.lock_contract)),
    review: {
      base_artifacts: 53,
      optional_artifacts: artifacts.length,
      direct_static_dependencies_reviewed: true,
      external_preconditions: [...document.external_preconditions],
      separate_review: clone(document.separate_review),
    },
    execution_enabled: false,
    runtime_activation_applied: false,
    actual_database_verified: false,
  };
}

/** Validate a proposed external action sequence, not an execution trace or permission grant. */
export function assertOptionalMaintenanceActivationOrder(
  selection,
  actionIds,
  { readRepoFile = defaultRead } = {},
) {
  assert.ok(selection && Array.isArray(selection.activation_order));
  assert.ok(Array.isArray(actionIds));
  const document = readOptionalMaintenanceArtifacts({ readRepoFile });
  assert.equal(selection.review_sha256, document.review_sha256);
  assert.ok(Array.isArray(selection.selected_profiles));
  const selected = document.profiles.filter((profile) =>
    selection.selected_profiles.includes(profile.id),
  );
  assert.deepEqual(
    selection.selected_profiles,
    selected.map((profile) => profile.id),
  );
  const artifacts = document.artifacts.filter(
    (artifact) =>
      artifact.profile === null || selection.selected_profiles.includes(artifact.profile),
  );
  const expectedActions = [
    { id: "verify-base53-owner-contracts-and-quiescent-runtime", kind: "external_precondition" },
    {
      id: "reset-four-runtime-privileges-preserving-credentials",
      kind: "external_privileged_action",
    },
    ...artifacts.map((artifact) => ({
      id: artifact.id,
      kind: "source_artifact",
      source_path: artifact.source_path,
    })),
    {
      id: "verify-selected-profile-acl-and-committed-lock-contracts",
      kind: "external_postcondition",
    },
  ];
  assert.deepEqual(
    selection.activation_order,
    expectedActions,
    "Optional activation contract was modified",
  );
  for (const field of [
    "execution_enabled",
    "runtime_activation_applied",
    "actual_database_verified",
  ])
    assert.equal(selection[field], false, "Optional source review cannot claim actual execution");
  assert.deepEqual(
    actionIds,
    expectedActions.map((action) => action.id),
    "Optional ACL reset/apply/seed/selected-profile order changed",
  );
  const grants = clone(document.artifacts[0].grant_entries);
  const profiles = Object.fromEntries(Object.keys(grants).map((role) => [role, null]));
  for (const profile of selected) {
    grants[profile.role] = [...grants[profile.role], ...profile.delta_entries].sort();
    profiles[profile.role] = profile.id;
  }
  assert.deepEqual(
    selection.final_runtime_grants,
    grants,
    "Selected runtime grants cannot fall back to baseline",
  );
  assert.deepEqual(
    selection.runtime_grant_profiles,
    profiles,
    "Selected driver profile must be retained",
  );
  assert.deepEqual(
    selection.expected_runtime_grant_counts,
    Object.fromEntries(Object.entries(grants).map(([role, entries]) => [role, entries.length])),
  );
  return true;
}
