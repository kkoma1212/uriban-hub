import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { format, resolveConfig } from "prettier";
import { buildSemanticAclCandidate, renderSemanticAcl } from "./semantic_acl_candidate.mjs";
import { deriveSourceAcl, semanticSourceMigrations } from "../verification/semantic_source_acl.mjs";
import { readMariaDbActiveScope } from "../scope/active-scope.mjs";
import {
  activeRuntimeAclPath,
  activeRuntimeCatalogRoles,
  adminSessionRenewalAclOverlay,
  assertAdminSessionRenewalAclSource,
  buildActiveRuntimeAcl,
  buildCurrentRuntimeAcl,
  currentRuntimeAclPath,
  currentApplicationAclSources,
  signupRoleSource,
  renderActiveRuntimeAcl,
} from "./active_runtime_acl.mjs";

assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--write"),
);
const sourcePath = "db/mariadb/permissions/semantic_source_acl.json";
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
assert.deepEqual(await deriveSourceAcl(async (path) => readFileSync(path, "utf8")), source);
assert.deepEqual(
  readdirSync("db/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `db/migrations/${name}`),
  [...semanticSourceMigrations, adminSessionRenewalAclOverlay.sourcePath, signupRoleSource],
  "current source inventory must be frozen source47 plus reviewed renewal and signup role follow-ups",
);
assertAdminSessionRenewalAclSource(readFileSync(adminSessionRenewalAclOverlay.sourcePath, "utf8"));
const candidate = buildSemanticAclCandidate(source);
const grants = (path) =>
  readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("GRANT "));
assert.deepEqual(
  grants("db/mariadb/permissions/0028_runtime_acl_candidate.sql"),
  renderSemanticAcl(candidate).trimEnd().split("\n"),
);
assert.deepEqual(grants("db/mariadb/permissions/0029_operator_audit_timestamp_candidate.sql"), [
  "GRANT INSERT (`created_at`) ON classhub_mariadb_phase1_dev.`audit_logs` TO 'classhub_operator'@'%';",
  "GRANT INSERT (`created_at`) ON classhub_mariadb_phase1_dev.`operator_audit_logs` TO 'classhub_operator'@'%';",
]);
const scope = readMariaDbActiveScope();
const baselineCandidate = buildActiveRuntimeAcl(source, scope);
assert.equal(
  readFileSync(activeRuntimeAclPath, "utf8"),
  renderActiveRuntimeAcl(baselineCandidate),
  "historical active baseline ACL drift",
);
const activeCandidate = buildCurrentRuntimeAcl(source, scope);
const roles = activeRuntimeCatalogRoles(activeCandidate);
const activeSql = renderActiveRuntimeAcl(activeCandidate);
if (process.argv[2] === "--write") writeFileSync(currentRuntimeAclPath, activeSql);
else
  assert.equal(readFileSync(currentRuntimeAclPath, "utf8"), activeSql, "current runtime SQL drift");
const paths = [
  sourcePath,
  adminSessionRenewalAclOverlay.sourcePath,
  signupRoleSource,
  ...currentApplicationAclSources,
  "db/mariadb/ledger/current-application-artifacts.json",
  "db/mariadb/ledger/current-application-followups.mjs",
  "db/mariadb/permissions/semantic_acl_candidate.mjs",
  "db/mariadb/permissions/0028_runtime_acl_candidate.sql",
  "db/mariadb/permissions/0029_operator_audit_timestamp_candidate.sql",
  "db/mariadb/scope/active-scope.json",
  "db/mariadb/scope/active-scope.mjs",
  "db/mariadb/permissions/active_runtime_acl.mjs",
  "db/mariadb/permissions/generate_runtime_grant_catalog.mjs",
  activeRuntimeAclPath,
  currentRuntimeAclPath,
  "db/mariadb/permissions/0034_worker_audit_lock_acl.sql",
  "db/mariadb/permissions/0035_retention_lock_acl.sql",
];
const catalog = {
  revision: "active54-source49-signup0037-adminstatus0038-memberstatus0040",
  sourceOverlays: activeCandidate.sourceOverlays,
  productScope: scope.id,
  productTableCount: scope.product_table_count,
  activationApproved: false,
  serverVersion: "11.4.13-MariaDB-ubu2404",
  sourceHashes: Object.fromEntries(
    paths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  ),
  roles,
};
const output = "packages/db/src/mariadb/runtime-grant-catalog.json";
if (process.argv[2] === "--write")
  writeFileSync(
    output,
    await format(JSON.stringify(catalog), {
      ...(await resolveConfig(output)),
      filepath: output,
    }),
  );
else
  assert.deepEqual(
    JSON.parse(readFileSync(output, "utf8")),
    catalog,
    "runtime grant catalog drift",
  );
process.stdout.write(
  JSON.stringify({
    status: "runtime_grant_catalog_pass",
    productScope: scope.id,
    productTableCount: scope.product_table_count,
    roles: Object.fromEntries(
      Object.entries(roles).map(([role, entries]) => [role, entries.length]),
    ),
    activationApproved: false,
  }) + "\n",
);
