import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function verifyAdminAuthEvidence(phase, readRepositoryFile) {
  assert.equal(phase.id, "0020_admin_auth");
  for (const [field, expected] of Object.entries({
    verification_run: "post_apply_after_catalog_order_fix",
    apply_file_count: 1,
    installed_total_table_count: 59,
    new_table_count: 6,
    source_column_count: 61,
    generated_column_count: 1,
    routine_count: 15,
    trigger_count: 12,
    constraint_catalog_entry_count: 51,
    targeted_rejection_probe_count: 189,
    targeted_acceptance_probe_count: 57,
    owner_column_read_count: 0,
    owner_trigger_privilege_count: 0,
    catalog_seed_row_count: 56,
    persistent_row_count: 56,
    persistent_nonseed_row_count: 0,
    application_authorization_scope: "not_verified_schema_only",
    timestamp_parity: "activation_blocker",
    generated_always_identity_parity: "activation_blocker_explicit_ids_accepted",
    email_identity_index_type: "HASH",
    text_collation: "utf8mb4_nopad_bin",
    mfa_partial_unique_mapping: "stored_nullable_current_admin_account_id",
    cryptography_scope: "length_and_state_only_no_encryption_or_totp_verification",
    full_unicode_differential: "not_verified_targeted_samples_only",
    system_job_actor_parity: "activation_blocker_pending_semantic_migrations",
  }))
    assert.equal(phase.verification[field], expected, `${phase.id} lost ${field}`);
  assert.equal(phase.trigger_file, undefined);
  assert.equal(phase.trigger_permissions_file, undefined);
  await readRepositoryFile(phase.verification.semantic_scenarios_file, `${phase.id} scenarios`);
  const sql = await readRepositoryFile(phase.mariadb_file, `${phase.id} source`);
  assert.equal(
    createHash("sha256").update(sql).digest("hex"),
    phase.verification.migration_sha256,
    `${phase.id} mariadb_file digest drifted`,
  );
}
