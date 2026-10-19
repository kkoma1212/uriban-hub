import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyLayoutTemplateEvidence(phase, readRepositoryFile) {
  assert.equal(
    phase.id,
    "0017_classroom_layout_templates",
    "layout template evidence received another phase",
  );
  for (const [field, expected] of Object.entries({
    apply_file_count: 1,
    installed_total_table_count: 51,
    new_table_count: 1,
    routine_count: 15,
    trigger_count: 12,
    constraint_catalog_entry_count: 7,
    targeted_rejection_probe_count: 40,
    targeted_acceptance_probe_count: 19,
    verification_run: "clean_apply",
    catalog_seed_row_count: 56,
    persistent_row_count: 56,
    persistent_nonseed_row_count: 0,
    owner_column_read_count: 0,
    owner_trigger_privilege_count: 0,
    name_index_prefix_characters: 40,
    name_identity_collation: "utf8mb4_nopad_bin",
    payload_shape_scope: "json_syntax_only_no_object_or_size_check",
    automatic_timestamp_update: false,
    application_authorization_scope: "not_verified_schema_only",
    clock_timestamp_parity: "activation_blocker",
    jsonb_type_parity: "activation_blocker",
    full_name_differential: "not_verified_targeted_samples_only",
  })) {
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  }
  assert.equal(phase.trigger_file, undefined, "layout template source has no trigger");
  assert.equal(phase.trigger_permissions_file, undefined, "layout template needs no definer grant");
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  const source = await readRepositoryFile(phase.mariadb_file, `${phase.id} source`);
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    phase.verification.migration_sha256,
    `${phase.id} mariadb_file digest drifted`,
  );
}
