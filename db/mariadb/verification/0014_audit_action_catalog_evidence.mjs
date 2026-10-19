import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyAuditCatalogEvidence(phase, readRepositoryFile) {
  assert.equal(phase.id, "0014_audit_action_catalog", "catalog evidence received another phase");
  for (const [field, expected] of Object.entries({
    apply_file_count: 1,
    installed_total_table_count: 45,
    new_table_count: 1,
    routine_count: 15,
    trigger_count: 11,
    constraint_catalog_entry_count: 1,
    new_foreign_key_count: 1,
    targeted_rejection_probe_count: 23,
    targeted_acceptance_probe_count: 10,
    verification_run: "post_apply_after_fixture_target_correction",
    catalog_seed_row_count: 51,
    persistent_row_count: 51,
    persistent_nonseed_row_count: 0,
    owner_column_read_count: 0,
    owner_trigger_privilege_count: 0,
    action_identity_collation: "ascii_nopad_bin",
    action_text_bound_parity: "activation_blocker",
    existing_rows_full_migration_replay: "not_verified_empty_baseline_only",
    application_authorization_scope: "not_verified_schema_only",
    clock_timestamp_parity: "activation_blocker",
  })) {
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  }
  assert.equal(phase.trigger_file, undefined, "catalog source adds no trigger");
  assert.equal(phase.trigger_permissions_file, undefined, "catalog needs no definer grants");
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source`);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    phase.verification.migration_sha256,
    `${phase.id} mariadb_file digest drifted`,
  );
}
