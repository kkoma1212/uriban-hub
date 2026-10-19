import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyElectionEvidence(phase, readRepositoryFile) {
  assert.equal(phase.id, "0015_elections", "election evidence received another phase");
  for (const [field, expected] of Object.entries({
    apply_file_count: 3,
    installed_total_table_count: 49,
    new_table_count: 4,
    routine_count: 15,
    trigger_count: 12,
    constraint_catalog_entry_count: 21,
    targeted_rejection_probe_count: 57,
    targeted_acceptance_probe_count: 12,
    verification_run: "clean_apply",
    catalog_seed_row_count: 56,
    persistent_row_count: 56,
    persistent_nonseed_row_count: 0,
    owner_column_read_count: 1,
    owner_trigger_privilege_count: 1,
    folded_result_source: "1783700032000_election-results.sql",
    erasure_runtime_permissions: "not_implemented_source0036",
    privacy_scope: "separate_participation_and_aggregate_columns_not_admin_anonymity",
    application_authorization_scope: "not_verified_schema_only",
    clock_timestamp_parity: "activation_blocker",
    text_type_parity: "activation_blocker",
  })) {
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  }
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  for (const [field, artifact] of [
    ["migration_sha256", "mariadb_file"],
    ["trigger_sha256", "trigger_file"],
    ["trigger_permissions_sha256", "trigger_permissions_file"],
  ]) {
    const source = await readRepositoryFile(phase[artifact], `${phase.id} ${artifact}`);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      phase.verification[field],
      `${phase.id} ${artifact} digest drifted`,
    );
  }
}
