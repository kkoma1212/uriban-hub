import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildSemanticAclCandidate,
  renderSemanticAcl,
} from "../permissions/semantic_acl_candidate.mjs";
import { deriveSourceAcl, semanticSourceMigrations } from "./semantic_source_acl.mjs";

const base = "db/mariadb/";
const operations = "OPERATIONS/mariadb-dev/";
const candidateFile = `${base}permissions/semantic_acl_candidate.mjs`;
const candidateSqlFile = `${base}permissions/0028_runtime_acl_candidate.sql`;
const aclFile = `${base}permissions/semantic_source_acl.json`;
const runnerFile = `${operations}verify-semantic-qa.mjs`;
const rulesFile = `${operations}semantic-rule-scenarios.mjs`;
const aclTestFile = `${base}verification/semantic_acl_static.test.mjs`;
const rulesTestFile = `${base}verification/semantic_rules_static.test.mjs`;
export const semanticFollowupMigrationFiles = [
  `${base}migrations/0025_identity_school_followups.sql`,
  `${base}migrations/0026_checked_teacher_transfer.sql`,
  `${base}permissions/0026_checked_teacher_transfer_owner.sql`,
  `${base}migrations/0027_retention_system_actor.sql`,
];
export const semanticFollowupProvenanceFiles = [
  aclFile,
  candidateFile,
  candidateSqlFile,
  `${base}verification/semantic_source_acl.mjs`,
  runnerFile,
  `${operations}semantic-qa-context.mjs`,
  `${operations}semantic-acl-qa.mjs`,
  `${operations}phase25-identity-scenarios.mjs`,
  rulesFile,
  `${operations}phase21-24-fixture.mjs`,
  `${base}migrations/0002_class_invariant_boundary.sql`,
  `${base}permissions/0002_class_membership_definer_dml_grants.sql`,
  `${base}permissions/0002_class_membership_runtime_activation.sql`,
  `${base}verification/0002_class_transition_contract.json`,
];
export const semanticFollowupDocuments = [
  `${base}verification/semantic_followups_gaps.md`,
  `${operations}semantic-qa.md`,
];
export const semanticFollowupStaticTests = [
  aclTestFile,
  rulesTestFile,
  `${base}verification/semantic_followups_evidence.test.mjs`,
];
export const semanticFollowupCounts = {
  source_migrations: 47,
  followup_sources: 16,
  verified_sources: 12,
  implemented_unverified_sources: 4,
  apply_files: 4,
  product_tables: 65,
  routines: 16,
  triggers: 12,
  added_columns: 1,
  replaced_school_columns: 4,
  added_checks: 1,
  replaced_checks: 5,
  semantic_rejection_probes: 95,
  semantic_acceptance_probes: 70,
  acl_acceptance_probes: 16,
  acl_rejection_probes: 34,
  exact_acl_entries: 525,
  probe_identities: 4,
  tls_identities: 4,
  future_object_denied_roles: 4,
  database_wide_grants: 0,
  rendered_grant_statements: 109,
  catalog_seed_rows: 56,
  persistent_rows: 56,
  persistent_nonseed_rows: 0,
};
export const semanticFollowupGates = {
  runtime_activation_applied: false,
  existing_runtime_accounts_changed: false,
  full_postgresql_differential_gate_closed: false,
  full_concurrency_gate_closed: false,
  production_recovery_gate_closed: false,
  full_invariant_gate_closed: false,
  caller_authorization_and_rollback_gate_closed: false,
  administrator_membership_adapter_gate_closed: false,
};
export const semanticFollowupBlockers = {
  deferred_trigger_equivalence: "activation_blocker",
  caller_authorization_and_rollback: "activation_blocker",
  administrator_membership_adapter: "activation_blocker",
  operator_audit_timestamp_parity: "activation_blocker",
};
export const semanticFollowupFixedFields = {
  status: "semantic_schema_and_probe_acl_verified_runtime_activation_absent",
  scope: "synthetic_schema_and_probe_acl_only",
  verification_run: "clean_apply_with_probe_acl_reconcile",
  server_version: "11.4.13-MariaDB-ubu2404",
  image_index_digest:
    "mariadb@sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430",
  compose_file: "compose.mariadb-semantic-qa.yaml",
  migration_applied_this_run: true,
  existing_row_backfill:
    "verified_existing_user_default_and_existing_school_reminder_values_preserved",
  stale_grant_reconciliation_verified: true,
};
const commonAclArtifacts = [aclFile, candidateFile, candidateSqlFile, runnerFile, aclTestFile];
const invariantArtifacts = [
  `${base}migrations/0002_class_invariant_boundary.sql`,
  `${base}permissions/0002_class_membership_definer_dml_grants.sql`,
  `${base}permissions/0002_class_membership_runtime_activation.sql`,
];
const incomplete = new Set([10, 22, 24, 39]);
export const semanticFollowupEntries = [
  4, 5, 7, 10, 14, 22, 23, 24, 25, 26, 27, 34, 36, 39, 40, 46,
].map((index) => {
  let artifacts = [...commonAclArtifacts];
  if ([10, 22, 24].includes(index)) artifacts.push(...invariantArtifacts);
  if ([14, 23, 40].includes(index))
    artifacts.push(
      semanticFollowupMigrationFiles[0],
      `${operations}phase25-identity-scenarios.mjs`,
      rulesTestFile,
    );
  if (index === 27)
    artifacts = [semanticFollowupMigrationFiles[3], runnerFile, rulesFile, rulesTestFile];
  if (index === 39)
    artifacts.push(
      semanticFollowupMigrationFiles[1],
      semanticFollowupMigrationFiles[2],
      rulesFile,
      rulesTestFile,
    );
  return {
    source: semanticSourceMigrations[index].split("/").at(-1),
    status: incomplete.has(index) ? "implemented_unverified_on_container" : "verified_on_container",
    artifacts,
  };
});

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...values].sort();

export async function verifySemanticFollowupEvidence(manifest, readRepoFile) {
  const evidence = manifest.semantic_followups_verification;
  assert.ok(evidence && typeof evidence === "object", "missing semantic_followups_verification");
  assert.deepEqual(
    sorted(Object.keys(evidence)),
    sorted([
      ...Object.keys(semanticFollowupFixedFields),
      "verified_at",
      "source_migrations",
      "source_set_sha256",
      "migration_sha256",
      "provenance_sha256",
      "rendered_candidate_sha256",
      "rendered_probe_candidate_sha256",
      "counts",
      "gates",
      "blockers",
      "documents",
      "static_test_files",
    ]),
    "semantic followup evidence field inventory",
  );
  for (const [field, expected] of Object.entries(semanticFollowupFixedFields))
    assert.equal(evidence[field], expected, `semantic followups lost ${field}`);
  assert.match(
    evidence.verified_at ?? "",
    /^\d{4}-\d{2}-\d{2}$/u,
    "semantic followups verified_at",
  );
  assert.deepEqual(evidence.counts, semanticFollowupCounts, "semantic followup counts drifted");
  assert.deepEqual(
    evidence.gates,
    semanticFollowupGates,
    "semantic followup activation gates changed",
  );
  assert.deepEqual(
    evidence.blockers,
    semanticFollowupBlockers,
    "semantic followup blockers changed",
  );
  assert.equal(
    manifest.status,
    "development_only_incomplete",
    "full schema/runtime completion remains blocked",
  );
  assert.deepEqual(
    evidence.source_migrations,
    semanticFollowupEntries.map((entry) => entry.source),
  );
  assert.deepEqual(evidence.documents, semanticFollowupDocuments);
  assert.deepEqual(evidence.static_test_files, semanticFollowupStaticTests);

  const cache = new Map();
  const read = async (path) => {
    if (!cache.has(path)) {
      const content = await readRepoFile(path, `semantic followups ${path}`);
      assert.equal(typeof content, "string", `${path}: UTF-8 source required`);
      assert.ok(content.length > 0, `${path}: empty evidence artifact`);
      cache.set(path, content);
    }
    return cache.get(path);
  };
  const source = await deriveSourceAcl(read);
  assert.deepEqual(JSON.parse(await read(aclFile)), source, "source47 derived ACL drifted");
  assert.equal(evidence.source_set_sha256, source.sourceSetSha256, "source47 set digest drifted");
  assert.equal(source.sourceMigrations.length, 47);
  assert.equal(new Set(Object.values(source.roles).flatMap(Object.keys)).size, 65);
  assert.equal(manifest.source.migration_count, 47);
  assert.equal(manifest.source.product_table_count, 65);
  assert.equal(manifest.source.latest_migration, semanticSourceMigrations.at(-1).split("/").at(-1));

  for (const [field, paths] of [
    ["migration_sha256", semanticFollowupMigrationFiles],
    ["provenance_sha256", semanticFollowupProvenanceFiles],
  ]) {
    assert.ok(evidence[field] && typeof evidence[field] === "object", `missing ${field}`);
    assert.deepEqual(
      sorted(Object.keys(evidence[field])),
      sorted(paths),
      `${field} exact file inventory`,
    );
    for (const path of paths) {
      assert.match(evidence[field][path], /^[a-f0-9]{64}$/u, `${field} invalid digest: ${path}`);
      assert.equal(
        evidence[field][path],
        hash(await read(path)),
        `${field} digest drifted: ${path}`,
      );
    }
  }
  const candidate = buildSemanticAclCandidate(source);
  assert.equal(candidate.activationApplied, false);
  assert.equal(candidate.callerAuthorizationAndRollback, "activation_blocker");
  assert.equal(candidate.administratorMembershipAdapter, "activation_blocker");
  const candidateSql = (await read(candidateSqlFile))
    .replaceAll("\r\n", "\n")
    .replace(/^\s*--[^\n]*(?:\n|$)/gmu, "")
    .trim();
  assert.equal(
    candidateSql,
    renderSemanticAcl(candidate).trim(),
    "candidate SQL differs from its reviewed 109 GRANTs",
  );
  for (const [field, probe] of [
    ["rendered_candidate_sha256", false],
    ["rendered_probe_candidate_sha256", true],
  ]) {
    const rendered = renderSemanticAcl(candidate, probe);
    assert.equal(evidence[field], hash(rendered), `${field} digest drifted`);
    assert.equal(rendered.trimEnd().split("\n").length, 109, "exact rendered candidate statements");
  }
  let entryCount = Object.values(candidate.procedures).flat().length;
  for (const tables of Object.values(candidate.roles))
    for (const grants of Object.values(tables))
      for (const columns of Object.values(grants))
        entryCount += columns === "*" ? 1 : columns.length;
  assert.equal(entryCount, 525, "candidate exact table/column/routine privilege entries");

  assert.ok(Array.isArray(manifest.semantic_migrations));
  const sources = manifest.semantic_migrations.map((entry) => entry.source);
  assert.equal(new Set(sources).size, sources.length, "duplicate semantic source migration");
  const knownSources = new Set(semanticSourceMigrations.map((path) => path.split("/").at(-1)));
  assert.ok(
    sources.every((sourceName) => knownSources.has(sourceName)),
    "unknown semantic source migration",
  );
  for (const expected of semanticFollowupEntries) {
    const entry = manifest.semantic_migrations.find((item) => item.source === expected.source);
    assert.ok(entry, `missing semantic followup ${expected.source}`);
    assert.equal(entry.status, expected.status, `${expected.source} completion status changed`);
    assert.deepEqual(
      entry.artifacts,
      expected.artifacts,
      `${expected.source} artifact inventory changed`,
    );
    for (const path of entry.artifacts) await read(path);
  }
  const compose = await read(evidence.compose_file);
  assert.ok(
    compose.includes(
      semanticFollowupFixedFields.image_index_digest.replace("mariadb@", "mariadb:11.4.13@"),
    ),
  );
  assert.match(compose, /com\.classhub\.production-data-allowed: "false"/u);
  assert.match(compose, /com\.classhub\.runtime-activation: "false"/u);
  assert.match(compose, /internal: true/u);
  assert.doesNotMatch(compose, /^\s*ports:/mu);
  for (const path of [...evidence.documents, ...evidence.static_test_files]) await read(path);
}
