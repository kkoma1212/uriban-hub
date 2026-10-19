import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

export const activeMariaDbScopePath = "db/mariadb/scope/active-scope.json";
export const activeMariaDbScopeSha256 =
  "19207eb406c6f8622be050579f6694ba5cc5839dd05a3a93ad8222a65987ee09";
const root = new URL("../../../", import.meta.url);
const defaultRead = (path) => readFileSync(new URL(path, root));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Current migration target only. Historical 65-table manifests/catalogs are evidence inputs. */
export function readMariaDbActiveScope({ readRepoFile = defaultRead } = {}) {
  const bytes = Buffer.from(readRepoFile(activeMariaDbScopePath));
  assert.equal(digest(bytes), activeMariaDbScopeSha256, "reviewed active scope bytes changed");
  const scope = JSON.parse(bytes.toString("utf8"));
  assert.equal(scope.schema_version, 1);
  assert.equal(scope.product_table_count, 54);
  assert.equal(scope.baseline_artifact_count, 46);
  for (const [values, length] of [
    [scope.product_tables, 54],
    [scope.retired_tables, 11],
    [scope.baseline_artifact_ids, 46],
    [scope.retired_artifact_paths, 9],
  ]) {
    assert.equal(values.length, length);
    assert.equal(new Set(values).size, length);
  }
  assert.deepEqual(scope.product_tables, [...scope.product_tables].sort());
  assert.ok(scope.product_tables.every((table) => !scope.retired_tables.includes(table)));
  assert.equal(scope.executionEnabled, false);
  assert.equal(scope.runtimeActivationApplied, false);
  assert.equal(scope.dependency_semantics.complete_semantic_dependency_review, false);
  assert.ok(scope.execution_blockers.length > 0);
  for (const [path, expected] of Object.entries(scope.legacy_evidence))
    assert.equal(digest(readRepoFile(path)), expected, `legacy evidence bytes changed: ${path}`);
  for (const artifact of scope.pending_operational_artifacts) {
    const bytes = Buffer.from(readRepoFile(artifact.source_path));
    assert.equal(bytes.length, artifact.byte_length, "pending operational artifact length changed");
    assert.equal(digest(bytes), artifact.sha256, "pending operational artifact bytes changed");
    assert.equal(artifact.ledger_version, null);
    assert.equal(artifact.execution_included, false);
    assert.equal(artifact.runtime_grants_included, false);
  }
  return scope;
}

/** Explicit default inventory for new data migration; never flatten the historical manifest. */
export function mariaDbMigrationTables(options = {}) {
  return [...readMariaDbActiveScope(options).product_tables];
}

export function assertMariaDbActiveSelection(plan, scope = readMariaDbActiveScope()) {
  assert.deepEqual(
    plan.product_tables,
    scope.product_tables,
    "active product table inventory changed",
  );
  assert.deepEqual(
    plan.steps.slice(0, scope.baseline_artifact_count).map((step) => step.id),
    scope.baseline_artifact_ids,
    "active baseline artifact inventory changed",
  );
  const seen = new Set();
  for (const step of plan.steps) {
    assert.ok(
      !scope.retired_artifact_paths.includes(step.source_path),
      "retired artifact in active plan",
    );
    assert.ok(!seen.has(step.id), "duplicate active artifact");
    assert.equal(step.after, [...seen].at(-1) ?? null, "active execution order changed");
    assert.ok(Array.isArray(step.requires), "semantic requires must be explicit");
    for (const requirement of step.requires)
      assert.ok(seen.has(requirement), `missing active semantic prerequisite: ${step.id}`);
    seen.add(step.id);
  }
}
