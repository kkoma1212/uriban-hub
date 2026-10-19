import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { activeMariaDbScopeSha256, readMariaDbActiveScope } from "../scope/active-scope.mjs";
import { inspectMariaDbSemanticSql } from "./active-semantic-sql.mjs";

export const activeSemanticDependencyPath = "db/mariadb/ledger/active-semantic-dependencies.json";
export const activeSemanticDependencySha256 =
  "d1d9d9bfaa09a85d0b309eb8b331990e6b5236dbe72dacf84c183dc2ab801c23";
const historicalPath = "db/mariadb/ledger/install-artifacts.json";
const currentPath = "db/mariadb/ledger/current-application-artifacts.json";
const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const referenceKey = (reference) =>
  `${
    ["definer", "grantee"].includes(reference.kind)
      ? "principal"
      : ["call", "grant_execute", "replace_procedure"].includes(reference.kind)
        ? "procedure"
        : reference.kind === "replace_trigger"
          ? "trigger"
          : "table"
  }:${reference.object}`;
function safeRead(reader, path) {
  assert.match(path, /^[a-zA-Z0-9_./-]+$/u);
  assert.ok(
    !path.startsWith("/") && !path.split("/").includes(".."),
    "Semantic source escapes repository",
  );
  return Buffer.from(reader(path));
}
function assertRetainedReferences(inspection, retired) {
  for (const definition of inspection.definitions)
    if (definition.kind === "table")
      assert.ok(!retired.includes(definition.object), "Retired table defined by semantic plan");
  for (const reference of inspection.references)
    if (referenceKey(reference).startsWith("table:"))
      assert.ok(!retired.includes(reference.object), "Retired table referenced by semantic plan");
}

/** Source-only attestation: no DB connection, SQL execution or mutation of legacy evidence. */
export function readActiveSemanticDependencies({ readRepoFile = defaultRead } = {}) {
  const captured = new Map();
  const read = (path) => {
    if (!captured.has(path)) captured.set(path, safeRead(readRepoFile, path));
    return captured.get(path);
  };
  const bytes = read(activeSemanticDependencyPath);
  assert.equal(
    digest(bytes),
    activeSemanticDependencySha256,
    "Reviewed semantic dependency overlay changed",
  );
  const document = JSON.parse(bytes.toString("utf8"));
  const scope = readMariaDbActiveScope({ readRepoFile: read });
  assert.equal(document.schema_version, 1);
  assert.equal(document.scope_id, scope.id);
  assert.equal(document.scope_sha256, activeMariaDbScopeSha256);
  assert.deepEqual(document.retired_tables, scope.retired_tables);
  assert.equal(document.assessment.runtime_activation_applied, false);
  assert.equal(document.reviewed_artifact_count, 53);
  assert.equal(
    digest(read(historicalPath)),
    document.historical_catalog_sha256,
    "Historical semantic mapping changed",
  );
  assert.equal(
    digest(read(currentPath)),
    document.current_application_catalog_sha256,
    "Current semantic mapping changed",
  );
  const historical = JSON.parse(read(historicalPath).toString("utf8"));
  const current = JSON.parse(read(currentPath).toString("utf8"));
  const expected = [
    ...historical.baseline.filter((step) => scope.baseline_artifact_ids.includes(step.id)),
    ...historical.followups.find((group) => group.id === "class_access_approval").steps,
    ...current.followups.flatMap((group) => group.steps),
  ];
  assert.equal(expected.length, 53);
  assert.deepEqual(
    document.artifacts.map((step) => step.id),
    expected.map((step) => step.id),
  );
  const providers = new Map(),
    seen = new Set();
  let referenceCount = 0,
    dependencyCount = 0;
  for (const [index, artifact] of document.artifacts.entries()) {
    const mapped = expected[index];
    for (const field of ["source_path", "sha256", "byte_length"])
      assert.equal(
        artifact[field],
        mapped[field],
        `Semantic mapping field changed: ${artifact.id}/${field}`,
      );
    const source = read(artifact.source_path);
    assert.equal(
      source.length,
      artifact.byte_length,
      `Semantic source length changed: ${artifact.id}`,
    );
    assert.equal(digest(source), artifact.sha256, `Semantic source bytes changed: ${artifact.id}`);
    const inspection = inspectMariaDbSemanticSql(source.toString("utf8"));
    assertRetainedReferences(inspection, scope.retired_tables);
    assert.deepEqual(
      inspection.definitions,
      artifact.definitions,
      `Semantic definitions changed: ${artifact.id}`,
    );
    assert.deepEqual(
      inspection.mutations,
      artifact.mutations,
      `Semantic mutations changed: ${artifact.id}`,
    );
    const local = new Set(
      inspection.definitions.map((definition) => `${definition.kind}:${definition.object}`),
    );
    const references = inspection.references.map((reference) => {
      const key = referenceKey(reference);
      const provider = reference.kind.startsWith("replace_")
        ? providers.get(key)
        : local.has(key)
          ? artifact.id
          : providers.get(key);
      assert.ok(provider, `Unresolved semantic object: ${artifact.id}/${key}`);
      return { ...reference, provider };
    });
    assert.deepEqual(
      references,
      artifact.references,
      `Semantic reference coverage changed: ${artifact.id}`,
    );
    const required = [
      ...new Set([
        ...references
          .filter((reference) => reference.provider !== artifact.id)
          .map((reference) => reference.provider),
        ...artifact.supplemental_dependencies.map((dependency) => dependency.id),
      ]),
    ].sort();
    assert.deepEqual(
      required,
      artifact.requires,
      `Semantic prerequisite coverage changed: ${artifact.id}`,
    );
    for (const required of artifact.requires)
      assert.ok(
        seen.has(required),
        `Semantic prerequisite is absent or forward: ${artifact.id}/${required}`,
      );
    for (const dependency of [
      ...artifact.supplemental_dependencies,
      ...artifact.activation_requires,
    ]) {
      assert.ok(typeof dependency.reason === "string" && dependency.reason.length > 20);
      assert.ok(document.artifacts.some((candidate) => candidate.id === dependency.id));
      assert.notEqual(dependency.id, artifact.id);
    }
    for (const definition of inspection.definitions)
      providers.set(`${definition.kind}:${definition.object}`, artifact.id);
    seen.add(artifact.id);
    referenceCount += references.length;
    dependencyCount += required.length;
  }
  assert.deepEqual(
    [...providers.keys()]
      .filter((key) => key.startsWith("table:"))
      .map((key) => key.slice(6))
      .sort(),
    scope.product_tables,
  );
  return {
    ...document,
    review_sha256: activeSemanticDependencySha256,
    checked_sources: [...captured.keys()],
    reference_count: referenceCount,
    dependency_count: dependencyCount,
    defined_object_count: providers.size,
  };
}

/** Apply before the parent recomputes its plan checksum. Returns copied steps and review;
 * never copies a stale plan_sha256, changes source/ledger versions or enables execution.
 * Unreviewed optional artifacts are inspected only for retired-object reintroduction and
 * remain explicitly incomplete. Later activation grants are checked without creating cycles.
 */
export function applyActiveSemanticDependencies(plan, { readRepoFile = defaultRead } = {}) {
  assert.ok(plan && typeof plan === "object" && Array.isArray(plan.steps));
  const document = readActiveSemanticDependencies({ readRepoFile });
  const scope = readMariaDbActiveScope({ readRepoFile });
  assert.equal(plan.scope_id, scope.id, "Semantic overlay requires the active plan");
  assert.deepEqual(
    plan.product_tables,
    scope.product_tables,
    "Semantic overlay requires all 54 active tables",
  );
  assert.deepEqual(
    plan.steps.slice(0, 46).map((step) => step.id),
    scope.baseline_artifact_ids,
    "Semantic overlay baseline inventory changed",
  );
  const entries = new Map(document.artifacts.map((artifact) => [artifact.id, artifact]));
  const selected = new Set(),
    selectedPaths = new Set(),
    unreviewed = [],
    activationMissing = [];
  const steps = plan.steps.map((step) => {
    assert.ok(
      !selected.has(step.id) && !selectedPaths.has(step.source_path),
      "Duplicate semantic plan artifact",
    );
    assert.ok(
      !scope.retired_artifact_paths.includes(step.source_path),
      "Retired artifact in semantic plan",
    );
    const review = entries.get(step.id);
    if (review === undefined) {
      const bytes = safeRead(readRepoFile, step.source_path);
      assert.equal(bytes.length, step.byte_length, "Unreviewed optional source length mismatch");
      assert.equal(digest(bytes), step.sha256, "Unreviewed optional source checksum mismatch");
      assertRetainedReferences(
        inspectMariaDbSemanticSql(bytes.toString("utf8")),
        scope.retired_tables,
      );
      unreviewed.push({
        id: step.id,
        source_path: step.source_path,
        status: "separate_semantic_review_required",
      });
    } else {
      for (const field of ["source_path", "sha256", "byte_length"])
        assert.equal(
          step[field],
          review[field],
          `Selected semantic source differs: ${step.id}/${field}`,
        );
      for (const dependency of review.requires)
        assert.ok(
          selected.has(dependency),
          `Selected semantic prerequisite missing or late: ${step.id}/${dependency}`,
        );
    }
    selected.add(step.id);
    selectedPaths.add(step.source_path);
    return { ...step, requires: [...(review?.requires ?? step.requires ?? [])] };
  });
  for (const step of steps)
    for (const dependency of entries.get(step.id)?.activation_requires ?? [])
      if (!selected.has(dependency.id))
        activationMissing.push({
          artifact: step.id,
          requires: dependency.id,
          reason: dependency.reason,
        });
  return {
    steps,
    review: {
      status:
        unreviewed.length === 0 && activationMissing.length === 0
          ? "selected_static_dependencies_complete"
          : "selected_static_dependencies_incomplete",
      review_sha256: document.review_sha256,
      reviewed_source_artifacts: 53,
      selected_reviewed_artifacts: steps.length - unreviewed.length,
      complete_direct_static_dependency_review: unreviewed.length === 0,
      selected_activation_artifacts_present: activationMissing.length === 0,
      activation_requires: document.artifacts
        .filter((artifact) => selected.has(artifact.id) && artifact.activation_requires.length > 0)
        .map((artifact) => ({ artifact: artifact.id, requires: artifact.activation_requires })),
      missing_activation_artifacts: activationMissing,
      unreviewed_selected_artifacts: unreviewed,
      external_preconditions: document.external_preconditions,
      separate_review: document.separate_review,
      execution_enabled: false,
      runtime_activation_applied: false,
      actual_database_verified: false,
    },
  };
}
