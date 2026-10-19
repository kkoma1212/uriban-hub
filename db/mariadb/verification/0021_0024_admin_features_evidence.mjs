import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const phaseCounts = {
  "0021_admin_signup_approvals": [2, 20, 1, 21, 77, 22],
  "0022_admin_inquiries_system_state": [2, 17, 0, 14, 31, 19],
  "0023_admin_terms_management": [1, 11, 1, 11, 64, 18],
  "0024_admin_account_management": [1, 11, 0, 9, 55, 21],
};
export async function verifyAdminFeatureEvidence(phase, readRepositoryFile) {
  assert.ok(Object.hasOwn(phaseCounts, phase.id));
  const [tables, columns, generated, constraints, rejected, accepted] = phaseCounts[phase.id];
  for (const [field, expected] of Object.entries({
    verification_group: "phase21_24_admin_features",
    apply_file_count: 6,
    installed_total_table_count: 65,
    new_table_count: tables,
    source_column_count: columns,
    generated_column_count: generated,
    group_new_table_count: 6,
    group_source_column_count: 59,
    group_generated_column_count: 2,
    constraint_catalog_entry_count: constraints,
    group_constraint_catalog_entry_count: 55,
    group_added_existing_constraint_count: 8,
    routine_count: 15,
    trigger_count: 12,
    targeted_rejection_probe_count: rejected,
    targeted_acceptance_probe_count: accepted,
    group_rejection_probe_count: 227,
    group_acceptance_probe_count: 80,
    group_postgresql_rejection_probe_count: 1,
    group_postgresql_acceptance_probe_count: 3,
    catalog_seed_row_count: 56,
    persistent_row_count: 56,
    persistent_nonseed_row_count: 0,
    owner_column_read_count: phase.id.startsWith("0024") ? 1 : 0,
    owner_trigger_privilege_count: 0,
    application_authorization_scope: "not_verified_schema_only",
    timestamp_parity: "activation_blocker",
    generated_always_identity_parity: "activation_blocker_explicit_ids_accepted",
    history_actor_update_parity: "activation_blocker_append_only_insert_trigger",
    inquiry_respondent_delete_mapping: "postgres_check_23514_to_mariadb_restrict_1451",
    full_unicode_differential: "not_verified_targeted_samples_only",
    runtime_activation_applied: false,
  }))
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  assert.ok(
    ["clean_apply_after_prewrite_guard_fix", "post_apply_after_qa_fix"].includes(
      phase.verification.verification_run,
    ),
  );
  const files = phase.verification.group_migration_sha256;
  const expectedFiles = Object.keys(phaseCounts)
    .map((id) => `db/mariadb/migrations/${id}.sql`)
    .concat([
      "db/mariadb/migrations/0024_admin_history_trigger.sql",
      "db/mariadb/permissions/0024_admin_history_trigger_grants.sql",
    ])
    .sort();
  assert.deepEqual(Object.keys(files).sort(), expectedFiles);
  assert.equal(phase.mariadb_file, `db/mariadb/migrations/${phase.id}.sql`);
  assert.equal(phase.verification.migration_sha256, files[phase.mariadb_file]);
  for (const [file, digest] of Object.entries(files)) {
    const source = await readRepositoryFile(file, `${phase.id} shared source`);
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      digest,
      `${phase.id} digest drifted: ${file}`,
    );
  }
  const isHistory = phase.id.startsWith("0024");
  assert.equal(
    phase.trigger_file,
    isHistory ? "db/mariadb/migrations/0024_admin_history_trigger.sql" : undefined,
  );
  assert.equal(
    phase.trigger_permissions_file,
    isHistory ? "db/mariadb/permissions/0024_admin_history_trigger_grants.sql" : undefined,
  );
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  await readRepositoryFile(
    phase.verification.postgresql_reference_file,
    `${phase.id} narrow PostgreSQL comparison`,
  );
}
